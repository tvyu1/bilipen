package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
	"strings"
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
	dlMu       sync.Mutex
	dlItems    = make(map[string]*DownloadItem)
	dlList     []*DownloadItem
	dlCancels  = make(map[string]context.CancelFunc)
	dlSem      = make(chan struct{}, 1) // 保持单任务下载，避免单核 A7 I/O 和 CPU 阻塞
	dlActive   int32
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
			it.Status = "error"
			it.Error = "下载被中断"
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

		// 快速路径：若缓存目录中已存在该视频的完整 mp4，直接快速复制/链接
		cachePath := filepath.Join(CacheDir, item.BVID+".mp4")
		if fi, err := os.Stat(cachePath); err == nil && fi.Size() > 0 {
			if copyOrLinkFile(cachePath, targetPath) == nil {
				// 缓存封面
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

		// 异步缓存封面
		if item.PicLocal == "" || !fileExists(item.PicLocal) {
			item.PicLocal = cacheDownloadCover(item.BVID, item.Pic)
		}

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
			dlErr = downloadFileWithProgress(ctx, u, partPath, item)
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
			_ = os.Remove(partPath)
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

func downloadFileWithProgress(ctx context.Context, rawURL, partPath string, item *DownloadItem) error {
	req, err := http.NewRequestWithContext(ctx, "GET", rawURL, nil)
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

	total := resp.ContentLength
	dlMu.Lock()
	if total > 0 {
		item.TotalBytes = total
	}
	item.DownBytes = 0
	item.Progress = 0
	saveDownloadsLocked()
	dlMu.Unlock()

	out, err := os.OpenFile(partPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0644)
	if err != nil {
		return err
	}
	defer out.Close()

	buf := make([]byte, 64*1024)
	var written int64
	lastUpdate := time.Now()

	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		n, rerr := resp.Body.Read(buf)
		if n > 0 {
			if _, werr := out.Write(buf[:n]); werr != nil {
				return werr
			}
			written += int64(n)
			paceDownload(n, item.BVID)

			now := time.Now()
			if now.Sub(lastUpdate) >= 500*time.Millisecond {
				lastUpdate = now
				dlMu.Lock()
				item.DownBytes = written
				if item.TotalBytes > 0 {
					p := int((written * 100) / item.TotalBytes)
					if p > 99 {
						p = 99
					}
					item.Progress = p
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

func handleDownloadList(w http.ResponseWriter, r *http.Request) {
	dlMu.Lock()
	out := make([]*DownloadItem, len(dlList))
	copy(out, dlList)
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

func handleLocalAudioRemux(w http.ResponseWriter, r *http.Request, bvid, localPath string) {
	if _, err := os.Stat(FFmpegPath); err != nil {
		http.Error(w, "ffmpeg not available", 503)
		return
	}
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	sid := registerStream(cancel)
	defer unregisterStream(sid)

	args := []string{
		"-hide_banner", "-loglevel", "error", "-nostdin",
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
	}
	cmd := exec.CommandContext(ctx, FFmpegPath, args...)
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

	log.Printf("[BiliDaemon] local audio remux start %s (%s)", bvid, localPath)
	w.Header().Set("Content-Type", "video/mp4")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	if f, ok := w.(http.Flusher); ok {
		f.Flush()
	}
	buf := make([]byte, 32*1024)
	written := int64(0)
	for {
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
	log.Printf("[BiliDaemon] local audio remux done %s (%d bytes)", bvid, written)
}
