package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

var (
	audioBytes         int64
	activeAudioMu      sync.Mutex
	activeAudioStreams = map[int]context.CancelFunc{}
	audioSeq           int
)

func registerAudioStream(cancel context.CancelFunc) int {
	activeAudioMu.Lock()
	defer activeAudioMu.Unlock()
	audioSeq++
	id := audioSeq
	activeAudioStreams[id] = cancel
	return id
}

func unregisterAudioStream(id int) {
	activeAudioMu.Lock()
	delete(activeAudioStreams, id)
	activeAudioMu.Unlock()
}

func cancelActiveAudio() {
	activeAudioMu.Lock()
	cancels := make([]context.CancelFunc, 0, len(activeAudioStreams))
	for _, c := range activeAudioStreams {
		cancels = append(cancels, c)
	}
	activeAudioStreams = map[int]context.CancelFunc{}
	activeAudioMu.Unlock()
	for _, c := range cancels {
		c()
	}
	if len(cancels) > 0 {
		log.Printf("[BiliDaemon] cancelled %d active audio remux streams", len(cancels))
	}
}

func handleALSAReady(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	timeoutMs := 600
	if t := r.URL.Query().Get("timeout"); t != "" {
		if v, err := strconv.Atoi(t); err == nil && v > 0 {
			if v > 3000 {
				v = 3000
			}
			timeoutMs = v
		}
	}

	start := time.Now()
	deadline := start.Add(time.Duration(timeoutMs) * time.Millisecond)
	devicePath := "/dev/snd/pcmC0D0p"

	for {
		f, err := os.OpenFile(devicePath, os.O_WRONLY|syscall.O_NONBLOCK, 0)
		if err == nil {
			_ = f.Close()
			time.Sleep(30 * time.Millisecond)
			waited := time.Since(start).Milliseconds()
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"code":      0,
				"ready":     true,
				"waited_ms": waited,
			})
			return
		}
		if os.IsNotExist(err) {
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"code":  0,
				"ready": true,
				"mock":  true,
			})
			return
		}
		if time.Now().After(deadline) {
			waited := time.Since(start).Milliseconds()
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"code":      0,
				"ready":     false,
				"waited_ms": waited,
				"error":     err.Error(),
			})
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// ---- 音频本地缓存（预热）----
// 目的：厂商播放器起播要等网络首包（弱网 1~3s），而它没有「只缓存不播」的接口。
// 这里让 daemon 在点「看视频」时后台把重封装后的音轨落盘；真正起播时从本地文件跟随读取，
// 首个字节从秒级降到几十毫秒，音视频就能几乎同时开始。
var (
	audioPrefMu      sync.Mutex
	audioPrefetching = map[string]bool{}
)

func audioCachePath(bvid string) string {
	return filepath.Join(CacheDir, bvid+".audio.mp4")
}

func audioPrefetchActive(bvid string) bool {
	audioPrefMu.Lock()
	defer audioPrefMu.Unlock()
	return audioPrefetching[bvid]
}

func prefetchAudio(bvid string) {
	audioPrefMu.Lock()
	if audioPrefetching[bvid] {
		audioPrefMu.Unlock()
		return
	}
	audioPrefetching[bvid] = true
	audioPrefMu.Unlock()
	defer func() {
		audioPrefMu.Lock()
		delete(audioPrefetching, bvid)
		audioPrefMu.Unlock()
	}()

	final := audioCachePath(bvid)
	if fi, err := os.Stat(final); err == nil && fi.Size() > 512*1024 {
		return
	}
	if _, err := os.Stat(FFmpegPath); err != nil {
		return
	}
	au, err := resolveAudio(bvid)
	if err != nil {
		log.Printf("[BiliDaemon] audio prefetch resolve failed for %s: %v", bvid, err)
		return
	}
	_ = os.MkdirAll(CacheDir, 0755)
	args := []string{"-y", "-hide_banner", "-loglevel", "error", "-nostdin",
		"-user_agent", UserAgent, "-referer", BiliReferer}
	if c := loadCookie(); c != "" {
		args = append(args, "-headers", "Cookie: "+c+"\r\n")
	}
	args = append(args,
		"-probesize", "131072", "-analyzeduration", "131072",
		"-i", au.url,
		"-f", "lavfi", "-i", "color=c=black:s=160x90:r=1",
		"-map", "0:a:0", "-map", "1:v:0",
		"-c:a", "copy",
		"-c:v", "mpeg4", "-q:v", "31", "-g", "1",
		"-shortest",
		"-movflags", "frag_keyframe+empty_moov+default_base_moof",
		"-f", "mp4", final,
	)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer cancel()
	cmd := execFFmpegCommand(ctx, args)
	if err := cmd.Run(); err != nil {
		_ = os.Remove(final)
		log.Printf("[BiliDaemon] audio prefetch %s failed: %v", bvid, err)
		return
	}
	if fi, err := os.Stat(final); err == nil {
		log.Printf("[BiliDaemon] audio prefetched %s (%d bytes)", bvid, fi.Size())
	}
}

// serveAudioCache 从「可能仍在增长」的缓存文件里跟随读取：prefetch 没下完时读到末尾就等，
// prefetch 结束后自然收尾。分片 mp4（empty_moov）可以边下边播。
func serveAudioCache(w http.ResponseWriter, r *http.Request, bvid, path string) {
	f, err := os.Open(path)
	if err != nil {
		http.Error(w, "audio cache open: "+err.Error(), 500)
		return
	}
	defer f.Close()
	w.Header().Set("Content-Type", "video/mp4")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	flusher, _ := w.(http.Flusher)
	if flusher != nil {
		flusher.Flush()
	}
	ctx := r.Context()
	buf := make([]byte, 64*1024)
	for {
		if ctx.Err() != nil {
			return
		}
		n, rerr := f.Read(buf)
		if n > 0 {
			if _, werr := w.Write(buf[:n]); werr != nil {
				return
			}
			atomic.AddInt64(&audioBytes, int64(n))
			if flusher != nil {
				flusher.Flush()
			}
		}
		if rerr == io.EOF {
			if !audioPrefetchActive(bvid) {
				log.Printf("[BiliDaemon] audio cache stream end %s", bvid)
				return
			}
			select {
			case <-ctx.Done():
				return
			case <-time.After(120 * time.Millisecond):
			}
			continue
		}
		if rerr != nil {
			return
		}
	}
}

// handleAudio provides remuxed or raw audio stream, with seek support (&ss=).
func handleAudio(w http.ResponseWriter, r *http.Request) {
	bvid := r.URL.Query().Get("bvid")
	if bvid == "" || !validBVID(bvid) {
		jsonError(w, "invalid or missing bvid", 400)
		return
	}

	ss := r.URL.Query().Get("ss")

	// 1. Check local download directory
	offlinePath := filepath.Join(DownloadDir, bvid+".mp4")
	if fileExists(offlinePath) {
		handleLocalAudioRemux(w, r, bvid, offlinePath, ss)
		return
	}

	// 2. Check local playback cache
	cachePath := filepath.Join(CacheDir, bvid+".mp4")
	if fileExists(cachePath) {
		handleLocalAudioRemux(w, r, bvid, cachePath, ss)
		return
	}

	// 2.5 音频本地缓存（prefetch 落盘）：起播走本地，seek 仍走本地文件 remux
	if ap := audioCachePath(bvid); fileExists(ap) || audioPrefetchActive(bvid) {
		if ss == "" || ss == "0" {
			serveAudioCache(w, r, bvid, ap)
			return
		}
		if fileExists(ap) {
			handleLocalAudioRemux(w, r, bvid, ap, ss)
			return
		}
	}

	// 3. Resolve upstream audio
	au, err := resolveAudio(bvid)
	if err != nil {
		log.Printf("[BiliDaemon] audio resolve failed for %s: %v", bvid, err)
		http.Error(w, "audio: "+err.Error(), 502)
		return
	}
	if r.URL.Query().Get("variant") == "remux" || ss != "" {
		handleAudioRemux(w, r, bvid, au, ss)
		return
	}
	candidates := append([]string{au.url}, au.backups...)
	proxyUpstream(w, r, "audio:"+bvid, candidates, "audio/mp4", AudioIdleTimeout, &audioBytes)
}

func handleAudioRemux(w http.ResponseWriter, r *http.Request, bvid string, au audioEntry, ss string) {
	if _, err := os.Stat(FFmpegPath); err != nil {
		http.Error(w, "ffmpeg not available", 503)
		return
	}
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	aid := registerAudioStream(cancel)
	defer unregisterAudioStream(aid)

	args := []string{
		"-hide_banner", "-loglevel", "error", "-nostdin",
		"-user_agent", UserAgent,
		"-referer", BiliReferer,
	}
	if c := loadCookie(); c != "" {
		args = append(args, "-headers", "Cookie: "+c+"\r\n")
	}
	if ss != "" && ss != "0" {
		args = append(args, "-ss", ss)
	}
	args = append(args,
		"-probesize", "131072",
		"-analyzeduration", "131072",
		"-i", au.url,
		"-f", "lavfi", "-i", "color=c=black:s=160x90:r=1",
		"-map", "0:a:0", "-map", "1:v:0",
		"-c:a", "copy",
		"-c:v", "mpeg4", "-q:v", "31", "-g", "1",
		"-shortest",
		"-movflags", "frag_keyframe+empty_moov+default_base_moof",
		"-flush_packets", "1",
		"-f", "mp4", "pipe:1",
	)
	cmd := execFFmpegCommand(ctx, args)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		http.Error(w, "ffmpeg pipe: "+err.Error(), 500)
		return
	}
	if err := cmd.Start(); err != nil {
		http.Error(w, "ffmpeg start: "+err.Error(), 500)
		return
	}
	defer func() {
		cancel()
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
		_ = cmd.Wait()
	}()

	log.Printf("[BiliDaemon] audio remux start %s (id=%d bw=%d ss=%s)", bvid, au.id, au.bw, ss)
	w.Header().Set("Content-Type", "video/mp4")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	if f, ok := w.(http.Flusher); ok {
		f.Flush()
	}

	type pipeChunk struct {
		data []byte
		err  error
	}
	chunkCh := make(chan pipeChunk, 16)
	go func() {
		defer close(chunkCh)
		buf := make([]byte, 16*1024)
		for {
			n, rerr := stdout.Read(buf)
			if n > 0 {
				data := make([]byte, n)
				copy(data, buf[:n])
				select {
				case chunkCh <- pipeChunk{data: data}:
				case <-ctx.Done():
					return
				}
			}
			if rerr != nil {
				select {
				case chunkCh <- pipeChunk{err: rerr}:
				case <-ctx.Done():
				}
				return
			}
		}
	}()

	written := int64(0)
	loggedFirst := false
	for chunk := range chunkCh {
		if len(chunk.data) > 0 {
			if !loggedFirst {
				loggedFirst = true
				log.Printf("[BiliDaemon] audio remux first byte %s", bvid)
			}
			if _, werr := w.Write(chunk.data); werr != nil {
				log.Printf("[BiliDaemon] audio remux client gone %s after %d bytes", bvid, written)
				return
			}
			written += int64(len(chunk.data))
			atomic.AddInt64(&audioBytes, int64(len(chunk.data)))
			if f, ok := w.(http.Flusher); ok {
				f.Flush()
			}
		}
		if chunk.err != nil {
			break
		}
	}
	log.Printf("[BiliDaemon] audio remux end %s, %d bytes", bvid, written)
	if stderr.Len() > 0 {
		msg := strings.TrimSpace(stderr.String())
		if len(msg) > 500 {
			msg = msg[:500]
		}
		log.Printf("[BiliDaemon] audio remux %s ffmpeg: %s", bvid, msg)
	}
}

func handleLocalAudioRemux(w http.ResponseWriter, r *http.Request, bvid, localPath, ss string) {
	if _, err := os.Stat(FFmpegPath); err != nil {
		http.Error(w, "ffmpeg not available", 503)
		return
	}
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	aid := registerAudioStream(cancel)
	defer unregisterAudioStream(aid)

	args := []string{
		"-hide_banner", "-loglevel", "error", "-nostdin",
	}
	if ss != "" && ss != "0" {
		args = append(args, "-ss", ss)
	}
	args = append(args,
		"-probesize", "131072",
		"-analyzeduration", "131072",
		"-i", localPath,
		"-f", "lavfi", "-i", "color=c=black:s=160x90:r=1",
		"-map", "0:a:0", "-map", "1:v:0",
		"-c:a", "copy",
		"-c:v", "mpeg4", "-q:v", "31", "-g", "1",
		"-shortest",
		"-movflags", "frag_keyframe+empty_moov+default_base_moof",
		"-flush_packets", "1",
		"-f", "mp4", "pipe:1",
	)
	cmd := execFFmpegCommand(ctx, args)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		http.Error(w, "ffmpeg pipe: "+err.Error(), 500)
		return
	}
	if err := cmd.Start(); err != nil {
		http.Error(w, "ffmpeg start: "+err.Error(), 500)
		return
	}
	defer func() {
		cancel()
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
		_ = cmd.Wait()
	}()

	log.Printf("[BiliDaemon] local audio remux start %s (%s, ss=%s)", bvid, localPath, ss)
	w.Header().Set("Content-Type", "video/mp4")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	if f, ok := w.(http.Flusher); ok {
		f.Flush()
	}

	written := int64(0)
	buf := make([]byte, 16*1024)
	for {
		if ctx.Err() != nil {
			break
		}
		n, rerr := stdout.Read(buf)
		if n > 0 {
			if _, werr := w.Write(buf[:n]); werr != nil {
				log.Printf("[BiliDaemon] local audio remux client gone %s after %d bytes", bvid, written)
				return
			}
			written += int64(n)
			atomic.AddInt64(&audioBytes, int64(n))
			if f, ok := w.(http.Flusher); ok {
				f.Flush()
			}
		}
		if rerr != nil {
			break
		}
	}
	log.Printf("[BiliDaemon] local audio remux end %s, %d bytes", bvid, written)
}
