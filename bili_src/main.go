package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

const (
	Version     = "3.0.1"
	Port        = 18080
	UserAgent   = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
	BiliReferer = "https://www.bilibili.com/"
	CoverDir    = "/userdisk/secondary/miniapp/data/mini_app/pkg/9002000869905604/data/covers"
	CookieFile  = "/userdisk/bili_cookie.txt"
	FeedCacheFile = "/userdisk/bili_feed_cache.json"
	TinymixPath = "/usr/bin/tinymix"
	FFmpegPath  = "/usr/bin/ffmpeg"
	ChrtPath    = "/usr/bin/chrt"

	StreamIdleTimeout = 45 * time.Second
	PlayURLCacheTTL   = 10 * time.Minute
	CacheDir          = "/userdisk/bili_cache"
	CacheCapBytes     = int64(600 << 20)
	PrefetchMinBytes  = int64(256 << 10)
	PrefetchWaitMax   = 1500 * time.Millisecond
	SpoolRangeWaitMax = 2 * time.Second
	PrefetchPlayingRate = int64(512 << 10)
	AudioIdleTimeout  = 30 * time.Second
	CacheMaxAgeSecond = int64(7 * 24 * 3600)
)

func writeJSON(w http.ResponseWriter, code int, v interface{}) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func jsonError(w http.ResponseWriter, msg string, code int) {
	writeJSON(w, code, map[string]interface{}{"error": msg, "code": code})
}

type VideoItem struct {
	Bvid     string `json:"bvid"`
	Mid      int64  `json:"mid,omitempty"` // 搜索结果里的 UP 主条目用它
	Title    string `json:"title"`
	Pic      string `json:"pic"`
	PicLocal string `json:"pic_local"`
	Owner    string `json:"owner"`
	Duration int    `json:"duration"`
}

type PlayStatus struct {
	Playing  bool   `json:"playing"`
	Bvid     string `json:"bvid"`
	Title    string `json:"title"`
	Mode     string `json:"mode"`
	Volume   int    `json:"volume"`
	HwVolume int    `json:"hw_volume"`
}

var (
	startedAt    = time.Now()
	streamStalls int64

	mu          sync.Mutex
	sessionOn   bool
	currentBvid string
	currentName string
	currentMode string

	lastActivityAtomic int64
)

func updateActivity() {
	atomic.StoreInt64(&lastActivityAtomic, time.Now().Unix())
}

func isScreenOn() bool {
	if b, err := os.ReadFile("/sys/class/backlight/backlight/brightness"); err == nil {
		val := strings.TrimSpace(string(b))
		if val != "" && val != "0" {
			return true
		}
	}
	data, err := os.ReadFile("/tmp/.screen_state")
	if err == nil && strings.Contains(string(data), "screen_on=1") {
		return true
	}
	return false
}

func idleWatchdog(server *http.Server) {
	updateActivity()
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for range ticker.C {
		if playbackActive() || downloadActive() {
			updateActivity()
			continue
		}
		if isScreenOn() {
			updateActivity()
			continue
		}
		last := atomic.LoadInt64(&lastActivityAtomic)
		idleDuration := time.Since(time.Unix(last, 0))
		if idleDuration > 20*time.Minute {
			log.Printf("[BiliDaemon] idle for %v without requests and screen off. Exiting to save battery...", idleDuration)
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			_ = server.Shutdown(ctx)
			cancel()
			os.Exit(0)
		}
	}
}

func handlePing(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"status":  "ok",
		"version": Version,
		"pid":     os.Getpid(),
		"uptime":  time.Since(startedAt).Truncate(time.Second).String(),
	})
}

func handleStatus(w http.ResponseWriter, r *http.Request) {
	mu.Lock()
	playing := sessionOn
	bvid, name, mode := currentBvid, currentName, currentMode
	mu.Unlock()

	vol := getSystemVolume()
	hwVol := mapSysVolToHw(vol)
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(PlayStatus{
		Playing:  playing,
		Bvid:     bvid,
		Title:    name,
		Mode:     mode,
		Volume:   vol,
		HwVolume: hwVol,
	})
}

func handlePlay(w http.ResponseWriter, r *http.Request) {
	bvid := r.URL.Query().Get("bvid")
	title := r.URL.Query().Get("title")
	mode := r.URL.Query().Get("mode")
	if mode == "" {
		mode = "video"
	}
	if bvid == "" {
		jsonError(w, "missing bvid", 400)
		return
	}
	if !validBVID(bvid) {
		jsonError(w, "invalid bvid", 400)
		return
	}

	mu.Lock()
	wasOn := sessionOn
	currentBvid = bvid
	currentName = title
	currentMode = mode
	sessionOn = true
	mu.Unlock()

	if !wasOn {
		initHardwareAudio()
	}
	log.Printf("[BiliDaemon] playback session start: %s mode=%s (%s)", bvid, mode, title)

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{"status": "playing", "mode": mode, "version": Version})
}

func handleStop(w http.ResponseWriter, r *http.Request) {
	mu.Lock()
	sessionOn = false
	currentBvid = ""
	currentName = ""
	currentMode = ""
	mu.Unlock()

	cancelActiveAudio()
	cancelAllStreams()
	cancelAllSpool()

	log.Printf("[BiliDaemon] playback session stop")
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{"status": "stopped"})
}

func playbackActive() bool {
	mu.Lock()
	defer mu.Unlock()
	return sessionOn
}

func playbackActiveBvid() string {
	mu.Lock()
	defer mu.Unlock()
	return currentBvid
}

func findMiniappPID() int {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return 0
	}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		_, perr := strconv.Atoi(e.Name())
		if perr != nil {
			continue
		}
		b, rerr := os.ReadFile("/proc/" + e.Name() + "/cmdline")
		if rerr != nil {
			continue
		}
		if strings.TrimRight(string(b), "\x00") == "/usr/bin/miniapp" {
			pid, _ := strconv.Atoi(e.Name())
			return pid
		}
	}
	return 0
}

func procCPU(pid int) (int64, int64, bool) {
	return procCPUPath(fmt.Sprintf("/proc/%d/stat", pid))
}

func threadCPU(pid, tid int) (int64, int64, bool) {
	return procCPUPath(fmt.Sprintf("/proc/%d/task/%d/stat", pid, tid))
}

func procCPUPath(path string) (int64, int64, bool) {
	b, err := os.ReadFile(path)
	if err != nil {
		return 0, 0, false
	}
	s := string(b)
	i := strings.LastIndexByte(s, ')')
	if i < 0 {
		return 0, 0, false
	}
	f := strings.Fields(s[i+2:])
	if len(f) < 13 {
		return 0, 0, false
	}
	ut, e1 := strconv.ParseInt(f[11], 10, 64)
	st, e2 := strconv.ParseInt(f[12], 10, 64)
	if e1 != nil || e2 != nil {
		return 0, 0, false
	}
	return ut, st, true
}

func loadAvg1() string {
	b, err := os.ReadFile("/proc/loadavg")
	if err != nil {
		return "?"
	}
	if f := strings.Fields(string(b)); len(f) > 0 {
		return f[0]
	}
	return "?"
}

func startCPULogger() {
	go func() {
		prev := map[string][2]int64{}
		var prevU, prevS int64
		var lastT time.Time
		for {
			time.Sleep(2 * time.Second)
			if !playbackActive() {
				prev = map[string][2]int64{}
				lastT = time.Time{}
				time.Sleep(10 * time.Second)
				continue
			}
			pid := findMiniappPID()
			if pid == 0 {
				continue
			}
			now := time.Now()
			cur := map[string][2]int64{}
			tasks, err := os.ReadDir(fmt.Sprintf("/proc/%d/task", pid))
			if err != nil {
				continue
			}
			for _, t := range tasks {
				tid, e := strconv.Atoi(t.Name())
				if e != nil {
					continue
				}
				b, rerr := os.ReadFile(fmt.Sprintf("/proc/%d/task/%d/comm", pid, tid))
				if rerr != nil {
					continue
				}
				name := strings.TrimSpace(string(b))
				tu, ts, tok := threadCPU(pid, tid)
				if !tok {
					continue
				}
				old := cur[name]
				cur[name] = [2]int64{old[0] + tu, old[1] + ts}
			}
			totalU, totalS, tok := procCPU(pid)
			if !tok {
				continue
			}
			if !lastT.IsZero() && now.Sub(lastT) > time.Second {
				dt := now.Sub(lastT).Seconds()
				pct := func(name string) float64 {
					a, b := cur[name], prev[name]
					return float64((a[0]-b[0])+(a[1]-b[1])) / 100.0 / dt * 100.0
				}
				type kv struct {
					n string
					v float64
				}
				var list []kv
				for n := range cur {
					list = append(list, kv{n, pct(n)})
				}
				for i := 0; i < len(list); i++ {
					for j := i + 1; j < len(list); j++ {
						if list[j].v > list[i].v {
							list[i], list[j] = list[j], list[i]
						}
					}
				}
				if len(list) > 3 {
					list = list[:3]
				}
				detail := ""
				for _, it := range list {
					detail += fmt.Sprintf(" %s=%.0f%%", it.n, it.v)
				}
				total := float64((totalU-prevU)+(totalS-prevS)) / 100.0 / dt * 100.0
				log.Printf("[BiliDaemon] playback cpu: total=%.0f%% load=%s top:%s", total, loadAvg1(), detail)
			}
			prev = cur
			prevU, prevS = totalU, totalS
			lastT = now
		}
	}()
}

func handleMetrics(w http.ResponseWriter, r *http.Request) {
	load1 := ""
	if b, err := os.ReadFile("/proc/loadavg"); err == nil {
		if f := strings.Fields(string(b)); len(f) > 0 {
			load1 = f[0]
		}
	}
	memFree := int64(0)
	if b, err := os.ReadFile("/proc/meminfo"); err == nil {
		for _, line := range strings.Split(string(b), "\n") {
			if strings.HasPrefix(line, "MemAvailable:") {
				_, _ = fmt.Sscanf(line, "MemAvailable: %d kB", &memFree)
			}
		}
	}

	spoolMu.Lock()
	list := make([]map[string]interface{}, 0, len(spools))
	for _, s := range spools {
		s.mu.Lock()
		list = append(list, map[string]interface{}{
			"bvid": s.bvid, "have": s.have, "total": s.total, "done": s.done,
		})
		s.mu.Unlock()
	}
	spoolMu.Unlock()

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"version":          Version,
		"uptime":           time.Since(startedAt).Truncate(time.Second).String(),
		"load1":            load1,
		"mem_available_kb": memFree,
		"spools":           list,
		"counters": map[string]int64{
			"stream_bytes":    atomic.LoadInt64(&streamBytes),
			"audio_bytes":     atomic.LoadInt64(&audioBytes),
			"cache_fallbacks": atomic.LoadInt64(&cacheFallbacks),
			"stream_stalls":   atomic.LoadInt64(&streamStalls),
			"cache_hits":      atomic.LoadInt64(&cacheHits),
		},
	})
}

// closeInheritedFDs 关闭从 miniapp 宿主继承的设备/字体 fd。
// daemon 由前端 shell 拉起，会继承 miniapp 已打开的 /dev/snd/pcmC0D0p、
// /dev/input/*、字体等 fd。PCM 被 daemon 持住后，vendor 播放器 open 会返回 -5，
// 表现为「没声音」；同时音频时钟不推进，同步控制器会不停 fast catch-up，画面显卡。
func closeInheritedFDs() {
	entries, err := os.ReadDir("/proc/self/fd")
	if err != nil {
		return
	}
	for _, e := range entries {
		var fd int
		if _, err := fmt.Sscanf(e.Name(), "%d", &fd); err != nil || fd <= 2 {
			continue
		}
		target, err := os.Readlink("/proc/self/fd/" + e.Name())
		if err != nil {
			continue
		}
		if strings.HasPrefix(target, "/dev/snd/") ||
			strings.HasPrefix(target, "/dev/input/") ||
			strings.Contains(target, "/miniapp/resources/fonts/") {
			_ = syscall.Close(fd)
			log.Printf("[BiliDaemon] closed inherited fd %d -> %s", fd, target)
		}
	}
}

func main() {
	closeInheritedFDs()
	_ = os.MkdirAll(CoverDir, 0755)
	loadHistory()
	loadDownloads()
	initFeedCache()
	log.Printf("[BiliDaemon] Starting v%s on 127.0.0.1:%d ...", Version, Port)

	go cleanCache()
	go startCPULogger()
	initHardwareAudio()
	go volumeSyncLoop()

	mux := http.NewServeMux()
	mux.HandleFunc("/api/ping", handlePing)
	mux.HandleFunc("/api/health", handlePing)
	mux.HandleFunc("/api/feed", handleFeed)
	mux.HandleFunc("/api/trending", handleTrending)
	mux.HandleFunc("/api/search", handleSearch)
	mux.HandleFunc("/api/play", handlePlay)
	mux.HandleFunc("/api/stream", handleStream)
	mux.HandleFunc("/api/stream/status", handleStreamStatus)
	mux.HandleFunc("/api/stop", handleStop)
	mux.HandleFunc("/api/status", handleStatus)
	mux.HandleFunc("/api/detail", handleDetail)
	mux.HandleFunc("/api/audio", handleAudio)
	mux.HandleFunc("/api/alsa/ready", handleALSAReady)
	mux.HandleFunc("/api/metrics", handleMetrics)
	mux.HandleFunc("/api/volume", handleVolume)
	mux.HandleFunc("/api/history", handleHistoryList)
	mux.HandleFunc("/api/history/add", handleHistoryAdd)
	mux.HandleFunc("/api/history/clear", handleHistoryClear)
	mux.HandleFunc("/api/proxy/cover", handleProxyCover)

	// Download
	mux.HandleFunc("/api/download/start", handleDownloadStart)
	mux.HandleFunc("/api/download/list", handleDownloadList)
	mux.HandleFunc("/api/download/status", handleDownloadStatus)
	mux.HandleFunc("/api/download/pause", handleDownloadPause)
	mux.HandleFunc("/api/download/delete", handleDownloadDelete)

	// Cache（只清 /userdisk/bili_cache，不动离线下载）
	mux.HandleFunc("/api/cache/list", handleCacheList)
	mux.HandleFunc("/api/cache/delete", handleCacheDelete)
	mux.HandleFunc("/api/cache/clear", handleCacheClear)

	// User & Login
	mux.HandleFunc("/api/user/info", handleUserInfo)
	mux.HandleFunc("/api/login/qr", handleLoginQr)
	mux.HandleFunc("/api/login/poll", handleLoginPoll)
	mux.HandleFunc("/api/login/logout", handleLogout)
	mux.HandleFunc("/api/login/state", handleLoginState)
	mux.HandleFunc("/api/parts", handleParts)
	mux.HandleFunc("/api/selectcid", handleSelectCid)
	mux.HandleFunc("/api/related", handleRelated)
	mux.HandleFunc("/api/comments", handleComments)
	mux.HandleFunc("/api/action/relation", handleActionRelation)
	mux.HandleFunc("/api/action/like", handleActionLike)
	mux.HandleFunc("/api/action/coin", handleActionCoin)
	mux.HandleFunc("/api/action/fav", handleActionFav)
	mux.HandleFunc("/api/fav/folders", handleFavFolders)
	mux.HandleFunc("/api/fav/items", handleFavItems)
	mux.HandleFunc("/api/history/cloud", handleCloudHistory)
	mux.HandleFunc("/api/toview/add", handleToviewAdd)
	mux.HandleFunc("/api/share/qr", handleShareQr)

	wrappedHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		updateActivity()
		mux.ServeHTTP(w, r)
	})

	server := &http.Server{
		Addr:              fmt.Sprintf("127.0.0.1:%d", Port),
		Handler:           wrappedHandler,
		ReadHeaderTimeout: 10 * time.Second,
	}

	go idleWatchdog(server)
	go fetchWbiKeys()
	go func() {
		ticker := time.NewTicker(10 * time.Minute)
		defer ticker.Stop()
		for range ticker.C {
			cleanCache()
		}
	}()

	log.Printf("[BiliDaemon] listening, tinymix=%s coverDir=%s", TinymixPath, CoverDir)
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("[BiliDaemon] server error: %v", err)
	}
}
