package main

import (
	"encoding/json"
	"net/http"
	"os"
	"strconv"
	"sync"
	"time"
)

const (
	HistoryPath  = "/userdisk/bili_history.json"
	HistoryLimit = 60
)

type HistoryItem struct {
	Bvid     string  `json:"bvid"`
	Title    string  `json:"title"`
	Pic      string  `json:"pic"`
	Position float64 `json:"position"`
	Duration float64 `json:"duration"`
	Updated  int64   `json:"updated"`
}

var (
	historyMu    sync.Mutex
	historyItems []HistoryItem
)

func loadHistory() {
	b, err := os.ReadFile(HistoryPath)
	if err != nil || len(b) == 0 {
		return
	}
	_ = json.Unmarshal(b, &historyItems)
}

func saveHistoryLocked() {
	b, err := json.Marshal(historyItems)
	if err != nil {
		return
	}
	tmp := HistoryPath + ".tmp"
	if err := os.WriteFile(tmp, b, 0644); err == nil {
		_ = os.Rename(tmp, HistoryPath)
	}
}

// handleHistoryAdd 记录/更新一条观看历史（同一 bvid 只保留一条，移到最前）。
func handleHistoryAdd(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	bvid := q.Get("bvid")
	if bvid == "" || !validBVID(bvid) {
		jsonError(w, "bad bvid", 400)
		return
	}
	title := q.Get("title")
	pic := q.Get("pic")
	pos, _ := strconv.ParseFloat(q.Get("position"), 64)
	dur, _ := strconv.ParseFloat(q.Get("duration"), 64)
	now := time.Now().Unix()

	historyMu.Lock()
	idx := -1
	for i := range historyItems {
		if historyItems[i].Bvid == bvid {
			idx = i
			break
		}
	}
	var item HistoryItem
	if idx >= 0 {
		item = historyItems[idx]
		historyItems = append(historyItems[:idx], historyItems[idx+1:]...)
	}
	item.Bvid = bvid
	if title != "" {
		item.Title = title
	}
	if pic != "" {
		item.Pic = pic
	}
	if pos > 0 {
		item.Position = pos
	}
	if dur > 0 {
		item.Duration = dur
	}
	item.Updated = now
	historyItems = append([]HistoryItem{item}, historyItems...)
	if len(historyItems) > HistoryLimit {
		historyItems = historyItems[:HistoryLimit]
	}
	saveHistoryLocked()
	count := len(historyItems)
	historyMu.Unlock()

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{"ok": true, "count": count})
}

func handleHistoryList(w http.ResponseWriter, r *http.Request) {
	historyMu.Lock()
	out := append([]HistoryItem{}, historyItems...)
	historyMu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{"items": out})
}

func handleHistoryClear(w http.ResponseWriter, r *http.Request) {
	historyMu.Lock()
	historyItems = nil
	saveHistoryLocked()
	historyMu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte(`{"ok":true}`))
}
