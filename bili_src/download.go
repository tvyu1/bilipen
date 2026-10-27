package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

const (
	DownloadDir      = "/userdisk/bili_downloads"
	DownloadCoverDir = "/userdisk/bili_downloads/covers"
	DownloadMetaFile = "/userdisk/bili_downloads/downloads.json"
)

type DownloadItem struct {
	BVID       string `json:"bvid"`
	Title      string `json:"title"`
	Owner      string `json:"owner"`
	Pic        string `json:"pic"`
	PicLocal   string `json:"pic_local"`
	Duration   int    `json:"duration"`
	TotalBytes int64  `json:"total_bytes"`
	DownBytes  int64  `json:"downloaded_bytes"`
	Progress   int    `json:"progress"` // 0-100
	Status     string `json:"status"`   // "pending", "downloading", "completed", "error"
	Error      string `json:"error,omitempty"`
	Created    int64  `json:"created"`
	FilePath   string `json:"file_path"`
}

var (
	dlMu      sync.Mutex
	dlItems   = make(map[string]*DownloadItem)
	dlList    []*DownloadItem
	dlCancels = make(map[string]context.CancelFunc)
	dlSem     = make(chan struct{}, 1) // 保持单任务下载，避免单核 A7 I/O 和 CPU 阻塞
	dlActive  int32
)

func downloadActive() bool {
	return atomic.LoadInt32(&dlActive) > 0
}

func loadDownloads() {
	_ = os.MkdirAll(DownloadDir, 0755)
	_ = os.MkdirAll(DownloadCoverDir, 0755)

	data, err := os.ReadFile(DownloadMetaFile)
	if err != nil {
		return
	}
	var items []*DownloadItem
	if err := json.Unmarshal(data, &items); err != nil {
		log.Printf("[Download] parse downloads.json error: %v", err)
		return
	}

	dlMu.Lock()
	defer dlMu.Unlock()
	dlItems = make(map[string]*DownloadItem)
	dlList = nil

	for _, it := range items {
		if it == nil || it.BVID == "" {
			continue
		}
		if it.FilePath == "" {
			it.FilePath = filepath.Join(DownloadDir, it.BVID+".mp4")
		}
		if it.PicLocal == "" || strings.HasPrefix(it.PicLocal, "/") {
			it.PicLocal = "covers/" + it.BVID + ".jpg"
		}
		targetCover := filepath.Join(CoverDir, it.BVID+".jpg")
		backupCover := filepath.Join(DownloadCoverDir, it.BVID+".jpg")
		if !fileExists(targetCover) && fileExists(backupCover) {
			_ = copyOrLinkFile(backupCover, targetCover)
		}
		if it.Status == "completed" {
			if fi, err := os.Stat(it.FilePath); err != nil || fi.Size() == 0 {
				it.Status = "error"
				it.Error = "文件不存在"
			} else {
				it.TotalBytes = fi.Size()
				it.DownBytes = fi.Size()
				it.Progress = 100
			}
		} else if it.Status == "downloading" {
			// daemon 重启/被杀后，保留 .part 供下次 Range 续传，进度不要回零。
			p := it.Progress
			if p <= 0 {
				for _, suffix := range []string{".v.part", ".a.part", ".part"} {
					if fi, statErr := os.Stat(filepath.Join(DownloadDir, it.BVID+".mp4"+suffix)); statErr == nil && fi.Size() > 0 {
						if it.TotalBytes > 0 {
							p = int(fi.Size() * 100 / it.TotalBytes)
							if p > 99 {
								p = 99
							}
						} else {
							p = 1
						}
						break
					}
				}
			}
			it.Status = "error"
			if p > 0 {
				it.Progress = p
				it.Error = fmt.Sprintf("下载中断（已下载 %d%%，点按续传）", p)
			} else {
				it.Error = "下载被中断"
			}
		}
		dlItems[it.BVID] = it
		dlList = append(dlList, it)
	}
	log.Printf("[Download] loaded %d items from downloads.json", len(dlList))
}

func saveDownloadsLocked() {
	data, err := json.MarshalIndent(dlList, "", "  ")
	if err != nil {
		return
	}
	tmp := DownloadMetaFile + ".tmp"
	if err := os.WriteFile(tmp, data, 0644); err == nil {
		_ = os.Rename(tmp, DownloadMetaFile)
	}
}

func fileExists(p string) bool {
	if fi, err := os.Stat(p); err == nil && fi.Size() > 0 {
		return true
	}
	return false
}

func cacheDownloadCover(bvid, picURL string) string {
	if picURL == "" {
		return ""
	}
	dst := filepath.Join(CoverDir, bvid+".jpg")
	if fileExists(dst) {
		return "covers/" + bvid + ".jpg"
	}
	_ = os.MkdirAll(CoverDir, 0755)
	_ = os.MkdirAll(DownloadCoverDir, 0755)
	req, err := http.NewRequest("GET", picURL, nil)
	if err != nil {
		return ""
	}
	req.Header.Set("User-Agent", UserAgent)
	resp, err := apiClient.Do(req)
	if err != nil {
		return ""
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return ""
	}
	tmp := dst + ".tmp"
	f, err := os.Create(tmp)
	if err != nil {
		return ""
	}
	_, copyErr := io.Copy(f, resp.Body)
	_ = f.Close()
	if copyErr == nil {
		_ = os.Rename(tmp, dst)
		_ = copyOrLinkFile(dst, filepath.Join(DownloadCoverDir, bvid+".jpg"))
		return "covers/" + bvid + ".jpg"
	}
	_ = os.Remove(tmp)
	return ""
}

func copyOrLinkFile(src, dst string) error {
	_ = os.Remove(dst)
	if err := os.Link(src, dst); err == nil {
		return nil
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0644)
	if err != nil {
		return err
	}
	defer out.Close()
	_, err = io.Copy(out, in)
	return err
}

func startDownloadTask(item *DownloadItem) {
	dlMu.Lock()
	ctx, cancel := context.WithCancel(context.Background())
	dlCancels[item.BVID] = cancel
	dlMu.Unlock()

	go func() {
		atomic.AddInt32(&dlActive, 1)
		defer atomic.AddInt32(&dlActive, -1)

		select {
		case dlSem <- struct{}{}:
			defer func() { <-dlSem }()
		case <-ctx.Done():
			return
		}

		if ctx.Err() != nil {
			return
		}

		targetPath := filepath.Join(DownloadDir, item.BVID+".mp4")
		item.FilePath = targetPath

		dlMu.Lock()
		item.Status = "downloading"
		item.Error = ""
		saveDownloadsLocked()
		dlMu.Unlock()

		// 1. 快速路径：若缓存目录中已存在该视频的完整 mp4，直接快速复制/硬链接
		cachePath := filepath.Join(CacheDir, item.BVID+".mp4")
		if fi, err := os.Stat(cachePath); err == nil && fi.Size() > 0 {
			if copyOrLinkFile(cachePath, targetPath) == nil {
				if item.PicLocal == "" || !fileExists(item.PicLocal) {
					item.PicLocal = cacheDownloadCover(item.BVID, item.Pic)
				}
				dlMu.Lock()
				item.TotalBytes = fi.Size()
				item.DownBytes = fi.Size()
				item.Progress = 100
				item.Status = "completed"
				saveDownloadsLocked()
				delete(dlCancels, item.BVID)
				dlMu.Unlock()
				log.Printf("[Download] %s fast-linked from cache (%d bytes)", item.BVID, fi.Size())
				return
			}
		}

		// 2. 异步缓存封面
		if item.PicLocal == "" || !fileExists(item.PicLocal) {
			item.PicLocal = cacheDownloadCover(item.BVID, item.Pic)
		}

		// 3. 优先使用 Bilibili DASH 音画双轨独立下载后用 FFmpeg 进行 copy 合并
		dash, dashErr := resolveDash(item.BVID)
		if dashErr == nil && dash.VideoURL != "" && dash.AudioURL != "" {
			log.Printf("[Download] %s using DASH audio+video FFmpeg copy merge", item.BVID)
			vPart := targetPath + ".v.part"
			aPart := targetPath + ".a.part"

			// 下载视频流 (0% -> 70%)
			vErr := downloadDashStream(ctx, item.BVID, "video", vPart, item, 0, 70)
			if vErr != nil {
				// 保留 .v.part：下次点「继续下载」用 Range 从断点续传。
				dlMu.Lock()
				delete(dlCancels, item.BVID)
				if ctx.Err() != nil {
					log.Printf("[Download] %s cancelled by user", item.BVID)
					dlMu.Unlock()
					return
				}
				item.Status = "error"
				item.Error = "下载视频轨失败: " + vErr.Error()
				saveDownloadsLocked()
				dlMu.Unlock()
				return
			}

			// 下载音频流 (70% -> 90%)
			aErr := downloadDashStream(ctx, item.BVID, "audio", aPart, item, 70, 90)
			if aErr != nil {
				// 保留 .v.part/.a.part，供断点续传。
				dlMu.Lock()
				delete(dlCancels, item.BVID)
				if ctx.Err() != nil {
					log.Printf("[Download] %s cancelled by user", item.BVID)
					dlMu.Unlock()
					return
				}
				item.Status = "error"
				item.Error = "下载音频轨失败: " + aErr.Error()
				saveDownloadsLocked()
				dlMu.Unlock()
				return
			}

			// FFmpeg copy merge 合并 (90% -> 100%)
			dlMu.Lock()
			item.Progress = 92
			saveDownloadsLocked()
			dlMu.Unlock()

			tmpMerged := targetPath + ".tmp.mp4"
			mergeCmd := exec.CommandContext(ctx, FFmpegPath,
				"-y",
				"-i", vPart,
				"-i", aPart,
				"-c", "copy",
				"-movflags", "+faststart",
				tmpMerged,
			)
			out, mergeErr := mergeCmd.CombinedOutput()

			if mergeErr != nil {
				_ = os.Remove(tmpMerged)
				dlMu.Lock()
				delete(dlCancels, item.BVID)
				item.Status = "error"
				item.Error = "合并音视频失败: " + mergeErr.Error()
				saveDownloadsLocked()
				dlMu.Unlock()
				log.Printf("[Download] %s FFmpeg merge failed: %v (%s)", item.BVID, mergeErr, string(out))
				return
			}

			_ = os.Remove(vPart)
			_ = os.Remove(aPart)
			_ = os.Rename(tmpMerged, targetPath)
			dlMu.Lock()
			delete(dlCancels, item.BVID)
			if fi, err := os.Stat(targetPath); err == nil {
				item.TotalBytes = fi.Size()
				item.DownBytes = fi.Size()
			}
			item.Progress = 100
			item.Status = "completed"
			item.Error = ""
			saveDownloadsLocked()
			dlMu.Unlock()
			log.Printf("[Download] %s merged successfully (%d bytes)", item.BVID, item.DownBytes)
			return
		}

		// 4. 降级回退：若 DASH 不可用，回退使用单一 HTML5 MP4 地址直接下载
		log.Printf("[Download] %s fallback to legacy playurl (dashErr: %v)", item.BVID, dashErr)
		primary, backups, err := resolvePlayURL(item.BVID)
		if err != nil {
			dlMu.Lock()
			item.Status = "error"
			item.Error = "解析视频地址失败: " + err.Error()
			saveDownloadsLocked()
			delete(dlCancels, item.BVID)
			dlMu.Unlock()
			return
		}

		candidates := append([]string{primary}, backups...)
		partPath := targetPath + ".part"
		var dlErr error

		for idx, u := range candidates {
			if ctx.Err() != nil {
				dlErr = ctx.Err()
				break
			}
			dlErr = downloadFilePartWithProgress(ctx, u, partPath, item, 0, 100)
			if dlErr == nil {
				break
			}
			log.Printf("[Download] %s candidate %d failed: %v", item.BVID, idx, dlErr)
		}

		dlMu.Lock()
		delete(dlCancels, item.BVID)
		if dlErr == nil {
			_ = os.Rename(partPath, targetPath)
			if fi, err := os.Stat(targetPath); err == nil {
				item.TotalBytes = fi.Size()
				item.DownBytes = fi.Size()
			}
			item.Progress = 100
			item.Status = "completed"
			item.Error = ""
			log.Printf("[Download] %s completed (%d bytes)", item.BVID, item.DownBytes)
		} else {
			// 保留 .part，用户点「继续下载」时从断点续传。
			if ctx.Err() != nil {
				log.Printf("[Download] %s cancelled by user", item.BVID)
				dlMu.Unlock()
				return
			}
			item.Status = "error"
			item.Error = dlErr.Error()
			log.Printf("[Download] %s failed: %v", item.BVID, dlErr)
		}
		saveDownloadsLocked()
		dlMu.Unlock()
	}()
}

// downloadDashStream 下载单条 DASH 轨道。
// 候选 URL 全部失败后不删除 .part，而是退避并清掉 dashCache 重新解析（播放地址约 10 分钟过期，
// 弱网下往往不是同一批 URL 能救回来），最多 4 轮；每轮都从 .part 现有字节数继续。
func downloadDashStream(ctx context.Context, bvid, kind, partPath string, item *DownloadItem, progStart, progEnd int) error {
	var lastErr error
	for round := 0; round < 4; round++ {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if round > 0 {
			invalidateDashCache(bvid)
			delay := time.Duration(2<<uint(round-1)) * time.Second // 2s / 4s / 8s
			if delay > 15*time.Second {
				delay = 15 * time.Second
			}
			log.Printf("[Download] %s %s re-resolve in %s (round %d, last: %v)", bvid, kind, delay, round, lastErr)
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(delay):
			}
		}
		dash, derr := resolveDash(bvid)
		if derr != nil {
			lastErr = derr
			continue
		}
		var candidates []string
		if kind == "audio" {
			candidates = append([]string{dash.AudioURL}, dash.AudioBackups...)
		} else {
			candidates = append([]string{dash.VideoURL}, dash.VideoBackups...)
		}
		for idx, u := range candidates {
			if u == "" {
				continue
			}
			if ctx.Err() != nil {
				return ctx.Err()
			}
			lastErr = downloadFilePartWithProgress(ctx, u, partPath, item, progStart, progEnd)
			if lastErr == nil {
				return nil
			}
			log.Printf("[Download] %s %s candidate %d failed (round %d): %v", bvid, kind, idx, round, lastErr)
		}
	}
	return lastErr
}

// 播放地址有 10 分钟 TTL；重试前清掉缓存，强制重新向 B 站解析。
func invalidateDashCache(bvid string) {
	dashCacheMu.Lock()
	delete(dashCache, bvid)
	dashCacheMu.Unlock()
}

// parseContentRange 解析 "bytes 100-199/1234"；total 为 "*" 时返回 0。
func parseContentRange(s string) (start, total int64, ok bool) {
	if !strings.HasPrefix(s, "bytes ") {
		return 0, 0, false
	}
	s = strings.TrimSpace(strings.TrimPrefix(s, "bytes "))
	parts := strings.SplitN(s, "/", 2)
	if len(parts) != 2 {
		return 0, 0, false
	}
	rng := strings.SplitN(parts[0], "-", 2)
	if len(rng) != 2 {
		return 0, 0, false
	}
	st, err := strconv.ParseInt(strings.TrimSpace(rng[0]), 10, 64)
	if err != nil {
		return 0, 0, false
	}
	t, err := strconv.ParseInt(strings.TrimSpace(parts[1]), 10, 64)
	if err != nil {
		t = 0
	}
	return st, t, true
}

func downloadFilePartWithProgress(ctx context.Context, rawURL, partPath string, item *DownloadItem, progStart, progEnd int) error {
	// 断点续传：以 .part 现有字节数为起点，带 Range 请求并追加写入。
	offset := int64(0)
	if fi, err := os.Stat(partPath); err == nil && fi.Size() > 0 {
		offset = fi.Size()
	}

	reqCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	req, err := http.NewRequestWithContext(reqCtx, "GET", rawURL, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", UserAgent)
	req.Header.Set("Referer", BiliReferer)
	if c := loadCookie(); c != "" {
		req.Header.Set("Cookie", c)
	}
	if offset > 0 {
		req.Header.Set("Range", fmt.Sprintf("bytes=%d-", offset))
	}

	resp, err := downloadClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	var total int64
	switch resp.StatusCode {
	case http.StatusPartialContent:
		start, t, ok := parseContentRange(resp.Header.Get("Content-Range"))
		if ok && start != offset {
			return fmt.Errorf("range mismatch: want %d got %d", offset, start)
		}
		if ok {
			total = t
		} else if resp.ContentLength > 0 {
			total = offset + resp.ContentLength
		}
	case http.StatusOK:
		// CDN 不支持 Range：只能从 0 重写，避免把整段文件接在旧数据后面。
		if offset > 0 {
			log.Printf("[Download] %s server ignored Range, restart from 0", item.BVID)
			offset = 0
		}
		total = resp.ContentLength
	case http.StatusRequestedRangeNotSatisfiable:
		if offset > 0 {
			log.Printf("[Download] %s .part already complete (%d bytes)", item.BVID, offset)
			return nil
		}
		return fmt.Errorf("upstream status 416")
	default:
		return fmt.Errorf("upstream status %d", resp.StatusCode)
	}

	flags := os.O_CREATE | os.O_WRONLY
	if offset > 0 {
		flags |= os.O_APPEND
	} else {
		flags |= os.O_TRUNC
	}
	out, err := os.OpenFile(partPath, flags, 0644)
	if err != nil {
		return err
	}
	defer out.Close()

	// 90s 无字节看门狗：downloadClient 没有总超时，防止弱网彻底挂死。
	var lastRead int64 = time.Now().Unix()
	stopWD := make(chan struct{})
	defer close(stopWD)
	go func() {
		t := time.NewTicker(10 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-stopWD:
				return
			case <-t.C:
				if time.Now().Unix()-atomic.LoadInt64(&lastRead) > 90 {
					log.Printf("[Download] %s read stalled >90s, cancel", item.BVID)
					cancel()
					return
				}
			}
		}
	}()

	buf := make([]byte, 64*1024)
	var written int64
	lastUpdate := time.Now()

	for {
		if reqCtx.Err() != nil {
			return reqCtx.Err()
		}
		n, rerr := resp.Body.Read(buf)
		if n > 0 {
			atomic.StoreInt64(&lastRead, time.Now().Unix())
			if _, werr := out.Write(buf[:n]); werr != nil {
				return werr
			}
			written += int64(n)
			paceDownload(n, item.BVID)

			now := time.Now()
			if now.Sub(lastUpdate) >= 2*time.Second {
				lastUpdate = now
				dlMu.Lock()
				if total > 0 {
					ratio := float64(offset+written) / float64(total)
					if ratio > 1.0 {
						ratio = 1.0
					}
					item.Progress = progStart + int(ratio*float64(progEnd-progStart))
					item.DownBytes = offset + written
					if total > item.TotalBytes {
						item.TotalBytes = total
					}
				}
				saveDownloadsLocked()
				dlMu.Unlock()
			}
		}
		if rerr != nil {
			if rerr == io.EOF {
				break
			}
			return rerr
		}
	}

	// 关键：提前 EOF 不能当成功，否则 FFmpeg 会拿到半截文件。
	if total > 0 && offset+written != total {
		return fmt.Errorf("incomplete: %d/%d bytes", offset+written, total)
	}
	dlMu.Lock()
	item.DownBytes = offset + written
	if total > 0 {
		item.TotalBytes = total
	}
	saveDownloadsLocked()
	dlMu.Unlock()
	return nil
}

func getDiskFree(path string) (int64, string) {
	var stat syscall.Statfs_t
	if err := syscall.Statfs(path, &stat); err != nil {
		return 0, "未知"
	}
	free := int64(stat.Bavail) * int64(stat.Bsize)
	gb := float64(free) / (1024 * 1024 * 1024)
	if gb >= 1.0 {
		return free, fmt.Sprintf("%.1f GB", gb)
	}
	mb := float64(free) / (1024 * 1024)
	return free, fmt.Sprintf("%.1f MB", mb)
}

func handleDownloadStart(w http.ResponseWriter, r *http.Request) {
	bvid := r.URL.Query().Get("bvid")
	if bvid == "" {
		jsonError(w, "missing bvid", 400)
		return
	}
	if !validBVID(bvid) {
		jsonError(w, "invalid bvid", 400)
		return
	}

	dlMu.Lock()
	if existing, ok := dlItems[bvid]; ok {
		if existing.Status == "completed" && fileExists(existing.FilePath) {
			dlMu.Unlock()
			writeJSON(w, 200, map[string]interface{}{
				"ok":      true,
				"status":  "completed",
				"message": "已下载完成",
				"item":    existing,
			})
			return
		}
		if existing.Status == "downloading" {
			dlMu.Unlock()
			writeJSON(w, 200, map[string]interface{}{
				"ok":      true,
				"status":  "downloading",
				"message": "正在下载中",
				"item":    existing,
			})
			return
		}
	}
	dlMu.Unlock()

	meta, err := resolveMeta(bvid)
	if err != nil {
		jsonError(w, "获取视频信息失败: "+err.Error(), 502)
		return
	}

	dlMu.Lock()
	item := dlItems[bvid]
	if item == nil {
		item = &DownloadItem{
			BVID:     bvid,
			Title:    meta.title,
			Owner:    meta.owner,
			Pic:      meta.pic,
			Duration: meta.duration,
			Created:  time.Now().Unix(),
			Status:   "pending",
		}
		dlItems[bvid] = item
		dlList = append([]*DownloadItem{item}, dlList...)
	} else {
		item.Title = meta.title
		item.Owner = meta.owner
		item.Pic = meta.pic
		item.Duration = meta.duration
		item.Status = "pending"
		item.Error = ""
	}
	saveDownloadsLocked()
	dlMu.Unlock()

	startDownloadTask(item)

	writeJSON(w, 200, map[string]interface{}{
		"ok":      true,
		"status":  "downloading",
		"message": "已开始下载",
		"item":    item,
	})
}

// handleDownloadPause 暂停下载：取消当前任务但保留 .part，之后 start 会带 Range 续传。
// 必须先写 status=paused 再 cancel：下载 goroutine 收到 ctx 取消会直接 return，不会覆盖状态。
func handleDownloadPause(w http.ResponseWriter, r *http.Request) {
	bvid := r.URL.Query().Get("bvid")
	if !validBVID(bvid) {
		jsonError(w, "invalid bvid", 400)
		return
	}
	dlMu.Lock()
	cancel, running := dlCancels[bvid]
	if running {
		delete(dlCancels, bvid)
	}
	it := dlItems[bvid]
	if it != nil && (it.Status == "downloading" || it.Status == "pending") {
		if it.Progress < 1 {
			it.Progress = 1
		}
		it.Status = "paused"
		it.Error = ""
		saveDownloadsLocked()
	}
	dlMu.Unlock()
	if running {
		cancel()
	}
	log.Printf("[BiliDaemon] download pause bvid=%s running=%v", bvid, running)
	writeJSON(w, 200, map[string]interface{}{"ok": true, "status": "paused", "item": it})
}

func handleDownloadList(w http.ResponseWriter, r *http.Request) {
	dlMu.Lock()
	// 值拷贝：不能把 *DownloadItem 指针交给锁外 marshal，下载 goroutine 会并发改字段。
	out := make([]DownloadItem, 0, len(dlList))
	for _, it := range dlList {
		if it != nil {
			out = append(out, *it)
		}
	}
	dlMu.Unlock()

	freeBytes, freeText := getDiskFree(DownloadDir)

	writeJSON(w, 200, map[string]interface{}{
		"ok":         true,
		"items":      out,
		"free_bytes": freeBytes,
		"free_text":  freeText,
	})
}

func handleDownloadStatus(w http.ResponseWriter, r *http.Request) {
	bvid := r.URL.Query().Get("bvid")
	if bvid == "" {
		jsonError(w, "missing bvid", 400)
		return
	}
	dlMu.Lock()
	item, ok := dlItems[bvid]
	dlMu.Unlock()

	if !ok || item == nil {
		writeJSON(w, 200, map[string]interface{}{
			"ok":     true,
			"status": "none",
			"item":   nil,
		})
		return
	}

	writeJSON(w, 200, map[string]interface{}{
		"ok":     true,
		"status": item.Status,
		"item":   item,
	})
}

func handleDownloadDelete(w http.ResponseWriter, r *http.Request) {
	bvid := r.URL.Query().Get("bvid")
	if bvid == "" {
		jsonError(w, "missing bvid", 400)
		return
	}

	dlMu.Lock()
	if cancel, ok := dlCancels[bvid]; ok {
		cancel()
		delete(dlCancels, bvid)
	}

	item, exists := dlItems[bvid]
	if exists {
		delete(dlItems, bvid)
		newList := make([]*DownloadItem, 0, len(dlList))
		for _, it := range dlList {
			if it.BVID != bvid {
				newList = append(newList, it)
			}
		}
		dlList = newList
		saveDownloadsLocked()
	}
	dlMu.Unlock()

	if item != nil {
		_ = os.Remove(item.FilePath)
		_ = os.Remove(item.FilePath + ".part")
		_ = os.Remove(item.FilePath + ".v.part")
		_ = os.Remove(item.FilePath + ".a.part")
		_ = os.Remove(item.FilePath + ".tmp.mp4")
		if item.PicLocal != "" {
			_ = os.Remove(item.PicLocal)
		}
	} else {
		_ = os.Remove(filepath.Join(DownloadDir, bvid+".mp4"))
		_ = os.Remove(filepath.Join(DownloadDir, bvid+".mp4.part"))
		_ = os.Remove(filepath.Join(DownloadCoverDir, bvid+".jpg"))
	}

	log.Printf("[Download] deleted download for %s", bvid)
	writeJSON(w, 200, map[string]interface{}{
		"ok":      true,
		"message": "已删除下载内容",
	})
}
