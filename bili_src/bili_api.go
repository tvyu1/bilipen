package main

import (
	"context"
	"crypto/md5"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	qrcode "github.com/skip2/go-qrcode"
)

var (
	apiClient    = newClient(10 * time.Second)
	streamClient = newClient(30 * time.Second)
	// 离线下载专用：不能设 Client.Timeout —— 它覆盖整个 body 读取，
	// 弱网下单条 DASH 轨道（10~20MB）必然超过 30s，会在固定百分比处被掐断。
	// 这里只限制首包时间，body 停滞由 downloadFilePartWithProgress 的 90s 看门狗兜底。
	downloadClient = newDownloadClient()
	bvidRe         = regexp.MustCompile(`^BV[0-9A-Za-z]{10}$`)
)

func newDownloadClient() *http.Client {
	return &http.Client{
		Timeout: 0,
		Transport: &http.Transport{
			DialContext:           dialIPv4Context,
			ResponseHeaderTimeout: 20 * time.Second,
			IdleConnTimeout:       30 * time.Second,
			MaxIdleConns:          4,
			MaxIdleConnsPerHost:   2,
		},
	}
}

func validBVID(bvid string) bool { return bvidRe.MatchString(bvid) }

func dialIPv4Context(ctx context.Context, network, addr string) (net.Conn, error) {
	d := &net.Dialer{
		Timeout:   8 * time.Second,
		KeepAlive: 30 * time.Second,
	}
	switch network {
	case "tcp", "tcp4":
		return d.DialContext(ctx, "tcp4", addr)
	case "udp", "udp4":
		return d.DialContext(ctx, "udp4", addr)
	default:
		return d.DialContext(ctx, network, addr)
	}
}

func newClient(timeout time.Duration) *http.Client {
	return &http.Client{
		Timeout: timeout,
		Transport: &http.Transport{
			DialContext:           dialIPv4Context,
			ResponseHeaderTimeout: 10 * time.Second,
			IdleConnTimeout:       30 * time.Second,
			MaxIdleConns:          8,
			MaxIdleConnsPerHost:   4,
		},
	}
}

// WBI mixin key encoding table
var mixinKeyEncTab = []int{
	46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
	27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
	37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
	22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
}

var (
	wbiImgKey     string
	wbiSubKey     string
	wbiMixinKey   string
	wbiKeysExpire time.Time
	wbiMu         sync.Mutex
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
	wbiMu.Lock()
	defer wbiMu.Unlock()
	img := imgURL
	if idx := strings.LastIndex(img, "/"); idx >= 0 {
		img = img[idx+1:]
	}
	if idx := strings.Index(img, "."); idx >= 0 {
		img = img[:idx]
	}
	sub := subURL
	if idx := strings.LastIndex(sub, "/"); idx >= 0 {
		sub = sub[idx+1:]
	}
	if idx := strings.Index(sub, "."); idx >= 0 {
		sub = sub[:idx]
	}
	wbiImgKey = img
	wbiSubKey = sub
	wbiMixinKey = getMixinKey(img + sub)
	wbiKeysExpire = time.Now().Add(12 * time.Hour)
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
	var d struct {
		Data struct {
			WbiImg struct {
				ImgUrl string `json:"img_url"`
				SubUrl string `json:"sub_url"`
			} `json:"wbi_img"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&d); err != nil {
		return
	}
	if d.Data.WbiImg.ImgUrl != "" && d.Data.WbiImg.SubUrl != "" {
		updateWbiKeysFromNav(d.Data.WbiImg.ImgUrl, d.Data.WbiImg.SubUrl)
	}
}

func signWbiQuery(params url.Values) string {
	wbiMu.Lock()
	mixin := wbiMixinKey
	exp := wbiKeysExpire
	wbiMu.Unlock()
	if mixin == "" || time.Now().After(exp) {
		fetchWbiKeys()
		wbiMu.Lock()
		mixin = wbiMixinKey
		wbiMu.Unlock()
	}
	if mixin == "" {
		mixin = "ea1fa12e4ae516d76079984eb0a44ae7"
	}
	params.Set("wts", strconv.FormatInt(time.Now().Unix(), 10))
	keys := make([]string, 0, len(params))
	for k := range params {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var pairs []string
	for _, k := range keys {
		v := params.Get(k)
		v = strings.ReplaceAll(v, "!", "")
		v = strings.ReplaceAll(v, "'", "")
		v = strings.ReplaceAll(v, "(", "")
		v = strings.ReplaceAll(v, ")", "")
		v = strings.ReplaceAll(v, "*", "")
		pairs = append(pairs, url.QueryEscape(k)+"="+url.QueryEscape(v))
	}
	query := strings.Join(pairs, "&")
	h := md5.Sum([]byte(query + mixin))
	wRid := hex.EncodeToString(h[:])
	return query + "&w_rid=" + wRid
}

func cleanTitle(t string) string {
	t = strings.ReplaceAll(t, "<em class=\"keyword\">", "")
	t = strings.ReplaceAll(t, "</em>", "")
	t = strings.ReplaceAll(t, "&quot;", "\"")
	t = strings.ReplaceAll(t, "&amp;", "&")
	t = strings.ReplaceAll(t, "&#39;", "'")
	return t
}

func loadCookie() string {
	b, err := os.ReadFile(CookieFile)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

func saveCookie(c string) {
	_ = os.WriteFile(CookieFile, []byte(strings.TrimSpace(c)), 0644)
}

func clearCookie() {
	_ = os.Remove(CookieFile)
}

func cacheCover(bvid, picUrl string) string {
	if picUrl == "" {
		return ""
	}
	localName := bvid + ".jpg"
	localPath := filepath.Join(CoverDir, localName)
	if fi, err := os.Stat(localPath); err == nil && fi.Size() > 512 {
		return "covers/" + localName
	}
	req, err := http.NewRequest("GET", picUrl, nil)
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
	data, err := io.ReadAll(resp.Body)
	if err != nil || len(data) < 512 {
		return ""
	}
	tmp := localPath + ".tmp"
	if err := os.WriteFile(tmp, data, 0644); err == nil {
		_ = os.Rename(tmp, localPath)
		return "covers/" + localName
	}
	return ""
}

func cacheCoversAsync(items []VideoItem) {
	for i := range items {
		it := items[i]
		if it.Bvid == "" || it.Pic == "" {
			continue
		}
		localName := it.Bvid + ".jpg"
		localPath := filepath.Join(CoverDir, localName)
		if fi, err := os.Stat(localPath); err == nil && fi.Size() > 512 {
			continue
		}
		go func(bvid, pic string) {
			_ = cacheCover(bvid, pic)
		}(it.Bvid, it.Pic)
	}
}

// Feed Cache
var (
	feedCacheMu    sync.Mutex
	feedCacheItems []VideoItem
)

func initFeedCache() {
	feedCacheMu.Lock()
	defer feedCacheMu.Unlock()
	b, err := os.ReadFile(FeedCacheFile)
	if err != nil || len(b) == 0 {
		return
	}
	var items []VideoItem
	if err := json.Unmarshal(b, &items); err == nil && len(items) > 0 {
		feedCacheItems = items
		log.Printf("[BiliDaemon] feed: restored %d items from disk cache", len(items))
	}
}

func serveCachedFeed(w http.ResponseWriter) bool {
	feedCacheMu.Lock()
	n := len(feedCacheItems)
	items := make([]VideoItem, n)
	copy(items, feedCacheItems)
	feedCacheMu.Unlock()
	if n == 0 {
		return false
	}
	for i := range items {
		localName := items[i].Bvid + ".jpg"
		if fi, err := os.Stat(filepath.Join(CoverDir, localName)); err == nil && fi.Size() > 512 {
			items[i].PicLocal = "covers/" + localName
		}
	}
	log.Printf("[BiliDaemon] feed: serve cached %d items", len(items))
	writeJSON(w, 200, map[string]interface{}{
		"items":  items,
		"cached": true,
	})
	return true
}

func feedCacheSet(items []VideoItem) {
	if len(items) == 0 {
		return
	}
	feedCacheMu.Lock()
	feedCacheItems = items
	data, err := json.Marshal(items)
	feedCacheMu.Unlock()
	if err == nil {
		tmp := FeedCacheFile + ".tmp"
		if err := os.WriteFile(tmp, data, 0644); err == nil {
			_ = os.Rename(tmp, FeedCacheFile)
		}
	}
}

func fetchRankingFeed() []VideoItem {
	rankURL := "https://api.bilibili.com/x/web-interface/ranking/v2?rid=0&type=all"
	req, err := http.NewRequest("GET", rankURL, nil)
	if err != nil {
		return nil
	}
	req.Header.Set("User-Agent", UserAgent)
	req.Header.Set("Referer", BiliReferer)
	if c := loadCookie(); c != "" {
		req.Header.Set("Cookie", c)
	}
	resp, err := apiClient.Do(req)
	if err != nil {
		return nil
	}
	defer resp.Body.Close()
	var rd struct {
		Code int `json:"code"`
		Data struct {
			List []struct {
				Bvid     string `json:"bvid"`
				Title    string `json:"title"`
				Pic      string `json:"pic"`
				Duration int    `json:"duration"`
				Owner    struct {
					Name string `json:"name"`
				} `json:"owner"`
			} `json:"list"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&rd); err != nil || rd.Code != 0 {
		return nil
	}
	var out []VideoItem
	for _, it := range rd.Data.List {
		if it.Bvid == "" {
			continue
		}
		item := VideoItem{
			Bvid:     it.Bvid,
			Title:    cleanTitle(it.Title),
			Pic:      it.Pic,
			Owner:    it.Owner.Name,
			Duration: it.Duration,
		}
		localName := item.Bvid + ".jpg"
		if fi, err := os.Stat(filepath.Join(CoverDir, localName)); err == nil && fi.Size() > 512 {
			item.PicLocal = "covers/" + localName
		}
		out = append(out, item)
		if len(out) >= 8 {
			break
		}
	}
	return out
}

func handleFeed(w http.ResponseWriter, r *http.Request) {
	p := url.Values{}
	p.Set("fresh_type", "3")
	p.Set("fresh_idx", "1")
	p.Set("ps", "8")
	signed := signWbiQuery(p)
	feedURL := "https://api.bilibili.com/x/web-interface/wbi/index/top/feed/rcmd?" + signed
	req, err := http.NewRequest("GET", feedURL, nil)
	if err != nil {
		if !serveCachedFeed(w) {
			jsonError(w, err.Error(), 500)
		}
		return
	}
	req.Header.Set("User-Agent", UserAgent)
	req.Header.Set("Referer", BiliReferer)
	if c := loadCookie(); c != "" {
		req.Header.Set("Cookie", c)
	}
	resp, err := apiClient.Do(req)
	if err != nil {
		log.Printf("[BiliDaemon] feed WBI upstream error: %v", err)
		log.Printf("[BiliDaemon] feed WBI unavailable, fallback to ranking...")
		if items := fetchRankingFeed(); len(items) > 0 {
			cacheCoversAsync(items)
			feedCacheSet(items)
			writeJSON(w, 200, map[string]interface{}{"items": items, "fallback": true})
			return
		}
		if serveCachedFeed(w) {
			return
		}
		jsonError(w, "upstream unreachable and no cache", 502)
		return
	}
	defer resp.Body.Close()
	var d struct {
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
	if err := json.NewDecoder(resp.Body).Decode(&d); err != nil {
		if !serveCachedFeed(w) {
			jsonError(w, err.Error(), 502)
		}
		return
	}
	var out []VideoItem
	for _, it := range d.Data.Item {
		if it.Bvid == "" {
			continue
		}
		item := VideoItem{
			Bvid:     it.Bvid,
			Title:    cleanTitle(it.Title),
			Pic:      it.Pic,
			Owner:    it.Owner.Name,
			Duration: it.Duration,
		}
		localName := item.Bvid + ".jpg"
		if fi, err := os.Stat(filepath.Join(CoverDir, localName)); err == nil && fi.Size() > 512 {
			item.PicLocal = "covers/" + localName
		}
		out = append(out, item)
	}
	if len(out) == 0 {
		if items := fetchRankingFeed(); len(items) > 0 {
			cacheCoversAsync(items)
			feedCacheSet(items)
			writeJSON(w, 200, map[string]interface{}{"items": items, "fallback": true})
			return
		}
		if serveCachedFeed(w) {
			return
		}
	}
	cacheCoversAsync(out)
	feedCacheSet(out)
	writeJSON(w, 200, map[string]interface{}{"items": out})
}

func handleTrending(w http.ResponseWriter, r *http.Request) {
	req, err := http.NewRequest("GET", "https://api.bilibili.com/x/web-interface/popular?ps=12&pn=1", nil)
	if err != nil {
		jsonError(w, err.Error(), 500)
		return
	}
	req.Header.Set("User-Agent", UserAgent)
	req.Header.Set("Referer", BiliReferer)
	if c := loadCookie(); c != "" {
		req.Header.Set("Cookie", c)
	}
	resp, err := apiClient.Do(req)
	if err != nil {
		jsonError(w, err.Error(), 502)
		return
	}
	defer resp.Body.Close()
	var d struct {
		Code int `json:"code"`
		Data struct {
			List []struct {
				Bvid     string `json:"bvid"`
				Title    string `json:"title"`
				Pic      string `json:"pic"`
				Duration int    `json:"duration"`
				Owner    struct {
					Name string `json:"name"`
				} `json:"owner"`
			} `json:"list"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&d); err != nil {
		jsonError(w, err.Error(), 502)
		return
	}
	var out []VideoItem
	for _, it := range d.Data.List {
		if it.Bvid == "" {
			continue
		}
		item := VideoItem{
			Bvid:     it.Bvid,
			Title:    cleanTitle(it.Title),
			Pic:      it.Pic,
			Owner:    it.Owner.Name,
			Duration: it.Duration,
		}
		localName := item.Bvid + ".jpg"
		if fi, err := os.Stat(filepath.Join(CoverDir, localName)); err == nil && fi.Size() > 512 {
			item.PicLocal = "covers/" + localName
		}
		out = append(out, item)
	}
	cacheCoversAsync(out)
	writeJSON(w, 200, map[string]interface{}{"items": out})
}

func handleSearch(w http.ResponseWriter, r *http.Request) {
	kw := r.URL.Query().Get("keyword")
	if kw == "" {
		jsonError(w, "missing keyword", 400)
		return
	}
	p := url.Values{}
	p.Set("keyword", kw)
	// search_type: video(默认) | bili_user；order: totalrank(综合) | click(播放多) | pubdate(最新)
	stype := "video"
	if r.URL.Query().Get("type") == "user" {
		stype = "bili_user"
	}
	p.Set("search_type", stype)
	if order := r.URL.Query().Get("order"); order != "" {
		p.Set("order", order)
	}
	p.Set("page_size", "12")
	p.Set("page", "1")
	signed := signWbiQuery(p)
	searchURL := "https://api.bilibili.com/x/web-interface/wbi/search/type?" + signed
	req, err := http.NewRequest("GET", searchURL, nil)
	if err != nil {
		jsonError(w, err.Error(), 500)
		return
	}
	req.Header.Set("User-Agent", UserAgent)
	req.Header.Set("Referer", BiliReferer)
	if c := loadCookie(); c != "" {
		req.Header.Set("Cookie", c)
	}
	resp, err := apiClient.Do(req)
	if err != nil {
		jsonError(w, err.Error(), 502)
		return
	}
	defer resp.Body.Close()
	var d struct {
		Code int `json:"code"`
		Data struct {
			Result []struct {
				Bvid     string      `json:"bvid"`
				Title    string      `json:"title"`
				Pic      string      `json:"pic"`
				Duration interface{} `json:"duration"`
				Author   string      `json:"author"`
				// type=bili_user 时返回的是 UP 主：mid / uname / upic
				Mid   int64  `json:"mid"`
				Uname string `json:"uname"`
				Upic  string `json:"upic"`
			} `json:"result"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&d); err != nil {
		jsonError(w, err.Error(), 502)
		return
	}
	var out []VideoItem
	for _, it := range d.Data.Result {
		if it.Bvid == "" {
			// UP 主搜索结果：没有 bvid，用 uname/upic 组成可展示卡片，带上 mid
			if it.Uname == "" && it.Mid == 0 {
				continue
			}
			upic := it.Upic
			if strings.HasPrefix(upic, "//") {
				upic = "https:" + upic
			}
			out = append(out, VideoItem{Title: it.Uname, Pic: upic, Owner: "UP主", Mid: it.Mid})
			continue
		}
		dur := 0
		switch v := it.Duration.(type) {
		case float64:
			dur = int(v)
		case string:
			parts := strings.Split(v, ":")
			if len(parts) == 2 {
				m, _ := strconv.Atoi(parts[0])
				s, _ := strconv.Atoi(parts[1])
				dur = m*60 + s
			} else if len(parts) == 3 {
				h, _ := strconv.Atoi(parts[0])
				m, _ := strconv.Atoi(parts[1])
				s, _ := strconv.Atoi(parts[2])
				dur = h*3600 + m*60 + s
			}
		}
		pic := it.Pic
		if strings.HasPrefix(pic, "//") {
			pic = "https:" + pic
		}
		item := VideoItem{
			Bvid:     it.Bvid,
			Title:    cleanTitle(it.Title),
			Pic:      pic,
			Owner:    it.Author,
			Duration: dur,
		}
		localName := item.Bvid + ".jpg"
		if fi, err := os.Stat(filepath.Join(CoverDir, localName)); err == nil && fi.Size() > 512 {
			item.PicLocal = "covers/" + localName
		}
		out = append(out, item)
	}
	cacheCoversAsync(out)
	writeJSON(w, 200, map[string]interface{}{"items": out})
}

func handleProxyCover(w http.ResponseWriter, r *http.Request) {
	raw := r.URL.Query().Get("url")
	if raw == "" {
		http.Error(w, "missing url", 400)
		return
	}
	if strings.HasPrefix(raw, "//") {
		raw = "https:" + raw
	}
	req, err := http.NewRequest("GET", raw, nil)
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	req.Header.Set("User-Agent", UserAgent)
	req.Header.Set("Referer", BiliReferer)
	resp, err := apiClient.Do(req)
	if err != nil {
		http.Error(w, err.Error(), 502)
		return
	}
	defer resp.Body.Close()
	for k, vv := range resp.Header {
		for _, v := range vv {
			w.Header().Add(k, v)
		}
	}
	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, resp.Body)
}

func handleUserInfo(w http.ResponseWriter, r *http.Request) {
	cookie := loadCookie()
	if cookie == "" {
		writeJSON(w, 200, map[string]interface{}{"is_login": false})
		return
	}
	req, err := http.NewRequest("GET", "https://api.bilibili.com/x/web-interface/nav", nil)
	if err != nil {
		jsonError(w, err.Error(), 500)
		return
	}
	req.Header.Set("User-Agent", UserAgent)
	req.Header.Set("Referer", BiliReferer)
	req.Header.Set("Cookie", cookie)
	resp, err := apiClient.Do(req)
	if err != nil {
		jsonError(w, err.Error(), 502)
		return
	}
	defer resp.Body.Close()
	var d struct {
		Code int `json:"code"`
		Data struct {
			IsLogin bool   `json:"isLogin"`
			Uname   string `json:"uname"`
			Mid     int64  `json:"mid"`
			Face    string `json:"face"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&d); err != nil {
		jsonError(w, err.Error(), 502)
		return
	}
	// 同时给 is_login 与 logged_in：前后端历史上各读一种，双发避免再次错位
	writeJSON(w, 200, map[string]interface{}{
		"is_login":  d.Data.IsLogin,
		"logged_in": d.Data.IsLogin,
		"uname":     d.Data.Uname,
		"mid":       d.Data.Mid,
		"face":      d.Data.Face,
	})
}

func handleLoginQr(w http.ResponseWriter, r *http.Request) {
	req, err := http.NewRequest("GET", "https://passport.bilibili.com/x/passport-login/web/qrcode/generate", nil)
	if err != nil {
		jsonError(w, err.Error(), 500)
		return
	}
	req.Header.Set("User-Agent", UserAgent)
	req.Header.Set("Referer", BiliReferer)
	resp, err := apiClient.Do(req)
	if err != nil {
		jsonError(w, err.Error(), 502)
		return
	}
	defer resp.Body.Close()
	var d struct {
		Code int `json:"code"`
		Data struct {
			Url       string `json:"url"`
			QrcodeKey string `json:"qrcode_key"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&d); err != nil || d.Code != 0 {
		jsonError(w, "generate qr failed", 502)
		return
	}
	pngData, err := qrcode.Encode(d.Data.Url, qrcode.Medium, 120)
	if err != nil {
		jsonError(w, err.Error(), 500)
		return
	}
	// 每次生成用唯一文件名：同名文件会被 miniapp 的图片渲染器按路径缓存，
	// 导致刷新二维码后画面不更新（看起来像「二维码加载不出来」）。
	key := d.Data.QrcodeKey
	short := key
	if len(short) > 8 {
		short = short[:8]
	}
	name := "login_qr_" + short + ".png"
	qrPath := filepath.Join(CoverDir, name)
	_ = os.WriteFile(qrPath, pngData, 0644)
	cleanupLoginQr()
	rel := "covers/" + name
	writeJSON(w, 200, map[string]interface{}{
		"qrcode_key": key,
		"url":        d.Data.Url,
		"qr_local":   rel,
		"qr_path":    rel, // 前端历史字段名，两个都给，避免再次对不上
	})
}

// cleanupLoginQr 清理 1 小时前的历史二维码图片，避免 covers 目录堆积。
func cleanupLoginQr() {
	entries, err := os.ReadDir(CoverDir)
	if err != nil {
		return
	}
	for _, e := range entries {
		if e.IsDir() || !strings.HasPrefix(e.Name(), "login_qr") {
			continue
		}
		if fi, ierr := e.Info(); ierr == nil && time.Since(fi.ModTime()) > time.Hour {
			_ = os.Remove(filepath.Join(CoverDir, e.Name()))
		}
	}
}

func handleLoginPoll(w http.ResponseWriter, r *http.Request) {
	key := r.URL.Query().Get("qrcode_key")
	if key == "" {
		jsonError(w, "missing qrcode_key", 400)
		return
	}
	pollURL := "https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=" + url.QueryEscape(key)
	req, err := http.NewRequest("GET", pollURL, nil)
	if err != nil {
		jsonError(w, err.Error(), 500)
		return
	}
	req.Header.Set("User-Agent", UserAgent)
	req.Header.Set("Referer", BiliReferer)
	resp, err := apiClient.Do(req)
	if err != nil {
		jsonError(w, err.Error(), 502)
		return
	}
	defer resp.Body.Close()
	var d struct {
		Code int `json:"code"`
		Data struct {
			Code int    `json:"code"`
			Msg  string `json:"message"`
			Url  string `json:"url"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&d); err != nil {
		jsonError(w, err.Error(), 502)
		return
	}
	status := "waiting"
	msg := d.Data.Msg
	loggedIn := false
	switch d.Data.Code {
	case 0:
		status = "success"
		// B站 成功时两处都可能带凭证：响应头 Set-Cookie，以及 data.url 的查询参数。
		// 只取其中一处会导致「扫码成功但登录态没保存」——两个都合并。
		kv := map[string]string{}
		for _, c := range resp.Cookies() {
			if c.Value != "" {
				kv[c.Name] = c.Value
			}
		}
		if u, uerr := url.Parse(d.Data.Url); uerr == nil {
			q := u.Query()
			for _, k := range []string{"SESSDATA", "bili_jct", "DedeUserID", "DedeUserID__ckMd5", "sid"} {
				if v := q.Get(k); v != "" && kv[k] == "" {
					kv[k] = v
				}
			}
		}
		if kv["SESSDATA"] != "" {
			parts := make([]string, 0, len(kv))
			for k, v := range kv {
				parts = append(parts, k+"="+v)
			}
			saveCookie(strings.Join(parts, "; "))
			loggedIn = true
			msg = "登录成功"
		} else {
			status = "waiting"
			msg = "已确认，但未取到登录凭证，请重试"
		}
	case 86038:
		status = "expired"
		msg = "二维码已过期，请刷新"
	case 86090:
		status = "scanned"
		msg = "已扫码，请在手机上确认"
	default:
		status = "waiting"
	}
	// 字段名同时给两套（历史前端读 logged_in/message，新前端读 status/msg），避免再次错位。
	writeJSON(w, 200, map[string]interface{}{
		"logged_in": loggedIn,
		"status":    status,
		"code":      d.Data.Code,
		"msg":       msg,
		"message":   msg,
	})
}

func handleLogout(w http.ResponseWriter, r *http.Request) {
	clearCookie()
	writeJSON(w, 200, map[string]interface{}{"ok": true})
}

// Meta & Streams Resolution
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

var (
	metaMu    sync.Mutex
	metaCache = map[string]metaEntry{}
)

// 分P 选择：前端选 P 后写入覆盖表，后续 /api/stream、/api/audio 会自动用这个 cid
var (
	cidOverrideMu sync.Mutex
	cidOverride   = map[string]int64{}
)

// handleSelectCid 记录某 bvid 当前要播放的分P cid
func handleSelectCid(w http.ResponseWriter, r *http.Request) {
	bvid := r.URL.Query().Get("bvid")
	cidStr := r.URL.Query().Get("cid")
	if !validBVID(bvid) || cidStr == "" {
		jsonError(w, "bad params", 400)
		return
	}
	cid, err := strconv.ParseInt(cidStr, 10, 64)
	if err != nil || cid <= 0 {
		jsonError(w, "bad cid", 400)
		return
	}
	cidOverrideMu.Lock()
	cidOverride[bvid] = cid
	cidOverrideMu.Unlock()
	// 元信息缓存里存的是 P1 的 cid，这里直接改掉，省一次上游请求
	metaMu.Lock()
	if e, ok := metaCache[bvid]; ok {
		e.cid = cid
		metaCache[bvid] = e
	}
	metaMu.Unlock()
	log.Printf("[BiliDaemon] select cid bvid=%s cid=%d", bvid, cid)
	writeJSON(w, 200, map[string]interface{}{"ok": true, "cid": cid})
}

func applyCidOverride(bvid string, cid int64) int64 {
	cidOverrideMu.Lock()
	defer cidOverrideMu.Unlock()
	if v, ok := cidOverride[bvid]; ok && v > 0 {
		return v
	}
	return cid
}

func resolveMeta(bvid string) (metaEntry, error) {
	if !validBVID(bvid) {
		return metaEntry{}, fmt.Errorf("invalid bvid: %q", bvid)
	}
	metaMu.Lock()
	if e, ok := metaCache[bvid]; ok && time.Now().Before(e.expire) {
		metaMu.Unlock()
		e.cid = applyCidOverride(bvid, e.cid)
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
		Code    int    `json:"code"`
		Message string `json:"message"`
		Data    struct {
			Cid       int64  `json:"cid"`
			Title     string `json:"title"`
			Pic       string `json:"pic"`
			Desc      string `json:"desc"`
			Duration  int    `json:"duration"`
			Dimension struct {
				Width  int `json:"width"`
				Height int `json:"height"`
			} `json:"dimension"`
			Owner struct {
				Name string `json:"name"`
			} `json:"owner"`
			Stat struct {
				View    int64 `json:"view"`
				Like    int64 `json:"like"`
				Danmaku int64 `json:"danmaku"`
			} `json:"stat"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&vd); err != nil {
		return metaEntry{}, err
	}
	if vd.Code != 0 || vd.Data.Cid == 0 {
		return metaEntry{}, fmt.Errorf("view API returned code=%d msg=%q", vd.Code, vd.Message)
	}
	entry := metaEntry{
		cid:      vd.Data.Cid,
		title:    cleanTitle(vd.Data.Title),
		owner:    vd.Data.Owner.Name,
		pic:      vd.Data.Pic,
		desc:     vd.Data.Desc,
		duration: vd.Data.Duration,
		srcW:     vd.Data.Dimension.Width,
		srcH:     vd.Data.Dimension.Height,
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

type playEntry struct {
	url     string
	backups []string
	expire  time.Time
}

var (
	playCacheMu sync.Mutex
	playCache   = map[string]playEntry{}
)

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

	var pd struct {
		Code int `json:"code"`
		Data struct {
			Durl []struct {
				Url       string   `json:"url"`
				BackupUrl []string `json:"backup_url"`
			} `json:"durl"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp2.Body).Decode(&pd); err != nil {
		return "", nil, err
	}
	if len(pd.Data.Durl) == 0 || pd.Data.Durl[0].Url == "" {
		return "", nil, fmt.Errorf("no durl in playurl response (code=%d)", pd.Code)
	}
	u := pd.Data.Durl[0].Url
	var backups []string
	for _, b := range pd.Data.Durl[0].BackupUrl {
		if b != "" && b != u {
			backups = append(backups, b)
		}
	}
	playCacheMu.Lock()
	playCache[bvid] = playEntry{url: u, backups: backups, expire: time.Now().Add(PlayURLCacheTTL)}
	playCacheMu.Unlock()
	return u, backups, nil
}

type audioEntry struct {
	url     string
	backups []string
	id      int
	bw      int
	expire  time.Time
}

var (
	audioCacheMu sync.Mutex
	audioCache   = map[string]audioEntry{}
)

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

	// 音频这里用 fnval=16（纯 DASH）：带 4048 时会员账号可能返回 Hi-Res(FLAC)/Dolby 音轨，
	// 厂商 SoftVPlayer 解不了会报 streamDecoder init failed。
	apiUrl := fmt.Sprintf("https://api.bilibili.com/x/player/playurl?bvid=%s&cid=%d&qn=80&fnval=16",
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
	// 只接受 AAC 音轨：30216(64k) / 30232(132k) / 30280(192k) 是常规 AAC，
	// 30250(Dolby) / 30251(Hi-Res FLAC) 厂商 SoftVPlayer 解不了，一旦被选中就报
	// streamDecoder init failed。旧实现是「取带宽最大者」，会员账号会正好命中后者。
	// 优先级：30232(132k，音质与体积折中) > 30216(64k) > 30280(192k) > 其余 AAC 里带宽最低。
	aacIDs := []int{30232, 30216, 30280}
	chosen := -1
	for _, want := range aacIDs {
		for i, a := range pd.Data.Dash.Audio {
			if a.BaseUrl != "" && a.Id == want {
				chosen = i
				break
			}
		}
		if chosen >= 0 {
			break
		}
	}
	if chosen < 0 {
		for i, a := range pd.Data.Dash.Audio {
			if a.BaseUrl == "" {
				continue
			}
			if chosen < 0 || a.Bandwidth < pd.Data.Dash.Audio[chosen].Bandwidth {
				chosen = i
			}
		}
	}
	if chosen < 0 {
		return audioEntry{}, fmt.Errorf("no usable audio track for %s (code=%d)", bvid, pd.Code)
	}
	bestAudio := pd.Data.Dash.Audio[chosen]
	entry := audioEntry{url: bestAudio.BaseUrl, backups: bestAudio.BackupUrl, id: bestAudio.Id, bw: bestAudio.Bandwidth, expire: time.Now().Add(PlayURLCacheTTL)}
	audioCacheMu.Lock()
	audioCache[bvid] = entry
	audioCacheMu.Unlock()
	log.Printf("[BiliDaemon] resolved audio for %s: id=%d bw=%d backups=%d", bvid, entry.id, entry.bw, len(entry.backups))
	return entry, nil
}

// DASH Video & Audio Combined Resolution
type dashEntry struct {
	VideoURL     string
	VideoBackups []string
	AudioURL     string
	AudioBackups []string
	VideoCodec   int
	Expire       time.Time
}

var (
	dashCacheMu sync.Mutex
	dashCache   = map[string]dashEntry{}
)

func resolveDash(bvid string) (dashEntry, error) {
	if !validBVID(bvid) {
		return dashEntry{}, fmt.Errorf("invalid bvid: %q", bvid)
	}
	dashCacheMu.Lock()
	if e, ok := dashCache[bvid]; ok && time.Now().Before(e.Expire) {
		dashCacheMu.Unlock()
		return e, nil
	}
	dashCacheMu.Unlock()

	meta, err := resolveMeta(bvid)
	if err != nil {
		return dashEntry{}, err
	}

	apiUrl := fmt.Sprintf("https://api.bilibili.com/x/player/playurl?bvid=%s&cid=%d&qn=16&fnval=4048&fourk=1",
		url.QueryEscape(bvid), meta.cid)
	req, err := http.NewRequest("GET", apiUrl, nil)
	if err != nil {
		return dashEntry{}, err
	}
	req.Header.Set("User-Agent", UserAgent)
	req.Header.Set("Referer", BiliReferer)
	if cookie := loadCookie(); cookie != "" {
		req.Header.Set("Cookie", cookie)
	}
	resp, err := apiClient.Do(req)
	if err != nil {
		return dashEntry{}, err
	}
	defer resp.Body.Close()

	var pd struct {
		Code int `json:"code"`
		Data struct {
			Dash struct {
				Video []struct {
					Id        int      `json:"id"`
					BaseUrl   string   `json:"baseUrl"`
					BackupUrl []string `json:"backupUrl"`
					Bandwidth int      `json:"bandwidth"`
					Codecid   int      `json:"codecid"`
				} `json:"video"`
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
		return dashEntry{}, err
	}

	// 1. Choose video: prefer AVC (codecid 7) and 360P (id 16) for lowest CPU & memory footprint
	var bestV struct {
		url     string
		backups []string
		codecid int
		id      int
	}
	for _, v := range pd.Data.Dash.Video {
		if v.BaseUrl == "" {
			continue
		}
		// Prefer AVC (codecid 7)
		if v.Codecid == 7 {
			if bestV.url == "" || v.Id == 16 || (bestV.id != 16 && v.Id < bestV.id) {
				bestV.url, bestV.backups, bestV.codecid, bestV.id = v.BaseUrl, v.BackupUrl, v.Codecid, v.Id
			}
		} else if bestV.url == "" {
			bestV.url, bestV.backups, bestV.codecid, bestV.id = v.BaseUrl, v.BackupUrl, v.Codecid, v.Id
		}
	}

	// 2. Choose audio: select best AAC audio
	var bestA struct {
		url     string
		backups []string
		bw      int
		id      int
	}
	for _, a := range pd.Data.Dash.Audio {
		if a.BaseUrl == "" {
			continue
		}
		if a.Bandwidth > bestA.bw {
			bestA.url, bestA.backups, bestA.bw, bestA.id = a.BaseUrl, a.BackupUrl, a.Bandwidth, a.Id
		}
	}

	if bestV.url == "" || bestA.url == "" {
		return dashEntry{}, fmt.Errorf("dash streams missing for %s (v=%v a=%v code=%d)", bvid, bestV.url != "", bestA.url != "", pd.Code)
	}

	entry := dashEntry{
		VideoURL:     bestV.url,
		VideoBackups: bestV.backups,
		AudioURL:     bestA.url,
		AudioBackups: bestA.backups,
		VideoCodec:   bestV.codecid,
		Expire:       time.Now().Add(PlayURLCacheTTL),
	}

	dashCacheMu.Lock()
	dashCache[bvid] = entry
	dashCacheMu.Unlock()

	// Also populate audioCache so /api/audio can hit cache
	audioCacheMu.Lock()
	audioCache[bvid] = audioEntry{
		url:     bestA.url,
		backups: bestA.backups,
		id:      bestA.id,
		bw:      bestA.bw,
		expire:  entry.Expire,
	}
	audioCacheMu.Unlock()

	log.Printf("[BiliDaemon] resolved dash for %s: video id=%d codec=%d, audio id=%d bw=%d", bvid, bestV.id, bestV.codecid, bestA.id, bestA.bw)
	return entry, nil
}

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
		dlMu.Lock()
		dlItem := dlItems[bvid]
		dlMu.Unlock()
		if dlItem != nil && dlItem.Status == "completed" {
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"bvid":      bvid,
				"title":     dlItem.Title,
				"owner":     dlItem.Owner,
				"pic":       dlItem.Pic,
				"pic_local": dlItem.PicLocal,
				"duration":  dlItem.Duration,
				"desc":      "离线已下载视频",
				"view":      0,
				"like":      0,
				"danmaku":   0,
				"cid":       0,
				"dimension": map[string]int{"width": 640, "height": 360},
			})
			return
		}
		log.Printf("[BiliDaemon] detail failed for %s: %v", bvid, err)
		jsonError(w, "detail: "+err.Error(), 502)
		return
	}
	picLocal := ""
	coverPath := filepath.Join(CoverDir, bvid+".jpg")
	if fi, err := os.Stat(coverPath); err == nil && fi.Size() > 512 {
		picLocal = "covers/" + bvid + ".jpg"
	} else {
		go cacheCover(bvid, meta.pic)
	}
	// 注意：此处不再在"打开详情页"时触发全量预取。
	// 旧实现会对每个被点开的详情页把整段视频落盘到 /userdisk/bili_cache，
	// 用户只是浏览也会产生数十 MB 的 eMMC 写与单核抢占（v2.4.7 审计 D-01）。
	// 预取改由"真正开始播放"时经 handleStream → ensureSpool 触发。

	// 三连状态（未登录返回 null，前端据此把按钮置灰）
	var relation interface{}
	var aid int64
	if a, aerr := resolveAid(bvid); aerr == nil {
		aid = a
		if loggedIn, _, _ := ensureLogin(false); loggedIn {
			relation = fetchRelation(aid)
		}
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"aid":       aid,
		"relation":  relation,
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
