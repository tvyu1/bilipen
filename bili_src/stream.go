package main

import (
	"context"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

var (
	streamBytes    int64
	cacheHits      int64
	cacheFallbacks int64

	activeStreamMu sync.Mutex
	activeStreams  = map[int]context.CancelFunc{}
	streamSeq      int
)

func registerStream(cancel context.CancelFunc) int {
	activeStreamMu.Lock()
	defer activeStreamMu.Unlock()
	streamSeq++
	id := streamSeq
	activeStreams[id] = cancel
	return id
}

func unregisterStream(id int) {
	activeStreamMu.Lock()
	delete(activeStreams, id)
	activeStreamMu.Unlock()
}

func cancelAllStreams() {
	activeStreamMu.Lock()
	cancels := make([]context.CancelFunc, 0, len(activeStreams))
	for _, c := range activeStreams {
		cancels = append(cancels, c)
	}
	activeStreams = map[int]context.CancelFunc{}
	activeStreamMu.Unlock()
	for _, c := range cancels {
		c()
	}
	if len(cancels) > 0 {
		log.Printf("[BiliDaemon] cancelled %d active video streams", len(cancels))
	}
}

// cancelAllSpool 中止所有后台预取并清空注册表（/api/stop 调用）。
func cancelAllSpool() {
	spoolMu.Lock()
	list := make([]*spool, 0, len(spools))
	for _, s := range spools {
		list = append(list, s)
	}
	spools = map[string]*spool{}
	spoolMu.Unlock()
	for _, s := range list {
		if s.cancel != nil {
			s.cancel()
		}
	}
	if len(list) > 0 {
		log.Printf("[BiliDaemon] cancelled %d active spools", len(list))
	}
}

// execFFmpegCommand 拉起设备自带 ffmpeg。若系统有 chrt，则以 SCHED_FIFO 49 运行：
// 音频 remux / 切片是流式管道，CPU 占用很低，但需要及时喂数据；
// 实时优先级可避免它与视频解码线程（同核）平等竞争导致音频抖动。
// 注意：v2.4.5 引入过该优化，v2.4.7 拆分 main.go 时丢失，此处恢复。
func execFFmpegCommand(ctx context.Context, args []string) *exec.Cmd {
	var cmd *exec.Cmd
	if _, err := os.Stat(ChrtPath); err == nil {
		chrtArgs := append([]string{"-f", "49", FFmpegPath}, args...)
		cmd = exec.CommandContext(ctx, ChrtPath, chrtArgs...)
	} else {
		cmd = exec.CommandContext(ctx, FFmpegPath, args...)
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	return cmd
}

// Spooling Subsystem
type spool struct {
	bvid     string
	partPath string
	filePath string

	mu    sync.Mutex
	cond  *sync.Cond
	total int64
	have  int64
	done  bool
	err   error

	// ctx/cancel 用于 /api/stop 时中止后台预取，避免退出播放后仍在写 eMMC。
	ctx    context.Context
	cancel context.CancelFunc
}

var (
	spoolMu  sync.Mutex
	spools   = map[string]*spool{}
	dlPaceMu sync.Mutex
	dlNext   time.Time
	spoolSem = make(chan struct{}, 2)
)

func newSpool(bvid, partPath, filePath string) *spool {
	s := &spool{bvid: bvid, partPath: partPath, filePath: filePath}
	s.cond = sync.NewCond(&s.mu)
	return s
}

func ensureSpool(bvid string) (*spool, error) {
	if !validBVID(bvid) {
		return nil, fmt.Errorf("invalid bvid: %q", bvid)
	}
	spoolMu.Lock()
	if s, ok := spools[bvid]; ok {
		spoolMu.Unlock()
		return s, nil
	}
	spoolMu.Unlock()

	filePath := filepath.Join(CacheDir, bvid+".mp4")
	partPath := filePath + ".part"
	if fi, err := os.Stat(filePath); err == nil && fi.Size() > 0 {
		s := newSpool(bvid, partPath, filePath)
		s.total, s.have, s.done = fi.Size(), fi.Size(), true
		spoolMu.Lock()
		if old, ok := spools[bvid]; ok {
			spoolMu.Unlock()
			return old, nil
		}
		spools[bvid] = s
		spoolMu.Unlock()
		atomic.AddInt64(&cacheHits, 1)
		return s, nil
	}

	_ = os.MkdirAll(CacheDir, 0755)
	s := newSpool(bvid, partPath, filePath)
	spoolMu.Lock()
	if old, ok := spools[bvid]; ok {
		spoolMu.Unlock()
		return old, nil
	}
	spools[bvid] = s
	s.ctx, s.cancel = context.WithCancel(context.Background())
	spoolMu.Unlock()

	go downloadSpool(s)
	return s, nil
}

func downloadSpool(s *spool) {
	var cancelCh <-chan struct{}
	if s.ctx != nil {
		cancelCh = s.ctx.Done()
	}
	select {
	case spoolSem <- struct{}{}:
		defer func() { <-spoolSem }()
	case <-time.After(30 * time.Second):
		s.finish(fmt.Errorf("spool queue wait timeout"))
		return
	case <-cancelCh:
		s.finish(context.Canceled)
		return
	}

	if s.ctx != nil && s.ctx.Err() != nil {
		s.finish(context.Canceled)
		return
	}

	primary, backups, err := resolvePlayURL(s.bvid)
	if err != nil {
		s.finish(err)
		return
	}
	candidates := append([]string{primary}, backups...)
	var lastErr error
	for i, u := range candidates {
		if u == "" {
			continue
		}
		if i > 0 {
			log.Printf("[BiliDaemon] spool %s retry with backup #%d", s.bvid, i)
		}
		lastErr = s.downloadOne(u)
		if lastErr == nil {
			return
		}
		if s.ctx != nil && s.ctx.Err() != nil {
			break
		}
	}
	s.finish(lastErr)
}

func (s *spool) downloadOne(rawURL string) error {
	rctx := context.Background()
	if s.ctx != nil {
		rctx = s.ctx
	}
	req, err := http.NewRequestWithContext(rctx, "GET", rawURL, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", UserAgent)
	req.Header.Set("Referer", BiliReferer)
	if c := loadCookie(); c != "" {
		req.Header.Set("Cookie", c)
	}

	resp, err := streamClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusPartialContent {
		return fmt.Errorf("upstream status %d", resp.StatusCode)
	}

	s.mu.Lock()
	if resp.ContentLength > 0 {
		s.total = resp.ContentLength
	}
	s.have = 0
	s.mu.Unlock()
	s.cond.Broadcast()

	f, err := os.OpenFile(s.partPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0644)
	if err != nil {
		return err
	}
	defer f.Close()

	buf := make([]byte, 64*1024)
	for {
		if s.ctx != nil {
			if cerr := s.ctx.Err(); cerr != nil {
				return cerr
			}
		}
		n, rerr := resp.Body.Read(buf)
		if n > 0 {
			if _, werr := f.Write(buf[:n]); werr != nil {
				return werr
			}
			s.mu.Lock()
			s.have += int64(n)
			s.mu.Unlock()
			s.cond.Broadcast()
			paceDownload(n, s.bvid)
		}
		if rerr != nil {
			if rerr == io.EOF {
				break
			}
			return rerr
		}
	}

	_ = f.Sync()
	_ = f.Close()
	if err := os.Rename(s.partPath, s.filePath); err != nil {
		return err
	}
	s.finish(nil)
	log.Printf("[BiliDaemon] spool %s completed: %d bytes cached", s.bvid, s.have)
	return nil
}

func paceDownload(n int, bvid string) {
	if !playbackActive() {
		return
	}
	if bvid != "" && bvid == playbackActiveBvid() {
		return
	}
	rate := PrefetchPlayingRate
	if rate <= 0 {
		return
	}
	dlPaceMu.Lock()
	now := time.Now()
	if dlNext.Before(now) {
		dlNext = now
	}
	cost := time.Duration(int64(n) * int64(time.Second) / rate)
	dlNext = dlNext.Add(cost)
	target := dlNext
	dlPaceMu.Unlock()
	if sleepDur := target.Sub(now); sleepDur > time.Millisecond {
		if sleepDur > 500*time.Millisecond {
			sleepDur = 500 * time.Millisecond
		}
		time.Sleep(sleepDur)
	}
}

func (s *spool) finish(err error) {
	s.mu.Lock()
	s.done = true
	s.err = err
	if err != nil {
		_ = os.Remove(s.partPath)
	}
	s.mu.Unlock()
	s.cond.Broadcast()
	if err != nil {
		spoolMu.Lock()
		delete(spools, s.bvid)
		spoolMu.Unlock()
	}
}

func (s *spool) waitFor(n int64, d time.Duration) bool {
	deadline := time.Now().Add(d)
	s.mu.Lock()
	defer s.mu.Unlock()
	for s.have < n && !s.done && s.err == nil {
		rem := time.Until(deadline)
		if rem <= 0 {
			return false
		}
		ch := make(chan struct{})
		go func() {
			s.mu.Lock()
			s.cond.Wait()
			s.mu.Unlock()
			close(ch)
		}()
		s.mu.Unlock()
		select {
		case <-ch:
			s.mu.Lock()
		case <-time.After(rem):
			s.mu.Lock()
			return s.have >= n || s.done
		}
	}
	return s.have >= n || s.done
}

func (s *spool) pathForRead() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.done && s.err == nil {
		return s.filePath
	}
	return s.partPath
}

func parseRange(h string) (start, end int64, ok bool, err error) {
	if !strings.HasPrefix(h, "bytes=") {
		return 0, 0, false, nil
	}
	spec := strings.TrimPrefix(h, "bytes=")
	parts := strings.SplitN(spec, "-", 2)
	if len(parts) != 2 {
		return 0, 0, false, fmt.Errorf("bad range: %q", h)
	}
	if parts[0] == "" {
		sfx, e := strconv.ParseInt(parts[1], 10, 64)
		if e != nil || sfx <= 0 {
			return 0, 0, false, fmt.Errorf("bad suffix range: %q", h)
		}
		return -sfx, -1, true, nil
	}
	st, e := strconv.ParseInt(parts[0], 10, 64)
	if e != nil || st < 0 {
		return 0, 0, false, fmt.Errorf("bad start range: %q", h)
	}
	if parts[1] == "" {
		return st, -1, true, nil
	}
	ed, e := strconv.ParseInt(parts[1], 10, 64)
	if e != nil || ed < st {
		return 0, 0, false, fmt.Errorf("bad end range: %q", h)
	}
	return st, ed, true, nil
}

func serveSpool(w http.ResponseWriter, r *http.Request, s *spool) {
	_ = s.waitFor(PrefetchMinBytes, PrefetchWaitMax)
	rangeHdr := r.Header.Get("Range")
	if rangeHdr == "" {
		if _, err := os.Stat(s.filePath); err == nil && s.done {
			http.ServeFile(w, r, s.filePath)
			return
		}
		w.Header().Set("Content-Type", "video/mp4")
		w.Header().Set("Accept-Ranges", "bytes")
		s.mu.Lock()
		tot := s.total
		s.mu.Unlock()
		if tot > 0 {
			w.Header().Set("Content-Length", strconv.FormatInt(tot, 10))
		}
		w.WriteHeader(http.StatusOK)
		copySpoolStream(w, r.Context(), s, 0, tot)
		return
	}

	st, ed, isRng, err := parseRange(rangeHdr)
	if err != nil || !isRng {
		http.Error(w, "invalid range", http.StatusRequestedRangeNotSatisfiable)
		return
	}

	s.mu.Lock()
	tot := s.total
	done := s.done
	s.mu.Unlock()

	if tot <= 0 && !done {
		_ = s.waitFor(1<<20, 800*time.Millisecond)
		s.mu.Lock()
		tot = s.total
		s.mu.Unlock()
	}

	if st < 0 {
		if tot <= 0 {
			log.Printf("[BiliDaemon] spool %s suffix range but unknown total (fallback)", s.bvid)
			proxyUpstream(w, r, s.bvid, nil, "video/mp4", StreamIdleTimeout, &streamBytes)
			return
		}
		st = tot + st
		ed = tot - 1
	} else if ed < 0 {
		if tot > 0 {
			ed = tot - 1
		}
	}

	if ed >= 0 && tot > 0 && ed >= tot {
		ed = tot - 1
	}
	if st > 0 && tot > 0 && st >= tot {
		w.Header().Set("Content-Range", fmt.Sprintf("bytes */%d", tot))
		http.Error(w, "range not satisfiable", http.StatusRequestedRangeNotSatisfiable)
		return
	}

	neededEnd := ed
	if neededEnd < 0 {
		neededEnd = st + PrefetchMinBytes
	}
	if !s.waitFor(neededEnd+1, SpoolRangeWaitMax) {
		s.mu.Lock()
		have := s.have
		s.mu.Unlock()
		if have < st+1 {
			log.Printf("[BiliDaemon] spool %s wait range %d-%d timeout (have=%d, fallback direct)", s.bvid, st, ed, have)
			atomic.AddInt64(&cacheFallbacks, 1)
			proxyUpstream(w, r, s.bvid, nil, "video/mp4", StreamIdleTimeout, &streamBytes)
			return
		}
	}

	w.Header().Set("Content-Type", "video/mp4")
	w.Header().Set("Accept-Ranges", "bytes")
	if tot > 0 && ed >= 0 {
		w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", st, ed, tot))
		w.Header().Set("Content-Length", strconv.FormatInt(ed-st+1, 10))
	} else if tot > 0 {
		w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", st, tot-1, tot))
		w.Header().Set("Content-Length", strconv.FormatInt(tot-st, 10))
	}
	w.WriteHeader(http.StatusPartialContent)

	targetLen := int64(0)
	if ed >= st {
		targetLen = ed - st + 1
	} else if tot > st {
		targetLen = tot - st
	}
	copySpoolStream(w, r.Context(), s, st, targetLen)
}

func copySpoolStream(w io.Writer, ctx context.Context, s *spool, startOffset, length int64) {
	readPath := s.pathForRead()
	f, err := os.Open(readPath)
	if err != nil {
		return
	}
	defer f.Close()

	if startOffset > 0 {
		if _, err := f.Seek(startOffset, io.SeekStart); err != nil {
			return
		}
	}

	var curPos = startOffset
	var remaining = length
	buf := make([]byte, 64*1024)

	for {
		if ctx.Err() != nil {
			return
		}
		if length > 0 && remaining <= 0 {
			return
		}

		toRead := int64(len(buf))
		if length > 0 && remaining < toRead {
			toRead = remaining
		}

		s.mu.Lock()
		have := s.have
		done := s.done
		serr := s.err
		s.mu.Unlock()

		if curPos+toRead > have {
			if done {
				if curPos >= have {
					return
				}
				toRead = have - curPos
			} else if serr != nil {
				return
			} else {
				if !s.waitFor(curPos+toRead, 2*time.Second) {
					s.mu.Lock()
					have = s.have
					done = s.done
					s.mu.Unlock()
					if curPos >= have && done {
						return
					}
					if curPos >= have {
						return
					}
					toRead = have - curPos
				}
			}
		}

		n, rerr := f.Read(buf[:toRead])
		if n > 0 {
			if _, werr := w.Write(buf[:n]); werr != nil {
				return
			}
			curPos += int64(n)
			if length > 0 {
				remaining -= int64(n)
			}
			atomic.AddInt64(&streamBytes, int64(n))
		}
		if rerr != nil {
			if rerr == io.EOF {
				if s.done && curPos >= s.have {
					return
				}
				time.Sleep(20 * time.Millisecond)
				continue
			}
			return
		}
	}
}

func proxyUpstream(w http.ResponseWriter, r *http.Request, bvid string, candidates []string, forceCT string, idleTimeout time.Duration, counter *int64) {
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	sid := registerStream(cancel)
	defer unregisterStream(sid)

	if len(candidates) == 0 {
		primary, backups, err := resolvePlayURL(bvid)
		if err != nil {
			http.Error(w, err.Error(), 502)
			return
		}
		candidates = append([]string{primary}, backups...)
	}

	var resp *http.Response
	var openErr error
	for _, streamURL := range candidates {
		if streamURL == "" {
			continue
		}
		resp, openErr = openUpstream(ctx, streamURL, r)
		if openErr == nil {
			break
		}
	}
	if resp == nil {
		http.Error(w, "all candidates failed", 502)
		return
	}
	defer resp.Body.Close()

	for k, vv := range resp.Header {
		for _, v := range vv {
			w.Header().Add(k, v)
		}
	}
	if forceCT != "" {
		w.Header().Set("Content-Type", forceCT)
	}
	w.WriteHeader(resp.StatusCode)

	buf := make([]byte, 64*1024)
	for {
		n, err := resp.Body.Read(buf)
		if n > 0 {
			if _, werr := w.Write(buf[:n]); werr != nil {
				return
			}
			if counter != nil {
				atomic.AddInt64(counter, int64(n))
			}
		}
		if err != nil {
			return
		}
	}
}

func openUpstream(ctx context.Context, streamURL string, r *http.Request) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", streamURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", UserAgent)
	req.Header.Set("Referer", BiliReferer)
	if c := loadCookie(); c != "" {
		req.Header.Set("Cookie", c)
	}
	if rng := r.Header.Get("Range"); rng != "" {
		req.Header.Set("Range", rng)
	}
	return streamClient.Do(req)
}

func cleanCache() {
	entries, err := os.ReadDir(CacheDir)
	if err != nil {
		return
	}
	// 正在写的 spool 不能按 LRU 删：删掉后 goroutine 会写孤儿 inode，Rename 也会失败。
	active := map[string]bool{}
	spoolMu.Lock()
	for bvid, s := range spools {
		s.mu.Lock()
		if s.err == nil && !s.done {
			active[bvid] = true
		}
		s.mu.Unlock()
	}
	spoolMu.Unlock()
	playing := playbackActiveBvid()

	type item struct {
		bvid string
		path string
		size int64
		at   time.Time
	}
	var list []item
	var total int64
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := e.Name()
		fi, statErr := e.Info()
		if statErr != nil {
			continue
		}
		if strings.HasSuffix(name, ".part") {
			// 断点续传的临时文件/正在写：计入占用，但绝不主动删。
			total += fi.Size()
			continue
		}
		if !strings.HasSuffix(name, ".mp4") {
			continue
		}
		bvid := strings.TrimSuffix(name, ".mp4")
		if active[bvid] || bvid == playing {
			total += fi.Size()
			continue
		}
		list = append(list, item{bvid: bvid, path: filepath.Join(CacheDir, name), size: fi.Size(), at: fi.ModTime()})
		total += fi.Size()
	}
	sort.Slice(list, func(i, j int) bool { return list[i].at.Before(list[j].at) })
	for _, it := range list {
		if total <= CacheCapBytes {
			break
		}
		if err := os.Remove(it.path); err == nil {
			total -= it.size
			// 关键：spools 里残留条目会让后续 /api/stream 命中不存在的文件，返回空 200。
			spoolMu.Lock()
			delete(spools, it.bvid)
			spoolMu.Unlock()
		}
	}
	log.Printf("[BiliDaemon] cache maintenance: %d files / %d bytes kept", len(list), total)
}

func cleanCovers() {
	entries, err := os.ReadDir(CoverDir)
	if err != nil {
		return
	}
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		p := filepath.Join(CoverDir, e.Name())
		if fi, err := e.Info(); err == nil && time.Since(fi.ModTime()) > 7*24*time.Hour {
			_ = os.Remove(p)
		}
	}
}

// handleStream handles video requests with instant seek support.
func handleStream(w http.ResponseWriter, r *http.Request) {
	bvid := r.URL.Query().Get("bvid")
	if bvid == "" || !validBVID(bvid) {
		jsonError(w, "invalid or missing bvid", 400)
		return
	}

	ss := r.URL.Query().Get("ss")
	if ss != "" && ss != "0" {
		// Seeking request: stream from keyframe at ss seconds
		srcPath := ""
		offlinePath := filepath.Join(DownloadDir, bvid+".mp4")
		cachePath := filepath.Join(CacheDir, bvid+".mp4")
		if fileExists(offlinePath) {
			srcPath = offlinePath
		} else if fileExists(cachePath) {
			srcPath = cachePath
		} else {
			playURL, _, err := resolvePlayURL(bvid)
			if err == nil && playURL != "" {
				srcPath = playURL
			}
		}

		if srcPath != "" {
			handleSeekVideoStream(w, r, bvid, srcPath, ss)
			return
		}
	}

	offlinePath := filepath.Join(DownloadDir, bvid+".mp4")
	if fileExists(offlinePath) {
		http.ServeFile(w, r, offlinePath)
		return
	}
	s, err := ensureSpool(bvid)
	if err != nil {
		atomic.AddInt64(&cacheFallbacks, 1)
		log.Printf("[BiliDaemon] spool unavailable for %s: %v (fallback direct)", bvid, err)
		proxyUpstream(w, r, bvid, nil, "video/mp4", StreamIdleTimeout, &streamBytes)
		return
	}
	serveSpool(w, r, s)
}

// handleStreamStatus 只读地报告某个视频的缓冲进度，供前端显示加载百分比。
// 注意：绝不能调用 ensureSpool()，否则 UI 每 500ms 的轮询会意外拉起下载。
func handleStreamStatus(w http.ResponseWriter, r *http.Request) {
	bvid := r.URL.Query().Get("bvid")
	if bvid == "" || !validBVID(bvid) {
		jsonError(w, "invalid or missing bvid", 400)
		return
	}
	ss := r.URL.Query().Get("ss")
	resp := map[string]interface{}{
		"bvid": bvid, "source": "idle", "have": int64(0), "total": int64(0),
		"done": false, "percent": -1, "ss": ss,
	}

	// 与 handleStream 的优先级保持一致：离线 > 切片 > 缓存 > spool > 直连
	if fi, err := os.Stat(filepath.Join(DownloadDir, bvid+".mp4")); err == nil && fi.Size() > 0 {
		resp["source"], resp["have"], resp["total"], resp["done"], resp["percent"] = "offline", fi.Size(), fi.Size(), true, 100
		writeJSON(w, 200, resp)
		return
	}
	if ss != "" && ss != "0" {
		// ffmpeg -ss 切片走管道，没有 Content-Length，只能给不确定态。
		resp["source"], resp["percent"] = "slice", -1
		writeJSON(w, 200, resp)
		return
	}
	if fi, err := os.Stat(filepath.Join(CacheDir, bvid+".mp4")); err == nil && fi.Size() > 0 {
		resp["source"], resp["have"], resp["total"], resp["done"], resp["percent"] = "cache", fi.Size(), fi.Size(), true, 100
		writeJSON(w, 200, resp)
		return
	}

	spoolMu.Lock()
	s := spools[bvid]
	spoolMu.Unlock()
	if s == nil {
		if playbackActiveBvid() == bvid {
			resp["source"], resp["percent"] = "direct", -1
		}
		writeJSON(w, 200, resp)
		return
	}

	s.mu.Lock()
	have, total, done, serr := s.have, s.total, s.done, s.err
	s.mu.Unlock()
	resp["have"], resp["total"], resp["done"] = have, total, done
	switch {
	case serr != nil:
		resp["source"], resp["percent"] = "error", -1
	case done && total > 0:
		resp["source"], resp["percent"] = "cache", 100
	case total > 0:
		p := int(have * 100 / total)
		if p > 99 {
			p = 99 // 未 done 前不显示 100，避免「100% 还在转圈」
		}
		if p < 0 {
			p = 0
		}
		resp["source"], resp["percent"] = "spool", p
	default:
		resp["source"], resp["percent"] = "spool", -1
	}
	writeJSON(w, 200, resp)
}

// execFFmpegNoRT 与 execFFmpegCommand 相同但不加实时优先级：
// seek 切片是重 I/O（读整个文件头 + 拷贝到关键帧）的一次性任务，
// 在单核上给它 SCHED_FIFO 会抢占视频解码线程，得不偿失。
func execFFmpegNoRT(ctx context.Context, args []string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, FFmpegPath, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	return cmd
}

func handleSeekVideoStream(w http.ResponseWriter, r *http.Request, bvid, srcPath, ss string) {
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	sid := registerStream(cancel)
	defer unregisterStream(sid)

	var args []string
	if strings.HasPrefix(srcPath, "http://") || strings.HasPrefix(srcPath, "https://") {
		args = []string{
			"-y",
			"-headers", fmt.Sprintf("User-Agent: %s\r\nReferer: %s\r\n", UserAgent, BiliReferer),
			"-ss", ss,
			"-i", srcPath,
			"-c:v", "copy",
			"-an",
			"-movflags", "frag_keyframe+empty_moov+default_base_moof",
			"-f", "mp4",
			"pipe:1",
		}
	} else {
		args = []string{
			"-y",
			"-ss", ss,
			"-i", srcPath,
			"-c:v", "copy",
			"-an",
			"-movflags", "frag_keyframe+empty_moov+default_base_moof",
			"-f", "mp4",
			"pipe:1",
		}
	}

	cmd := execFFmpegNoRT(ctx, args)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	if err := cmd.Start(); err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	defer func() {
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
		_ = cmd.Wait()
	}()

	w.Header().Set("Content-Type", "video/mp4")
	w.Header().Set("Cache-Control", "no-cache")
	w.WriteHeader(http.StatusOK)
	_, _ = io.Copy(w, stdout)
}
