# -*- coding: utf-8 -*-
"""按函数边界替换 bili_src/main.go 中的 handleStream/handlePlay/handleStop 等实现。"""
import io
import sys

P = r"E:\dw\youdaokaifa-a7\bili_src\main.go"

src = io.open(P, encoding="utf-8").read()


def find_func(src, name):
    marker = "func " + name + "("
    i = src.index(marker)
    j = src.find("\nfunc ", i + 1)
    if j < 0:
        return i, len(src)
    return i, j + 1  # j+1 keeps the leading newline away


def replace_func(src, name, new_text):
    i, j = find_func(src, name)
    return src[:i] + new_text.rstrip() + "\n\n" + src[j:]


def delete_func(src, name):
    i, j = find_func(src, name)
    return src[:i] + src[j:]


NEW_STREAM = r'''func openUpstream(ctx context.Context, streamURL string, r *http.Request) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", streamURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", UserAgent)
	req.Header.Set("Referer", BiliReferer)
	if cookie := loadCookie(); cookie != "" {
		req.Header.Set("Cookie", cookie)
	}
	if rng := r.Header.Get("Range"); rng != "" {
		req.Header.Set("Range", rng)
	}
	return streamClient.Do(req)
}

// handleStream 代理 B 站 CDN 的 MP4 流。
// 关键修复：
//   1. 不再使用 http.Client.Timeout（旧代码 120s 会把所有长视频截断），改用 r.Context() + 空闲看门狗；
//   2. 透传 Range 并校验上游是否真的返回 200/206，失败时回退 backup_url；
//   3. 只透传必要响应头，避免逐跳头/错误页被当成视频下发。
func handleStream(w http.ResponseWriter, r *http.Request) {
	bvid := r.URL.Query().Get("bvid")
	if bvid == "" {
		http.Error(w, "missing bvid", 400)
		return
	}
	primary, backups, err := resolvePlayURL(bvid)
	if err != nil {
		log.Printf("[BiliDaemon] stream resolve failed for %s: %v", bvid, err)
		http.Error(w, "upstream: "+err.Error(), 502)
		return
	}

	candidates := append([]string{primary}, backups...)
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	var resp *http.Response
	var lastErr error
	for i, u := range candidates {
		rr, oerr := openUpstream(ctx, u, r)
		if oerr != nil {
			lastErr = oerr
			log.Printf("[BiliDaemon] stream candidate %d error for %s: %v", i, bvid, oerr)
			continue
		}
		if rr.StatusCode == http.StatusOK || rr.StatusCode == http.StatusPartialContent {
			resp = rr
			break
		}
		lastErr = fmt.Errorf("upstream status %d", rr.StatusCode)
		rr.Body.Close()
		log.Printf("[BiliDaemon] stream candidate %d bad status %d for %s", i, rr.StatusCode, bvid)
	}
	if resp == nil {
		http.Error(w, "upstream unavailable: "+lastErr.Error(), 502)
		return
	}
	defer resp.Body.Close()

	for _, k := range []string{"Content-Type", "Content-Length", "Content-Range", "Accept-Ranges", "Last-Modified", "ETag"} {
		if v := resp.Header.Get(k); v != "" {
			w.Header().Set(k, v)
		}
	}
	ct := strings.ToLower(w.Header().Get("Content-Type"))
	if strings.Contains(ct, "text/html") {
		http.Error(w, "upstream returned html error page", 502)
		return
	}
	if w.Header().Get("Content-Type") == "" {
		w.Header().Set("Content-Type", "video/mp4")
	}
	w.WriteHeader(resp.StatusCode)

	// 空闲看门狗：正常播放不受总时长限制，只有 45s 没有新数据才断开。
	idle := time.AfterFunc(StreamIdleTimeout, func() {
		log.Printf("[BiliDaemon] stream idle timeout for %s, closing", bvid)
		cancel()
	})
	defer idle.Stop()

	buf := make([]byte, 32*1024)
	for {
		n, rerr := resp.Body.Read(buf)
		if n > 0 {
			idle.Reset(StreamIdleTimeout)
			if _, werr := w.Write(buf[:n]); werr != nil {
				cancel()
				return
			}
			if f, ok := w.(http.Flusher); ok {
				f.Flush()
			}
		}
		if rerr != nil {
			if !errors.Is(rerr, io.EOF) && !errors.Is(rerr, context.Canceled) {
				log.Printf("[BiliDaemon] stream copy end for %s: %v", bvid, rerr)
			}
			return
		}
	}
}'''

NEW_PLAY = r'''func handlePlay(w http.ResponseWriter, r *http.Request) {
	bvid := r.URL.Query().Get("bvid")
	title := r.URL.Query().Get("title")
	if bvid == "" {
		http.Error(w, "missing bvid", 400)
		return
	}
	if !validBVID(bvid) {
		http.Error(w, "invalid bvid", 400)
		return
	}

	mu.Lock()
	currentBvid = bvid
	currentName = title
	sessionOn = true
	mu.Unlock()

	initHardwareAudio()
	log.Printf("[BiliDaemon] playback session start: %s (%s)", bvid, title)

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{"status": "playing", "version": Version})
}'''

NEW_STOP = r'''func handleStop(w http.ResponseWriter, r *http.Request) {
	mu.Lock()
	sessionOn = false
	currentBvid = ""
	currentName = ""
	mu.Unlock()

	log.Printf("[BiliDaemon] playback session stop")
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{"status": "stopped"})
}'''

NEW_AUDIO_INIT = r'''func initHardwareAudio() {
	// 锁定 LINEOUT 增益为 16，避免 >18 削波破音（平台手册 6.2）。
	runTinymix("23", "16")
}

func runTinymix(args ...string) {
	full := append([]string{"-D", "0", "set"}, args...)
	cmd := exec.Command(TinymixPath, full...)
	if out, err := cmd.CombinedOutput(); err != nil {
		log.Printf("[BiliDaemon] tinymix %v failed: %v (%s)", args, err, strings.TrimSpace(string(out)))
	}
}'''

NEW_GET_VOLUME = r'''func readSystemVolume() (int, bool) {
	if shmMemPtr == 0 {
		if !shmOK && time.Now().Before(shmNextTry) {
			return 0, false
		}
		initVolumeSharedMemory()
		if shmMemPtr == 0 {
			if shmAttempts < 6 {
				shmAttempts++
			}
			shmNextTry = time.Now().Add(time.Duration(shmAttempts) * 5 * time.Second)
			log.Printf("[BiliDaemon] volume shm unavailable, retry in %v", time.Duration(shmAttempts)*5*time.Second)
			return 0, false
		}
		shmOK = true
	}
	spkVol := *(*uint32)(unsafe.Pointer(shmMemPtr + 4))
	if spkVol > 100 {
		spkVol = 50
	}
	return int(spkVol), true
}

func getSystemVolume() int {
	vol, ok := readSystemVolume()
	if !ok {
		return 50
	}
	return vol
}'''

NEW_VOLUME = r'''func volumeSyncLoop() {
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()

	for range ticker.C {
		vol, ok := readSystemVolume()
		if !ok {
			// 共享内存不可用时绝不写 tinymix：旧代码会强行把硬件音量锁成 50%。
			continue
		}
		if vol == lastAlsaVol {
			continue
		}
		lastAlsaVol = vol
		alsaVal := int(float64(vol) * 2.55)
		if alsaVal > 255 {
			alsaVal = 255
		}
		if alsaVal < 0 {
			alsaVal = 0
		}
		alsaStr := strconv.Itoa(alsaVal)
		// ALSA control 25 有两个声道（左/右）
		runTinymix("25", alsaStr, alsaStr)
		log.Printf("[BiliDaemon] volume sync: %d%% -> ALSA %s/255", vol, alsaStr)
	}
}'''

src = replace_func(src, "handleStream", NEW_STREAM)
src = replace_func(src, "handlePlay", NEW_PLAY)
src = replace_func(src, "handleStop", NEW_STOP)
src = delete_func(src, "stopCurrentPlaybackLocked")
src = replace_func(src, "initHardwareAudio", NEW_AUDIO_INIT)
src = replace_func(src, "initVolumeSharedMemory", r'''func initVolumeSharedMemory() {
	if shmMemPtr != 0 {
		return
	}
	// ARM EABI: SYS_shmget = 307, SYS_shmat = 305
	shmid, _, err := syscall.Syscall(SYS_shmget, uintptr(VctlShmKey), 24, 0)
	if int(shmid) < 0 || err != 0 {
		log.Printf("[BiliDaemon] shmget failed (shmid=%d, err=%v)", int(shmid), err)
		return
	}
	raddr, _, err := syscall.Syscall(SYS_shmat, shmid, 0, 0x1000)
	if err != 0 || raddr == 0 || int(raddr) == -1 {
		log.Printf("[BiliDaemon] shmat failed (raddr=0x%x, err=%v)", raddr, err)
		return
	}
	shmMemPtr = raddr
	shmOK = true
	log.Printf("[BiliDaemon] volume shared memory attached at 0x%x", shmMemPtr)
}''')
src = replace_func(src, "getSystemVolume", NEW_GET_VOLUME)
src = replace_func(src, "volumeSyncLoop", NEW_VOLUME)

io.open(P, "w", encoding="utf-8", newline="\n").write(src)
print("patched OK, lines =", src.count("\n") + 1)
