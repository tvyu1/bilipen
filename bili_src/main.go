package main

import (
	"bytes"
	"context"
	"crypto/md5"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
	"unsafe"

	qrcode "github.com/skip2/go-qrcode"
)

const (
	Version     = "2.4.2"

	Port        = 18080
	VctlShmKey  = 0x7663746c // 'vctl' SysV shared memory
	UserAgent   = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
	BiliReferer = "https://www.bilibili.com/"
	CoverDir    = "/userdisk/secondary/miniapp/data/mini_app/pkg/9002000869905604/data/covers"
	CookieFile  = "/userdisk/bili_cookie.txt"
	TinymixPath = "/usr/bin/tinymix"
	FFmpegPath  = "/usr/bin/ffmpeg"
	// 流式代理的空闲超时：超过该时间没有收到上游数据则主动断开，避免长视频被整体超时截断。
	StreamIdleTimeout = 45 * time.Second
	// playurl 缓存有效期，减少 seek/重复起播时的 B 站接口调用（也降低风控概率）。
	PlayURLCacheTTL = 10 * time.Minute
	// 播放缓存：详情页打开即后台预取整段 MP4，/api/stream 优先读本地文件，网络抖动不再传导到解码器。
	CacheDir         = "/userdisk/bili_cache"
	CacheCapBytes    = int64(600 << 20)
	PrefetchMinBytes = int64(256 << 10)
	PrefetchWaitMax  = 1500 * time.Millisecond
	// Range 请求等待本地缓存的时长：spool 可能排队在其它下载后面（并发上限 2），
	// 等太久会让视频流迟迟没有数据（表现为只有声音、画面黑几十秒）。
	// 这里只短暂等待，拿不到就立即回退直连代理，spool 继续在后台补缓存。
	SpoolRangeWaitMax = 2 * time.Second
	// 播放中把后台预取限速到该速率，避免 HTTPS 解密+写盘与单核解码抢 CPU。
	PrefetchPlayingRate = int64(512 << 10)
	AudioIdleTimeout    = 30 * time.Second
	CacheMaxAgeSecond   = int64(7 * 24 * 3600)
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
	Title    string `json:"title"`
	Pic      string `json:"pic"`
	PicLocal string `json:"pic_local"`
	Owner    string `json:"owner"`
	Duration int    `json:"duration"`
}

type PlayStatus struct {
	Playing bool   `json:"playing"`
	Bvid    string `json:"bvid"`
	Title   string `json:"title"`
	Mode    string `json:"mode"`
	Volume  int    `json:"volume"`
}

type playEntry struct {
	url     string
	backups []string
	expire  time.Time
}

// metaEntry 是 view 接口的缓存结果：详情页、起播、音频解析共用，避免重复请求 B 站。
type metaEntry struct {
	cid      int64
	title    string
	owner    string
	pic      string
	desc     string
	duration int
	srcW     int
	srcH     int
	view     int64
	like     int64
	danmaku  int64
	expire   time.Time
}

type audioEntry struct {
	url     string
	backups []string
	id      int
	bw      int
	expire  time.Time
}

// spool 表示一段本地播放缓存：后台下载写入 .part，完成后改名；读取方按已有字节数等待。
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
}

var (
	metaMu    sync.Mutex
	metaCache = map[string]metaEntry{}

	audioCacheMu sync.Mutex
	audioCache   = map[string]audioEntry{}

	spoolMu sync.Mutex
	spools  = map[string]*spool{}

	// 预取下载限速：所有 spool 共享一个令牌桶，避免多条 HTTPS 下载同时抢单核。
	dlPaceMu sync.Mutex
	dlNext   time.Time

	// 同时最多 2 路预取，限制 TLS 解密与写盘并发。
	spoolSem = make(chan struct{}, 2)

	// 活跃媒体流：/api/stop 时统一取消，让播放器的解码线程尽快退出（否则 stop 会等网络读超时，声音拖尾）。
	streamMu     sync.Mutex
	streams      = map[int]context.CancelFunc{}
	streamNextID int

	// 验收用计数器（/api/metrics）
	streamBytes    int64
	audioBytes     int64
	cacheFallbacks int64
	streamStalls   int64
	cacheHits      int64
)

var (
	startedAt = time.Now()

	mu           sync.Mutex
	currentBvid  string
	currentName  string
	currentMode  string
	sessionOn    bool
	lastAlsaVol  = -1
	feedMu       sync.Mutex
	feedFreshIdx = 0
	lastFeedMu   sync.Mutex
	lastFeed     []VideoItem

	// 音量共享内存状态：失败后按指数退避，避免每 50ms 重试+刷日志。
	shmOK       bool
	shmAttempts int
	shmNextTry  time.Time

	playCacheMu sync.Mutex
	playCache   = map[string]playEntry{}

	// 封面下载并发上限，单核 A7 上避免 8~12 个 TLS 连接同时建立。
	coverSem = make(chan struct{}, 3)

	// API 请求客户端（B 站 Web 接口，短请求）
	apiClient = &http.Client{Timeout: 8 * time.Second}
)

// WBI 签名算法实现（防止 B 站接口命中 -412 风控）
var mixinKeyEncTab = []int{
	46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
	33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
	61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
	36, 20, 34, 44, 52,
}

var (
	wbiKeyMu      sync.RWMutex
	wbiMixinKey   string
	wbiKeyExpires time.Time
)

func getMixinKey(raw string) string {
	var sb strings.Builder
	for _, idx := range mixinKeyEncTab[:32] {
		if idx < len(raw) {
			sb.WriteByte(raw[idx])
		}
	}
	return sb.String()
}

func updateWbiKeysFromNav(imgURL, subURL string) {
	getFilename := func(u string) string {
		parts := strings.Split(u, "/")
		if len(parts) == 0 {
			return ""
		}
		fn := parts[len(parts)-1]
		return strings.TrimSuffix(fn, filepath.Ext(fn))
	}
	ik := getFilename(imgURL)
	sk := getFilename(subURL)
	if ik == "" || sk == "" {
		return
	}
	raw := ik + sk
	wbiKeyMu.Lock()
	wbiMixinKey = getMixinKey(raw)
	wbiKeyExpires = time.Now().Add(12 * time.Hour)
	wbiKeyMu.Unlock()
	log.Printf("[BiliDaemon] updated WBI mixin key")
}

func fetchWbiKeys() {
	req, err := http.NewRequest("GET", "https://api.bilibili.com/x/web-interface/nav", nil)
	if err != nil {
		return
	}
	req.Header.Set("User-Agent", UserAgent)
	req.Header.Set("Referer", BiliReferer)
	if c := loadCookie(); c != "" {
		req.Header.Set("Cookie", c)
	}
	resp, err := apiClient.Do(req)
	if err != nil {
		return
	}
	defer resp.Body.Close()
	var nav struct {
		Data struct {
			WbiImg struct {
				ImgURL string `json:"img_url"`
				SubURL string `json:"sub_url"`
			} `json:"wbi_img"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&nav); err == nil {
		if nav.Data.WbiImg.ImgURL != "" {
			updateWbiKeysFromNav(nav.Data.WbiImg.ImgURL, nav.Data.WbiImg.SubURL)
		}
	}
}

func signWbiQuery(params url.Values) string {
	wbiKeyMu.RLock()
	mixin := wbiMixinKey
	expires := wbiKeyExpires
	wbiKeyMu.RUnlock()

	if mixin == "" || time.Now().After(expires) {
		mixin = "ea1db137cde3a7e728246b3ebd12cbd0"
	}

	params.Set("wts", strconv.FormatInt(time.Now().Unix(), 10))

	keys := make([]string, 0, len(params))
	for k := range params {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	var parts []string
	r := strings.NewReplacer("!", "", "'", "", "(", "", ")", "", "*", "")
	for _, k := range keys {
		v := r.Replace(params.Get(k))
		parts = append(parts, url.QueryEscape(k)+"="+url.QueryEscape(v))
	}
	queryStr := strings.Join(parts, "&")
	hash := md5.Sum([]byte(queryStr + mixin))
	wRid := hex.EncodeToString(hash[:])
	return queryStr + "&w_rid=" + wRid
}

var (

	// 媒体流客户端：不设整体 Timeout（否则长视频必然被截断），
	// 只限制连接与响应头阶段，body 阶段用 StreamIdleTimeout 看门狗。
	streamClient = &http.Client{
		Transport: &http.Transport{
			Proxy:                 nil,
			DialContext:           (&net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
			MaxIdleConns:          8,
			MaxIdleConnsPerHost:   4,
			IdleConnTimeout:       60 * time.Second,
			ResponseHeaderTimeout: 15 * time.Second,
			DisableCompression:    true,
		},
	}
)

func cleanTitle(t string) string {
	t = strings.ReplaceAll(t, "<em class=\"keyword\">", "")
	t = strings.ReplaceAll(t, "</em>", "")
	t = strings.ReplaceAll(t, "&quot;", "\"")
	t = strings.ReplaceAll(t, "&amp;", "&")
	return t
}

func loadCookie() string {
	data, err := os.ReadFile(CookieFile)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(data))
}

// saveCookie 原子写入并收紧权限：避免半截文件与同机应用读取会话。
func saveCookie(c string) {
	c = strings.TrimSpace(c)
	if c == "" {
		log.Printf("[BiliDaemon] saveCookie skipped: empty cookie")
		return
	}
	if err := os.MkdirAll(filepath.Dir(CookieFile), 0700); err != nil {
		log.Printf("[BiliDaemon] mkdir cookie dir failed: %v", err)
		return
	}
	tmp := CookieFile + ".tmp"
	if err := os.WriteFile(tmp, []byte(c), 0600); err != nil {
		log.Printf("[BiliDaemon] write cookie tmp failed: %v", err)
		return
	}
	if err := os.Rename(tmp, CookieFile); err != nil {
		log.Printf("[BiliDaemon] rename cookie failed: %v", err)
		return
	}
	_ = os.Chmod(CookieFile, 0600)
}

func clearCookie() {
	if err := os.Remove(CookieFile); err == nil {
		log.Printf("[BiliDaemon] cookie cleared")
	}
}

// cacheCover 下载封面缩略图。并发受限、先写临时文件再改名，避免半截 JPEG 被永久缓存。
func cacheCover(bvid, picUrl string) string {
	if bvid == "" || picUrl == "" {
		return ""
	}
	if err := os.MkdirAll(CoverDir, 0755); err != nil && !os.IsExist(err) {
		return ""
	}
	localPath := filepath.Join(CoverDir, bvid+".jpg")
	if fi, err := os.Stat(localPath); err == nil && fi.Size() > 512 {
		return "covers/" + bvid + ".jpg"
	}

	thumbURL := picUrl
	if strings.HasPrefix(thumbURL, "//") {
		thumbURL = "https:" + thumbURL
	}
	if !strings.Contains(thumbURL, "@") {
		thumbURL += "@200w_120h.jpg"
	}

	coverSem <- struct{}{}
	defer func() { <-coverSem }()

	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "GET", thumbURL, nil)
	if err != nil {
		return ""
	}
	req.Header.Set("User-Agent", UserAgent)
	req.Header.Set("Referer", BiliReferer)
	resp, err := apiClient.Do(req)
	if err != nil {
		return ""
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return ""
	}
	if ct := resp.Header.Get("Content-Type"); ct != "" && !strings.HasPrefix(ct, "image/") {
		return ""
	}

	tmp := localPath + ".tmp"
	out, err := os.Create(tmp)
	if err != nil {
		return ""
	}
	n, copyErr := io.Copy(out, resp.Body)
	closeErr := out.Close()
	if copyErr != nil || closeErr != nil || n < 512 {
		_ = os.Remove(tmp)
		return ""
	}
	if err := os.Rename(tmp, localPath); err != nil {
		_ = os.Remove(tmp)
		return ""
	}
	return "covers/" + bvid + ".jpg"
}

// ---------------- 观看历史（持久化到 /userdisk/bili_history.json） ----------------

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


var lastActivityAtomic int64

func updateActivity() {
	atomic.StoreInt64(&lastActivityAtomic, time.Now().Unix())
}

func idleWatchdog(server *http.Server) {
	updateActivity()
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for range ticker.C {
		if playbackActive() {
			updateActivity()
			continue
		}
		last := atomic.LoadInt64(&lastActivityAtomic)
		idleDuration := time.Since(time.Unix(last, 0))
		if idleDuration > 5*time.Minute {
			log.Printf("[BiliDaemon] idle for %v without requests and not playing. Exiting to save battery...", idleDuration)
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			_ = server.Shutdown(ctx)
			cancel()
			os.Exit(0)
		}
	}
}

func handleHistoryClear(w http.ResponseWriter, r *http.Request) {
	historyMu.Lock()
	historyItems = nil
	saveHistoryLocked()
	historyMu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte(`{"ok":true}`))
}

func main() {
	_ = os.MkdirAll(CoverDir, 0755)
	loadHistory()
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
	mux.HandleFunc("/api/stop", handleStop)
	mux.HandleFunc("/api/status", handleStatus)
	mux.HandleFunc("/api/detail", handleDetail)
	mux.HandleFunc("/api/audio", handleAudio)
	mux.HandleFunc("/api/metrics", handleMetrics)
	mux.HandleFunc("/api/history", handleHistoryList)
	mux.HandleFunc("/api/history/add", handleHistoryAdd)
	mux.HandleFunc("/api/history/clear", handleHistoryClear)

	// User & Login
	mux.HandleFunc("/api/user/info", handleUserInfo)
	mux.HandleFunc("/api/login/qr", handleLoginQr)
	mux.HandleFunc("/api/login/poll", handleLoginPoll)
	mux.HandleFunc("/api/login/logout", handleLogout)

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

	if err := server.ListenAndServe(); err != nil {
		log.Fatalf("[BiliDaemon] Server failed: %v\n", err)
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
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(PlayStatus{
		Playing: playing,
		Bvid:    bvid,
		Title:   name,
		Mode:    mode,
		Volume:  vol,
	})
}

func handleUserInfo(w http.ResponseWriter, r *http.Request) {
	cookie := loadCookie()
	if cookie == "" {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{"logged_in": false})
		return
	}

	req, _ := http.NewRequest("GET", "https://api.bilibili.com/x/web-interface/nav", nil)
	req.Header.Set("User-Agent", UserAgent)
	req.Header.Set("Referer", BiliReferer)
	req.Header.Set("Cookie", cookie)

	client := apiClient
	resp, err := client.Do(req)
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"logged_in": false, "error": err.Error()})
		return
	}
	defer resp.Body.Close()

	var nav struct {
		Code int `json:"code"`
		Data struct {
			IsLogin bool   `json:"isLogin"`
			Uname   string `json:"uname"`
			Mid     int64  `json:"mid"`
			Face    string `json:"face"`
			WbiImg  struct {
				ImgURL string `json:"img_url"`
				SubURL string `json:"sub_url"`
			} `json:"wbi_img"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&nav); err != nil {
		// 解析失败（网络抖动/上游 HTML 错误页）不代表登录失效，保留 Cookie。
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"logged_in": false, "error": "decode nav: " + err.Error()})
		return
	}

	if nav.Data.WbiImg.ImgURL != "" {
		updateWbiKeysFromNav(nav.Data.WbiImg.ImgURL, nav.Data.WbiImg.SubURL)
	}

	w.Header().Set("Content-Type", "application/json")
	if nav.Code == -101 {
		// 只有明确“未登录/凭证过期”才清除本地 Cookie。
		clearCookie()
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"logged_in": false})
		return
	}
	if nav.Code != 0 || !nav.Data.IsLogin {
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"logged_in": false, "error": fmt.Sprintf("nav code=%d", nav.Code)})
		return
	}

	json.NewEncoder(w).Encode(map[string]interface{}{
		"logged_in": true,
		"uname":     nav.Data.Uname,
		"mid":       nav.Data.Mid,
		"face":      nav.Data.Face,
	})
}

func handleLoginQr(w http.ResponseWriter, r *http.Request) {
	req, err := http.NewRequestWithContext(r.Context(), "GET", "https://passport.bilibili.com/x/passport-login/web/qrcode/generate", nil)
	if err != nil {
		jsonError(w, err.Error(), 500)
		return
	}
	req.Header.Set("User-Agent", UserAgent)
	resp, err := apiClient.Do(req)
	if err != nil {
		jsonError(w, err.Error(), 500)
		return
	}
	defer resp.Body.Close()

	var res struct {
		Code int `json:"code"`
		Data struct {
			Url       string `json:"url"`
			QrcodeKey string `json:"qrcode_key"`
		} `json:"data"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&res)

	if res.Data.Url == "" {
		http.Error(w, "Failed to get QR url", 500)
		return
	}

	// Clean up old login qr files
	oldQrs, _ := filepath.Glob(filepath.Join(CoverDir, "qr_*.png"))
	for _, oldf := range oldQrs {
		_ = os.Remove(oldf)
	}

	qrName := fmt.Sprintf("qr_%d.png", time.Now().Unix())
	qrPath := fmt.Sprintf("%s/%s", CoverDir, qrName)
	err = qrcode.WriteFile(res.Data.Url, qrcode.Medium, 120, qrPath)
	if err != nil {
		jsonError(w, err.Error(), 500)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"qrcode_key": res.Data.QrcodeKey,
		"qr_path":    "covers/" + qrName,
	})
}

func handleLoginPoll(w http.ResponseWriter, r *http.Request) {
	key := r.URL.Query().Get("qrcode_key")
	if key == "" {
		http.Error(w, "missing qrcode_key", 400)
		return
	}

	pollUrl := fmt.Sprintf("https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=%s", url.QueryEscape(key))
	req, err := http.NewRequestWithContext(r.Context(), "GET", pollUrl, nil)
	if err != nil {
		jsonError(w, err.Error(), 500)
		return
	}
	req.Header.Set("User-Agent", UserAgent)
	resp, err := apiClient.Do(req)
	if err != nil {
		jsonError(w, err.Error(), 502)
		return
	}
	defer resp.Body.Close()

	var res struct {
		Code int `json:"code"`
		Data struct {
			Code         int    `json:"code"`
			Message      string `json:"message"`
			Url          string `json:"url"`
			RefreshToken string `json:"refresh_token"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&res); err != nil {
		http.Error(w, "decode poll: "+err.Error(), 502)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	if res.Data.Code == 0 {
		// B 站扫码成功后，SESSDATA/bili_jct/DedeUserID 等凭证放在 data.url 的 query 参数里，
		// 同时可能通过 Set-Cookie 下发。两条来源都收集，避免写入空 Cookie 覆盖已有登录态。
		jar := map[string]string{}
		if u, perr := url.Parse(res.Data.Url); perr == nil && u != nil {
			for k, vs := range u.Query() {
				if len(vs) > 0 && vs[0] != "" {
					jar[k] = vs[0]
				}
			}
		}
		for _, c := range resp.Cookies() {
			if c.Name != "" && c.Value != "" {
				jar[c.Name] = c.Value
			}
		}
		parts := make([]string, 0, len(jar))
		for k, v := range jar {
			parts = append(parts, k+"="+v)
		}
		cookieStr := strings.Join(parts, "; ")
		if cookieStr == "" {
			log.Printf("[BiliDaemon] login poll success but no cookie found (url=%q)", res.Data.Url)
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"status": "error", "code": -1, "message": "登录成功但未获取到凭证，请重试", "logged_in": false,
			})
			return
		}
		saveCookie(cookieStr)
		if res.Data.RefreshToken != "" {
			_ = os.WriteFile(CookieFile+".refresh", []byte(res.Data.RefreshToken), 0600)
		}
		log.Printf("[BiliDaemon] login success, cookie fields=%d", len(jar))
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"status": "success", "code": 0, "message": "登录成功", "logged_in": true,
		})
		return
	}

	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"status":    "waiting",
		"code":      res.Data.Code,
		"message":   res.Data.Message,
		"logged_in": false,
	})
}

func handleLogout(w http.ResponseWriter, r *http.Request) {
	clearCookie()
	_ = os.Remove(CookieFile + ".refresh")
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{"status": "logged_out"})
}

func handleFeed(w http.ResponseWriter, r *http.Request) {
	feedMu.Lock()
	feedFreshIdx++
	currentFresh := feedFreshIdx
	feedMu.Unlock()

	params := url.Values{}
	params.Set("ps", "8")
	params.Set("fresh_type", "3")
	params.Set("fresh_idx", strconv.Itoa(currentFresh))
	signedQuery := signWbiQuery(params)
	apiUrl := "https://api.bilibili.com/x/web-interface/wbi/index/top/feed/rcmd?" + signedQuery
	req, err := http.NewRequest("GET", apiUrl, nil)
	if err != nil {
		jsonError(w, err.Error(), 500)
		return
	}
	req.Header.Set("User-Agent", UserAgent)
	req.Header.Set("Referer", BiliReferer)
	cookie := loadCookie()
	if cookie != "" {
		req.Header.Set("Cookie", cookie)
	}

	client := &http.Client{Timeout: 8 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		log.Printf("[BiliDaemon] feed upstream error: %v", err)
		if serveCachedFeed(w) {
			return
		}
		jsonError(w, err.Error(), 502)
		return
	}
	defer resp.Body.Close()

	var raw struct {
		Code int `json:"code"`
		Data struct {
			Item []struct {
				Bvid     string `json:"bvid"`
				Title    string `json:"title"`
				Pic      string `json:"pic"`
				Duration int    `json:"duration"`
				Owner    struct {
					Name string `json:"name"`
				} `json:"owner"`
			} `json:"item"`
		} `json:"data"`
	}

	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		log.Printf("[BiliDaemon] feed decode error: %v", err)
		if serveCachedFeed(w) {
			return
		}
		jsonError(w, err.Error(), 500)
		return
	}

	items := make([]VideoItem, 0, len(raw.Data.Item))
	for _, it := range raw.Data.Item {
		if it.Bvid == "" || it.Title == "" {
			continue
		}
		items = append(items, VideoItem{
			Bvid:     it.Bvid,
			Title:    cleanTitle(it.Title),
			Pic:      it.Pic,
			Owner:    it.Owner.Name,
			Duration: it.Duration,
		})
	}

	if len(items) == 0 {
		if serveCachedFeed(w) {
			return
		}
		jsonError(w, "empty feed", 502)
		return
	}
	// 封面异步缓存：首屏不能等 8 张封面下载完，否则前端 8s 超时会直接报错。
	go cacheCoversAsync(items)
	feedCacheSet(items)

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	json.NewEncoder(w).Encode(items)
}

// findMiniappPID 返回 miniapp 宿主进程 pid（cmdline 为 /usr/bin/miniapp）。
func findMiniappPID() int {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return 0
	}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		pid, perr := strconv.Atoi(e.Name())
		if perr != nil {
			continue
		}
		b, rerr := os.ReadFile("/proc/" + e.Name() + "/cmdline")
		if rerr != nil {
			continue
		}
		if strings.TrimRight(string(b), "\x00") == "/usr/bin/miniapp" {
			return pid
		}
	}
	return 0
}

// procCPU 读取进程 utime/stime（USER_HZ=100）。
func procCPU(pid int) (int64, int64, bool) {
	return procCPUPath(fmt.Sprintf("/proc/%d/stat", pid))
}

// threadCPU 读取线程 utime/stime（必须走 /proc/<pid>/task/<tid>/stat）。
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

// startCPULogger 在播放期间每 2s 记录 miniapp 进程与热点线程组的 CPU 占用。
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
				sort.Slice(list, func(i, j int) bool { return list[i].v > list[j].v })
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

// cacheCoversAsync 在后台串行触发封面缓存（cacheCover 内部已限并发 3）。
func cacheCoversAsync(items []VideoItem) {
	var wg sync.WaitGroup
	for i := range items {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			_ = cacheCover(items[idx].Bvid, items[idx].Pic)
		}(i)
	}
	wg.Wait()
}

// serveCachedFeed 在上游抖动时返回上一次成功的推荐列表，避免首页空白。
func serveCachedFeed(w http.ResponseWriter) bool {
	lastFeedMu.Lock()
	items := lastFeed
	lastFeedMu.Unlock()
	if len(items) == 0 {
		return false
	}
	log.Printf("[BiliDaemon] feed: serve cached %d items", len(items))
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(items)
	return true
}

func feedCacheSet(items []VideoItem) {
	lastFeedMu.Lock()
	lastFeed = items
	lastFeedMu.Unlock()
}

func handleTrending(w http.ResponseWriter, r *http.Request) {
	req, _ := http.NewRequest("GET", "https://api.bilibili.com/x/web-interface/search/square?limit=8", nil)
	req.Header.Set("User-Agent", UserAgent)
	req.Header.Set("Referer", BiliReferer)
	client := &http.Client{Timeout: 4 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		json.NewEncoder(w).Encode([]string{"科技", "原神", "动画", "音乐", "游戏", "美食"})
		return
	}
	defer resp.Body.Close()

	var sq struct {
		Code int `json:"code"`
		Data struct {
			Trending struct {
				List []struct {
					Keyword  string `json:"keyword"`
					ShowName string `json:"show_name"`
				} `json:"list"`
			} `json:"trending"`
		} `json:"data"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&sq)

	var list []string
	for _, item := range sq.Data.Trending.List {
		kw := item.Keyword
		if kw == "" {
			kw = item.ShowName
		}
		if kw != "" {
			list = append(list, kw)
		}
		if len(list) >= 8 {
			break
		}
	}
	if len(list) == 0 {
		list = []string{"科技", "原神", "动画", "音乐", "游戏", "美食"}
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	json.NewEncoder(w).Encode(list)
}

func handleSearch(w http.ResponseWriter, r *http.Request) {
	kw := r.URL.Query().Get("keyword")
	if kw == "" {
		jsonError(w, "missing keyword", 400)
		return
	}

	params := url.Values{}
	params.Set("keyword", kw)
	signedQuery := signWbiQuery(params)
	searchUrl := "https://api.bilibili.com/x/web-interface/wbi/search/all/v2?" + signedQuery
	req, _ := http.NewRequest("GET", searchUrl, nil)
	req.Header.Set("User-Agent", UserAgent)
	req.Header.Set("Referer", BiliReferer)
	cookie := loadCookie()
	if cookie != "" {
		req.Header.Set("Cookie", cookie)
	}

	client := &http.Client{Timeout: 6 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		jsonError(w, err.Error(), 502)
		return
	}
	defer resp.Body.Close()

	var sdata struct {
		Code int `json:"code"`
		Data struct {
			Result []struct {
				ResultType string `json:"result_type"`
				Data       []struct {
					Bvid   string `json:"bvid"`
					Title  string `json:"title"`
					Pic    string `json:"pic"`
					Author string `json:"author"`
				} `json:"data"`
			} `json:"result"`
		} `json:"data"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&sdata)

	var items []VideoItem
	for _, resItem := range sdata.Data.Result {
		if resItem.ResultType == "video" {
			for _, v := range resItem.Data {
				if v.Bvid == "" || v.Title == "" {
					continue
				}
				pic := v.Pic
				if strings.HasPrefix(pic, "//") {
					pic = "https:" + pic
				}
				items = append(items, VideoItem{
					Bvid:  v.Bvid,
					Title: cleanTitle(v.Title),
					Pic:   pic,
					Owner: v.Author,
				})
				if len(items) >= 12 {
					break
				}
			}
		}
	}

	// 封面同样异步缓存，避免 12 张封面把搜索响应拖超时。
	go cacheCoversAsync(items)

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	json.NewEncoder(w).Encode(items)
}

var bvidRe = regexp.MustCompile(`^BV[0-9A-Za-z]{10}$`)

func validBVID(bvid string) bool { return bvidRe.MatchString(bvid) }

// resolveMeta 解析并缓存 view 接口元数据（cid/时长/源尺寸/标题/UP/封面/统计）。
// 详情页、起播、音频解析共用一份缓存，避免同一视频重复打 B 站接口。
func resolveMeta(bvid string) (metaEntry, error) {
	if !validBVID(bvid) {
		return metaEntry{}, fmt.Errorf("invalid bvid: %q", bvid)
	}
	metaMu.Lock()
	if e, ok := metaCache[bvid]; ok && time.Now().Before(e.expire) {
		metaMu.Unlock()
		return e, nil
	}
	metaMu.Unlock()

	req, err := http.NewRequest("GET", "https://api.bilibili.com/x/web-interface/view?bvid="+url.QueryEscape(bvid), nil)
	if err != nil {
		return metaEntry{}, err
	}
	req.Header.Set("User-Agent", UserAgent)
	req.Header.Set("Referer", BiliReferer)
	if cookie := loadCookie(); cookie != "" {
		req.Header.Set("Cookie", cookie)
	}
	resp, err := apiClient.Do(req)
	if err != nil {
		return metaEntry{}, err
	}
	defer resp.Body.Close()

	var vd struct {
		Code int `json:"code"`
		Data struct {
			Cid      int64  `json:"cid"`
			Title    string `json:"title"`
			Pic      string `json:"pic"`
			Desc     string `json:"desc"`
			Duration int    `json:"duration"`
			Owner    struct {
				Name string `json:"name"`
			} `json:"owner"`
			Stat struct {
				View    int64 `json:"view"`
				Like    int64 `json:"like"`
				Danmaku int64 `json:"danmaku"`
			} `json:"stat"`
			Dimension struct {
				Width  int `json:"width"`
				Height int `json:"height"`
				Rotate int `json:"rotate"`
			} `json:"dimension"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&vd); err != nil {
		return metaEntry{}, err
	}
	if vd.Data.Cid == 0 {
		return metaEntry{}, fmt.Errorf("cid not found for %s (code=%d)", bvid, vd.Code)
	}

	pic := vd.Data.Pic
	if strings.HasPrefix(pic, "//") {
		pic = "https:" + pic
	}
	w, h := vd.Data.Dimension.Width, vd.Data.Dimension.Height
	if w <= 0 || h <= 0 {
		w, h = 640, 360
	}
	entry := metaEntry{
		cid:      vd.Data.Cid,
		title:    cleanTitle(vd.Data.Title),
		owner:    vd.Data.Owner.Name,
		pic:      pic,
		desc:     vd.Data.Desc,
		duration: vd.Data.Duration,
		srcW:     w,
		srcH:     h,
		view:     vd.Data.Stat.View,
		like:     vd.Data.Stat.Like,
		danmaku:  vd.Data.Stat.Danmaku,
		expire:   time.Now().Add(PlayURLCacheTTL),
	}
	metaMu.Lock()
	metaCache[bvid] = entry
	metaMu.Unlock()
	return entry, nil
}

// resolveAudio 解析最高音质的 DASH 音频地址。B 站 dash.audio 常见 id：
// 30216=64k / 30232=132k / 30280=192k，取 bandwidth 最大的一路。
func resolveAudio(bvid string) (audioEntry, error) {
	if !validBVID(bvid) {
		return audioEntry{}, fmt.Errorf("invalid bvid: %q", bvid)
	}
	audioCacheMu.Lock()
	if e, ok := audioCache[bvid]; ok && time.Now().Before(e.expire) {
		audioCacheMu.Unlock()
		return e, nil
	}
	audioCacheMu.Unlock()

	meta, err := resolveMeta(bvid)
	if err != nil {
		return audioEntry{}, err
	}

	apiUrl := fmt.Sprintf("https://api.bilibili.com/x/player/playurl?bvid=%s&cid=%d&qn=80&fnval=4048&fourk=1",
		url.QueryEscape(bvid), meta.cid)
	req, err := http.NewRequest("GET", apiUrl, nil)
	if err != nil {
		return audioEntry{}, err
	}
	req.Header.Set("User-Agent", UserAgent)
	req.Header.Set("Referer", BiliReferer)
	if cookie := loadCookie(); cookie != "" {
		req.Header.Set("Cookie", cookie)
	}
	resp, err := apiClient.Do(req)
	if err != nil {
		return audioEntry{}, err
	}
	defer resp.Body.Close()

	var pd struct {
		Code int `json:"code"`
		Data struct {
			Dash struct {
				Audio []struct {
					Id        int      `json:"id"`
					BaseUrl   string   `json:"baseUrl"`
					BackupUrl []string `json:"backupUrl"`
					Bandwidth int      `json:"bandwidth"`
				} `json:"audio"`
			} `json:"dash"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&pd); err != nil {
		return audioEntry{}, err
	}
	var best struct {
		id  int
		bw  int
		url string
		bs  []string
	}
	for _, a := range pd.Data.Dash.Audio {
		if a.BaseUrl == "" {
			continue
		}
		if a.Bandwidth > best.bw {
			best.id, best.bw, best.url, best.bs = a.Id, a.Bandwidth, a.BaseUrl, a.BackupUrl
		}
	}
	if best.url == "" {
		return audioEntry{}, fmt.Errorf("no dash audio found for %s (code=%d)", bvid, pd.Code)
	}
	entry := audioEntry{url: best.url, backups: best.bs, id: best.id, bw: best.bw, expire: time.Now().Add(PlayURLCacheTTL)}
	audioCacheMu.Lock()
	audioCache[bvid] = entry
	audioCacheMu.Unlock()
	log.Printf("[BiliDaemon] resolved audio for %s: id=%d bw=%d backups=%d", bvid, entry.id, entry.bw, len(entry.backups))
	return entry, nil
}

// resolvePlayURL 解析 bvid 的可播放 MP4 地址（含 backup_url），带 10 分钟缓存。
// 缓存可显著减少 seek/重复起播时的上游接口调用，也降低触发风控的概率。
func resolvePlayURL(bvid string) (string, []string, error) {
	if !validBVID(bvid) {
		return "", nil, fmt.Errorf("invalid bvid: %q", bvid)
	}

	playCacheMu.Lock()
	if e, ok := playCache[bvid]; ok && time.Now().Before(e.expire) {
		playCacheMu.Unlock()
		return e.url, e.backups, nil
	}
	playCacheMu.Unlock()

	meta, err := resolveMeta(bvid)
	if err != nil {
		return "", nil, fmt.Errorf("meta: %w", err)
	}
	cookie := loadCookie()

	// 2. 取 360P 合并 MP4 流（html5 接口是单文件 durl，长视频不会被拆成多段）
	playApi := fmt.Sprintf("https://api.bilibili.com/x/player/playurl?bvid=%s&cid=%d&qn=16&type=mp4&platform=html5", url.QueryEscape(bvid), meta.cid)
	req2, err := http.NewRequest("GET", playApi, nil)
	if err != nil {
		return "", nil, err
	}
	req2.Header.Set("User-Agent", UserAgent)
	req2.Header.Set("Referer", BiliReferer)
	if cookie != "" {
		req2.Header.Set("Cookie", cookie)
	}

	resp2, err := apiClient.Do(req2)
	if err != nil {
		return "", nil, err
	}
	defer resp2.Body.Close()

	var pdata struct {
		Code int `json:"code"`
		Data struct {
			Durl []struct {
				Url       string   `json:"url"`
				BackupUrl []string `json:"backup_url"`
			} `json:"durl"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp2.Body).Decode(&pdata); err != nil {
		return "", nil, err
	}
	if len(pdata.Data.Durl) == 0 || pdata.Data.Durl[0].Url == "" {
		return "", nil, fmt.Errorf("no playurl found for %s (code=%d)", bvid, pdata.Code)
	}

	entry := playEntry{
		url:     pdata.Data.Durl[0].Url,
		backups: pdata.Data.Durl[0].BackupUrl,
		expire:  time.Now().Add(PlayURLCacheTTL),
	}
	playCacheMu.Lock()
	playCache[bvid] = entry
	playCacheMu.Unlock()
	log.Printf("[BiliDaemon] resolved playurl for %s (backups=%d)", bvid, len(entry.backups))
	return entry.url, entry.backups, nil
}

func openUpstream(ctx context.Context, streamURL string, r *http.Request) (*http.Response, error) {
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

// ---------------------------------------------------------------------------
// 播放缓存（spool）：详情页触发预取，/api/stream 优先读本地文件。
// 目的：把 CDN 抖动/首包延迟与应用层解码解耦，同时保留实时代理作为兜底。
// ---------------------------------------------------------------------------

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

	if err := os.MkdirAll(CacheDir, 0755); err != nil {
		return nil, err
	}
	// 先解析一次地址：失败时让上层回退实时代理，不把错误拖到播放阶段。
	if _, _, err := resolvePlayURL(bvid); err != nil {
		return nil, err
	}
	go cleanCache()
	s := newSpool(bvid, partPath, filePath)
	spoolMu.Lock()
	if old, ok := spools[bvid]; ok {
		spoolMu.Unlock()
		return old, nil
	}
	spools[bvid] = s
	spoolMu.Unlock()
	go downloadSpool(s)
	log.Printf("[BiliDaemon] spool start for %s", bvid)
	return s, nil
}

func downloadSpool(s *spool) {
	spoolSem <- struct{}{}
	defer func() { <-spoolSem }()

	primary, backups, err := resolvePlayURL(s.bvid)
	if err != nil {
		s.finish(err)
		return
	}
	candidates := append([]string{primary}, backups...)
	var lastErr error
	for i, u := range candidates {
		if i >= 3 {
			break
		}
		derr := s.downloadOne(u)
		if derr != nil {
			lastErr = derr
			log.Printf("[BiliDaemon] spool %s candidate %d failed: %v", s.bvid, i, derr)
			// 已经写进去的字节无法安全回滚（读端可能正在按偏移消费），不再换源重试。
			s.mu.Lock()
			partial := s.have
			s.mu.Unlock()
			if partial > 0 {
				break
			}
			continue
		}
		if rerr := os.Rename(s.partPath, s.filePath); rerr != nil {
			s.finish(rerr)
			log.Printf("[BiliDaemon] spool %s rename failed: %v", s.bvid, rerr)
			return
		}
		s.finish(nil)
		s.mu.Lock()
		size := s.have
		s.mu.Unlock()
		log.Printf("[BiliDaemon] spool %s done, %d bytes", s.bvid, size)
		return
	}
	if lastErr == nil {
		lastErr = errors.New("no candidate")
	}
	s.finish(lastErr)
}

func (s *spool) downloadOne(rawURL string) error {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "GET", rawURL, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", UserAgent)
	req.Header.Set("Referer", BiliReferer)
	if c := loadCookie(); c != "" {
		req.Header.Set("Cookie", c)
	}
	idle := time.AfterFunc(StreamIdleTimeout, cancel)
	defer idle.Stop()

	resp, err := streamClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusPartialContent {
		return fmt.Errorf("upstream status %d", resp.StatusCode)
	}
	if ct := strings.ToLower(resp.Header.Get("Content-Type")); strings.Contains(ct, "text/html") {
		return errors.New("upstream returned html error page")
	}
	if resp.ContentLength > 0 {
		s.mu.Lock()
		if s.total <= 0 {
			s.total = resp.ContentLength
		}
		s.mu.Unlock()
	}
	f, err := os.OpenFile(s.partPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0644)
	if err != nil {
		return err
	}
	defer f.Close()

	buf := make([]byte, 64*1024)
	for {
		n, rerr := resp.Body.Read(buf)
		if n > 0 {
			idle.Reset(StreamIdleTimeout)
			if _, werr := f.Write(buf[:n]); werr != nil {
				return werr
			}
			s.mu.Lock()
			s.have += int64(n)
			s.cond.Broadcast()
			s.mu.Unlock()
			paceDownload(n, s.bvid)
		}
		if rerr == io.EOF {
			return nil
		}
		if rerr != nil {
			return rerr
		}
	}
}

// paceDownload 全局限速：空闲 1MB/s；播放中当前视频 512KB/s，其它视频 64KB/s。
// 播放时把「别的视频」的预取压到很低，避免 TLS 解密+写盘与单核解码抢 CPU（表现为画面偶发卡顿）。
func paceDownload(n int, bvid string) {
	rate := int64(1 << 20)
	if active := playbackActiveBvid(); active != "" {
		if active == bvid {
			rate = PrefetchPlayingRate
		} else {
			rate = 64 << 10
		}
	}
	if rate <= 0 || n <= 0 {
		return
	}
	dlPaceMu.Lock()
	now := time.Now()
	if dlNext.Before(now) {
		dlNext = now
	}
	dlNext = dlNext.Add(time.Duration(float64(n) / float64(rate) * float64(time.Second)))
	target := dlNext
	dlPaceMu.Unlock()
	if d := time.Until(target); d > 0 {
		time.Sleep(d)
	}
}

// playbackActive 返回当前是否有播放会话（用于给后台预取限速）。
func playbackActive() bool {
	mu.Lock()
	defer mu.Unlock()
	return sessionOn
}

// playbackActiveBvid 返回当前播放的 bvid（无播放时为空）。
func playbackActiveBvid() string {
	mu.Lock()
	defer mu.Unlock()
	if !sessionOn {
		return ""
	}
	return currentBvid
}

func (s *spool) finish(err error) {
	s.mu.Lock()
	s.done = true
	s.err = err
	if s.total <= 0 {
		s.total = s.have
	}
	s.cond.Broadcast()
	s.mu.Unlock()
}

// waitFor 等待缓存至少积累 n 字节；返回 true 表示可以继续（够了或下载已结束）。
func (s *spool) waitFor(n int64, d time.Duration) bool {
	deadline := time.Now().Add(d)
	timer := time.AfterFunc(d, func() {
		s.mu.Lock()
		s.cond.Broadcast()
		s.mu.Unlock()
	})
	defer timer.Stop()

	s.mu.Lock()
	defer s.mu.Unlock()
	for s.have < n && !s.done {
		if !time.Now().Before(deadline) {
			break
		}
		s.cond.Wait()
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
	h = strings.TrimSpace(h)
	if h == "" || !strings.HasPrefix(h, "bytes=") {
		return 0, -1, false, nil
	}
	spec := strings.TrimSpace(strings.TrimPrefix(h, "bytes="))
	if i := strings.IndexByte(spec, ','); i >= 0 {
		spec = spec[:i]
	}
	parts := strings.SplitN(spec, "-", 2)
	if len(parts) != 2 {
		return 0, -1, false, fmt.Errorf("bad range %q", h)
	}
	end = -1
	if parts[0] != "" {
		start, err = strconv.ParseInt(parts[0], 10, 64)
		if err != nil {
			return 0, -1, false, err
		}
	}
	if parts[1] != "" {
		end, err = strconv.ParseInt(parts[1], 10, 64)
		if err != nil {
			return 0, -1, false, err
		}
	}
	return start, end, true, nil
}

func serveSpool(w http.ResponseWriter, r *http.Request, s *spool) {
	// 起播预取：详情页已触发下载时通常立即满足。
	s.waitFor(PrefetchMinBytes, PrefetchWaitMax)
	s.mu.Lock()
	have, _, _, serr := s.have, s.total, s.done, s.err
	s.mu.Unlock()
	if have == 0 && serr != nil {
		atomic.AddInt64(&cacheFallbacks, 1)
		log.Printf("[BiliDaemon] spool %s unavailable: %v (fallback direct)", s.bvid, serr)
		proxyUpstream(w, r, s.bvid, nil, "video/mp4", StreamIdleTimeout, &streamBytes)
		return
	}

	start, end, hasRange, perr := parseRange(r.Header.Get("Range"))
	if perr != nil {
		http.Error(w, "bad range", 400)
		return
	}
	if hasRange {
		if !s.waitFor(start+1, SpoolRangeWaitMax) {
			atomic.AddInt64(&streamStalls, 1)
			atomic.AddInt64(&cacheFallbacks, 1)
			log.Printf("[BiliDaemon] spool %s range wait timeout at %d (2s), fallback direct", s.bvid, start)
			proxyUpstream(w, r, s.bvid, nil, "video/mp4", StreamIdleTimeout, &streamBytes)
			return
		}
	}

	s.mu.Lock()
	total, done := s.total, s.done
	s.mu.Unlock()
	if total > 0 && start >= total {
		w.Header().Set("Content-Range", fmt.Sprintf("bytes */%d", total))
		http.Error(w, "range not satisfiable", 416)
		return
	}

	f, err := os.Open(s.pathForRead())
	if err != nil {
		f, err = os.Open(s.filePath)
		if err != nil {
			atomic.AddInt64(&cacheFallbacks, 1)
			log.Printf("[BiliDaemon] spool %s file open failed: %v (fallback direct)", s.bvid, err)
			proxyUpstream(w, r, s.bvid, nil, "video/mp4", StreamIdleTimeout, &streamBytes)
			return
		}
	}
	defer f.Close()
	if _, err := f.Seek(start, io.SeekStart); err != nil {
		http.Error(w, "seek: "+err.Error(), 500)
		return
	}

	length := int64(-1)
	if total > 0 {
		length = total - start
		if hasRange && end >= 0 && end < total-1 {
			length = end - start + 1
		}
	} else if done {
		if fi, e := f.Stat(); e == nil {
			length = fi.Size() - start
		}
	}

	w.Header().Set("Content-Type", "video/mp4")
	w.Header().Set("Accept-Ranges", "bytes")
	w.Header().Set("Cache-Control", "no-store")
	if length >= 0 {
		w.Header().Set("Content-Length", strconv.FormatInt(length, 10))
	}
	if hasRange {
		if total > 0 && length >= 0 {
			w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, start+length-1, total))
		}
		w.WriteHeader(http.StatusPartialContent)
	} else {
		w.WriteHeader(http.StatusOK)
	}

	pos := start
	remaining := length
	buf := make([]byte, 64*1024)
	for {
		if remaining == 0 {
			return
		}
		s.mu.Lock()
		avail := s.have
		if s.done && s.total > avail {
			avail = s.total
		}
		sdone, serr2 := s.done, s.err
		s.mu.Unlock()

		if pos >= avail {
			if sdone {
				if serr2 != nil {
					log.Printf("[BiliDaemon] spool %s ended early at %d: %v", s.bvid, pos, serr2)
				}
				return
			}
			if !s.waitFor(pos+1, StreamIdleTimeout) {
				atomic.AddInt64(&streamStalls, 1)
				log.Printf("[BiliDaemon] spool %s read stall at %d", s.bvid, pos)
				return
			}
			continue
		}

		n := int64(len(buf))
		if avail-pos < n {
			n = avail - pos
		}
		if remaining > 0 && remaining < n {
			n = remaining
		}
		m, rerr := f.ReadAt(buf[:n], pos)
		if m > 0 {
			if _, werr := w.Write(buf[:m]); werr != nil {
				return
			}
			if fw, ok := w.(http.Flusher); ok {
				fw.Flush()
			}
			atomic.AddInt64(&streamBytes, int64(m))
			pos += int64(m)
			if remaining > 0 {
				remaining -= int64(m)
			}
		}
		if rerr != nil && rerr != io.EOF {
			return
		}
	}
}

// proxyUpstream 实时代理上游媒体流（缓存不可用时的兜底，也用于音频）。
// candidates 为空时按 bvid 解析视频 durl。
func proxyUpstream(w http.ResponseWriter, r *http.Request, bvid string, candidates []string, forceCT string, idleTimeout time.Duration, counter *int64) {
	if len(candidates) == 0 {
		primary, backups, err := resolvePlayURL(bvid)
		if err != nil {
			log.Printf("[BiliDaemon] stream resolve failed for %s: %v", bvid, err)
			http.Error(w, "upstream: "+err.Error(), 502)
			return
		}
		candidates = append([]string{primary}, backups...)
	}

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	sid := registerStream(cancel)
	defer unregisterStream(sid)

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
		if lastErr == nil {
			lastErr = errors.New("no candidate")
		}
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
		w.Header().Set("Content-Type", forceCT)
	}
	w.WriteHeader(resp.StatusCode)

	idle := time.AfterFunc(idleTimeout, func() {
		log.Printf("[BiliDaemon] stream idle timeout for %s, closing", bvid)
		cancel()
	})
	defer idle.Stop()

	buf := make([]byte, 64*1024)
	for {
		n, rerr := resp.Body.Read(buf)
		if n > 0 {
			idle.Reset(idleTimeout)
			if _, werr := w.Write(buf[:n]); werr != nil {
				cancel()
				return
			}
			if counter != nil {
				atomic.AddInt64(counter, int64(n))
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
}

func handleStream(w http.ResponseWriter, r *http.Request) {
	bvid := r.URL.Query().Get("bvid")
	if bvid == "" {
		jsonError(w, "missing bvid", 400)
		return
	}
	if !validBVID(bvid) {
		jsonError(w, "invalid bvid", 400)
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

// handleDetail 返回详情页需要的数据，并顺带触发整段预取。
func handleDetail(w http.ResponseWriter, r *http.Request) {
	bvid := r.URL.Query().Get("bvid")
	if bvid == "" {
		jsonError(w, "missing bvid", 400)
		return
	}
	if !validBVID(bvid) {
		jsonError(w, "invalid bvid", 400)
		return
	}
	meta, err := resolveMeta(bvid)
	if err != nil {
		log.Printf("[BiliDaemon] detail failed for %s: %v", bvid, err)
		jsonError(w, "detail: "+err.Error(), 502)
		return
	}
	picLocal := cacheCover(bvid, meta.pic)
	go func() {
		if _, perr := ensureSpool(bvid); perr != nil {
			log.Printf("[BiliDaemon] prefetch %s skipped: %v", bvid, perr)
		}
	}()

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"bvid":      bvid,
		"title":     meta.title,
		"owner":     meta.owner,
		"pic":       meta.pic,
		"pic_local": picLocal,
		"duration":  meta.duration,
		"desc":      meta.desc,
		"view":      meta.view,
		"like":      meta.like,
		"danmaku":   meta.danmaku,
		"cid":       meta.cid,
		"dimension": map[string]int{"width": meta.srcW, "height": meta.srcH},
	})
}

// handleAudio 提供两种音频形态：
//
//	raw   —— 直连 DASH 音频 m4s（若原生播放器接受纯音频流，这是最省 CPU 的路径）
//	remux —— 用设备自带 ffmpeg 把音频重新封装成带「1fps 黑帧视频轨」的分片 MP4，
//	         保证原生播放器一定能找到视频流，同时几乎不增加解码开销。
func handleAudio(w http.ResponseWriter, r *http.Request) {
	bvid := r.URL.Query().Get("bvid")
	if bvid == "" {
		jsonError(w, "missing bvid", 400)
		return
	}
	if !validBVID(bvid) {
		jsonError(w, "invalid bvid", 400)
		return
	}
	au, err := resolveAudio(bvid)
	if err != nil {
		log.Printf("[BiliDaemon] audio resolve failed for %s: %v", bvid, err)
		http.Error(w, "audio: "+err.Error(), 502)
		return
	}
	if r.URL.Query().Get("variant") == "remux" {
		handleAudioRemux(w, r, bvid, au)
		return
	}
	candidates := append([]string{au.url}, au.backups...)
	proxyUpstream(w, r, "audio:"+bvid, candidates, "audio/mp4", AudioIdleTimeout, &audioBytes)
}

func handleAudioRemux(w http.ResponseWriter, r *http.Request, bvid string, au audioEntry) {
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
		"-user_agent", UserAgent,
		"-referer", BiliReferer,
	}
	if c := loadCookie(); c != "" {
		args = append(args, "-headers", "Cookie: "+c+"\r\n")
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

	log.Printf("[BiliDaemon] audio remux start %s (id=%d bw=%d)", bvid, au.id, au.bw)
	w.Header().Set("Content-Type", "video/mp4")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	if f, ok := w.(http.Flusher); ok {
		f.Flush()
	}
	buf := make([]byte, 32*1024)
	written := int64(0)
	loggedFirst := false
	for {
		n, rerr := stdout.Read(buf)
		if n > 0 {
			if !loggedFirst {
				loggedFirst = true
				log.Printf("[BiliDaemon] audio remux first byte %s", bvid)
			}
			if _, werr := w.Write(buf[:n]); werr != nil {
				log.Printf("[BiliDaemon] audio remux client gone %s after %d bytes", bvid, written)
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
	log.Printf("[BiliDaemon] audio remux end %s, %d bytes", bvid, written)
	if stderr.Len() > 0 {
		msg := strings.TrimSpace(stderr.String())
		if len(msg) > 500 {
			msg = msg[:500]
		}
		log.Printf("[BiliDaemon] audio remux %s ffmpeg: %s", bvid, msg)
	}
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


func cleanCovers() {
	entries, err := os.ReadDir(CoverDir)
	if err != nil {
		return
	}
	type cacheFile struct {
		path string
		mod  time.Time
	}
	var files []cacheFile
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".jpg") {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		files = append(files, cacheFile{filepath.Join(CoverDir, e.Name()), info.ModTime()})
	}
	const MaxCovers = 120
	if len(files) > MaxCovers {
		sort.Slice(files, func(i, j int) bool { return files[i].mod.Before(files[j].mod) })
		excess := len(files) - MaxCovers
		for i := 0; i < excess; i++ {
			_ = os.Remove(files[i].path)
		}
		log.Printf("[BiliDaemon] cleaned %d old covers, %d kept", excess, MaxCovers)
	}
}

// cleanCache 清理过期与超量缓存及封面，避免长期占满 /userdisk。
func cleanCache() {
	cleanCovers()
	entries, err := os.ReadDir(CacheDir)
	if err != nil {
		return
	}
	type cacheFile struct {
		path string
		size int64
		mod  time.Time
	}
	var files []cacheFile
	now := time.Now()
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		info, ierr := e.Info()
		if ierr != nil {
			continue
		}
		p := filepath.Join(CacheDir, e.Name())
		if strings.HasSuffix(e.Name(), ".part") {
			if now.Sub(info.ModTime()) > 24*time.Hour {
				_ = os.Remove(p)
			}
			continue
		}
		if !strings.HasSuffix(e.Name(), ".mp4") {
			continue
		}
		if now.Sub(info.ModTime()).Seconds() > float64(CacheMaxAgeSecond) {
			_ = os.Remove(p)
			continue
		}
		files = append(files, cacheFile{p, info.Size(), info.ModTime()})
	}
	sort.Slice(files, func(i, j int) bool { return files[i].mod.Before(files[j].mod) })
	var total int64
	for _, f := range files {
		total += f.size
	}
	for _, f := range files {
		if total <= CacheCapBytes {
			break
		}
		if rerr := os.Remove(f.path); rerr == nil {
			total -= f.size
		}
	}
	log.Printf("[BiliDaemon] cache maintenance: %d files / %d bytes kept", len(files), total)
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

	// 会话从关到开才做硬件增益初始化，避免每次起播都 fork tinymix。
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

	// 注意：这里不再强制取消媒体流。厂商 softvideo 播放器在流被服务端提前断开时
	// 停止过程会触发其内部状态机异常（真机表现为连续操作后崩溃），稳定性优先。
	log.Printf("[BiliDaemon] playback session stop")
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{"status": "stopped"})
}

func registerStream(cancel context.CancelFunc) int {
	streamMu.Lock()
	streamNextID++
	id := streamNextID
	streams[id] = cancel
	streamMu.Unlock()
	return id
}

func unregisterStream(id int) {
	streamMu.Lock()
	delete(streams, id)
	streamMu.Unlock()
}

func cancelAllStreams() {
	streamMu.Lock()
	n := len(streams)
	for id, c := range streams {
		c()
		delete(streams, id)
	}
	streamMu.Unlock()
	if n > 0 {
		log.Printf("[BiliDaemon] cancelled %d active streams", n)
	}
}

func initHardwareAudio() {
	// 锁定 LINEOUT 增益为 16，避免 >18 削波破音（平台手册 6.2）。用控件名而非编号，防止枚举顺序变化。
	runTinymix("DAC LINEOUT Volume", "16")
}

func runTinymix(args ...string) {
	full := append([]string{"-D", "0", "set"}, args...)
	cmd := exec.Command(TinymixPath, full...)
	if out, err := cmd.CombinedOutput(); err != nil {
		log.Printf("[BiliDaemon] tinymix %v failed: %v (%s)", args, err, strings.TrimSpace(string(out)))
	}
}

const (
	SYS_shmat  = 305
	SYS_shmdt  = 306
	SYS_shmget = 307
)

var shmMemPtr unsafe.Pointer

func initVolumeSharedMemory() {
	if shmMemPtr != nil {
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
	ptrVal := raddr
	shmMemPtr = *(*unsafe.Pointer)(unsafe.Pointer(&ptrVal))
	shmOK = true
	log.Printf("[BiliDaemon] volume shared memory attached at %p", shmMemPtr)
}

var volumeControlOK = false

// probeVolumeControl 探测 ALSA 上是否存在可用于系统音量联动的控件。
// 该机型 card0 只有 DAC LINEOUT/HPMIX，没有 control 25 / Master Playback Volume，
// 系统音量由 libydhal_audio 直接读 vctl 共享内存生效，因此这里只在控件存在时才写。
func probeVolumeControl() bool {
	for _, ctl := range []string{"25", "Master Playback Volume"} {
		out, _ := exec.Command(TinymixPath, "-D", "0", "get", ctl).CombinedOutput()
		text := strings.ToLower(string(out))
		if strings.Contains(text, "invalid mixer control") || strings.Contains(text, "error") {
			continue
		}
		// 能读到具体数值才算控件存在。
		if strings.ContainsAny(text, "0123456789") {
			return true
		}
	}
	return false
}

// volumeSyncLoop 保持旧包行为：跟随系统音量写 ALSA；控件不可用时退化为只读（HAL 已处理音量）。
func volumeSyncLoop() {
	volumeControlOK = probeVolumeControl()
	if !volumeControlOK {
		log.Printf("[BiliDaemon] no writable master volume control, rely on HAL vctl (read-only)")
	}
	interval := 100 * time.Millisecond
	if !volumeControlOK {
		interval = 2 * time.Second
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for range ticker.C {
		vol, ok := readSystemVolume()
		if !ok || vol == lastAlsaVol {
			continue
		}
		lastAlsaVol = vol
		if !volumeControlOK {
			continue
		}
		alsaVal := int(float64(vol) * 2.55)
		if alsaVal > 255 {
			alsaVal = 255
		}
		if alsaVal < 0 {
			alsaVal = 0
		}
		alsaStr := strconv.Itoa(alsaVal)
		runTinymix("25", alsaStr, alsaStr)
		log.Printf("[BiliDaemon] volume sync: %d%% -> ALSA %s/255", vol, alsaStr)
	}
}

func readSystemVolume() (int, bool) {
	if shmMemPtr == nil {
		if !shmOK && time.Now().Before(shmNextTry) {
			return 0, false
		}
		initVolumeSharedMemory()
		if shmMemPtr == nil {
			if shmAttempts < 6 {
				shmAttempts++
			}
			shmNextTry = time.Now().Add(time.Duration(shmAttempts) * 5 * time.Second)
			log.Printf("[BiliDaemon] volume shm unavailable, retry in %v", time.Duration(shmAttempts)*5*time.Second)
			return 0, false
		}
		shmOK = true
	}
	spkVol := *(*uint32)(unsafe.Add(shmMemPtr, 4))
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
}
