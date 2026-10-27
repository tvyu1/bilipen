package main

import (
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// CacheItem 是「在线缓存」列表的一行。与离线下载（bili_downloads）严格分开：
// 这里的删除只影响 /userdisk/bili_cache，不会动用户显式下载的文件。
type CacheItem struct {
	BVID     string `json:"bvid"`
	Title    string `json:"title"`
	Owner    string `json:"owner"`
	PicLocal string `json:"pic_local"`
	Duration int    `json:"duration"`
	Bytes    int64  `json:"bytes"`
	MTime    int64  `json:"mtime"`
	Status   string `json:"status"` // cached | active | partial
	Playing  bool   `json:"playing"`
}

func cacheMeta(bvid string) (title, owner string, duration int) {
	dlMu.Lock()
	if it := dlItems[bvid]; it != nil {
		title, owner, duration = it.Title, it.Owner, it.Duration
	}
	dlMu.Unlock()
	if title != "" {
		return
	}
	historyMu.Lock()
	for _, h := range historyItems {
		if h.Bvid == bvid {
			title = h.Title
			duration = int(h.Duration)
			break
		}
	}
	historyMu.Unlock()
	if title != "" {
		return
	}
	feedCacheMu.Lock()
	for _, v := range feedCacheItems {
		if v.Bvid == bvid {
			title, owner, duration = v.Title, v.Owner, v.Duration
			break
		}
	}
	feedCacheMu.Unlock()
	return
}

func cacheCoverLocal(bvid string) string {
	p := filepath.Join(CoverDir, bvid+".jpg")
	if fi, err := os.Stat(p); err == nil && fi.Size() > 512 {
		return "covers/" + bvid + ".jpg"
	}
	return ""
}

func activeSpools() map[string]bool {
	out := map[string]bool{}
	spoolMu.Lock()
	for bvid, s := range spools {
		s.mu.Lock()
		if s.err == nil && !s.done {
			out[bvid] = true
		}
		s.mu.Unlock()
	}
	spoolMu.Unlock()
	return out
}

func handleCacheList(w http.ResponseWriter, r *http.Request) {
	entries, err := os.ReadDir(CacheDir)
	if err != nil {
		writeJSON(w, 200, map[string]interface{}{
			"ok": true, "items": []CacheItem{}, "count": 0,
			"total_bytes": 0, "cap_bytes": CacheCapBytes, "free_bytes": 0, "free_text": "未知",
		})
		return
	}
	active := activeSpools()
	playing := playbackActiveBvid()

	// 同一 bvid 若完整 .mp4 与 .part 同时存在，只保留 .mp4（.part 计入占用）。
	hasFull := map[string]bool{}
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".mp4") {
			hasFull[strings.TrimSuffix(e.Name(), ".mp4")] = true
		}
	}

	items := make([]CacheItem, 0, len(entries))
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
		var bvid, status string
		switch {
		case strings.HasSuffix(name, ".mp4"):
			bvid = strings.TrimSuffix(name, ".mp4")
			status = "cached"
		case strings.HasSuffix(name, ".mp4.part"):
			bvid = strings.TrimSuffix(name, ".mp4.part")
			status = "partial"
			if active[bvid] {
				status = "active"
			}
			if hasFull[bvid] {
				total += fi.Size()
				continue
			}
		default:
			continue
		}
		total += fi.Size()
		title, owner, dur := cacheMeta(bvid)
		if title == "" {
			title = bvid
		}
		items = append(items, CacheItem{
			BVID: bvid, Title: title, Owner: owner, PicLocal: cacheCoverLocal(bvid),
			Duration: dur, Bytes: fi.Size(), MTime: fi.ModTime().Unix(),
			Status: status, Playing: bvid == playing,
		})
	}
	sort.Slice(items, func(i, j int) bool { return items[i].MTime > items[j].MTime })

	freeBytes, freeText := getDiskFree("/userdisk")
	writeJSON(w, 200, map[string]interface{}{
		"ok":          true,
		"items":       items,
		"count":       len(items),
		"total_bytes": total,
		"cap_bytes":   CacheCapBytes,
		"free_bytes":  freeBytes,
		"free_text":   freeText,
	})
}

func removeCacheFiles(bvid string) (freed int64) {
	for _, p := range []string{
		filepath.Join(CacheDir, bvid+".mp4"),
		filepath.Join(CacheDir, bvid+".mp4.part"),
	} {
		if fi, err := os.Stat(p); err == nil {
			if os.Remove(p) == nil {
				freed += fi.Size()
			}
		}
	}
	return
}

func handleCacheDelete(w http.ResponseWriter, r *http.Request) {
	bvid := r.URL.Query().Get("bvid")
	if bvid == "" || !validBVID(bvid) {
		jsonError(w, "invalid or missing bvid", 400)
		return
	}
	force := r.URL.Query().Get("force") == "1"

	if playbackActiveBvid() == bvid && !force {
		jsonError(w, "正在播放，无法删除", 409)
		return
	}
	spoolMu.Lock()
	s := spools[bvid]
	spoolMu.Unlock()
	if s != nil {
		s.mu.Lock()
		active := s.err == nil && !s.done
		s.mu.Unlock()
		if active && !force {
			jsonError(w, "正在缓存，无法删除", 409)
			return
		}
		if active && s.cancel != nil {
			s.cancel()
		}
	}

	freed := removeCacheFiles(bvid)
	// 必须同时清 spools：否则 handleStream 会命中不存在的文件并返回空 200。
	spoolMu.Lock()
	delete(spools, bvid)
	spoolMu.Unlock()

	log.Printf("[Cache] deleted %s (%d bytes)", bvid, freed)
	writeJSON(w, 200, map[string]interface{}{"ok": true, "bvid": bvid, "freed_bytes": freed})
}

func handleCacheClear(w http.ResponseWriter, r *http.Request) {
	active := activeSpools()
	playing := playbackActiveBvid()
	entries, err := os.ReadDir(CacheDir)
	if err != nil {
		writeJSON(w, 200, map[string]interface{}{"ok": true, "removed": 0, "freed_bytes": 0, "skipped": []string{}})
		return
	}

	removed := 0
	var freed int64
	skipped := make([]string, 0)
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := e.Name()
		var bvid string
		switch {
		case strings.HasSuffix(name, ".mp4"):
			bvid = strings.TrimSuffix(name, ".mp4")
		case strings.HasSuffix(name, ".mp4.part"):
			bvid = strings.TrimSuffix(name, ".mp4.part")
		default:
			continue
		}
		if bvid == playing || active[bvid] {
			skipped = append(skipped, bvid)
			continue
		}
		fi, statErr := e.Info()
		if statErr != nil {
			continue
		}
		if err := os.Remove(filepath.Join(CacheDir, name)); err == nil {
			removed++
			freed += fi.Size()
			spoolMu.Lock()
			delete(spools, bvid)
			spoolMu.Unlock()
		}
	}

	log.Printf("[Cache] cleared %d files (%d bytes), skipped %d active", removed, freed, len(skipped))
	writeJSON(w, 200, map[string]interface{}{
		"ok": true, "removed": removed, "freed_bytes": freed, "skipped": skipped,
	})
}
