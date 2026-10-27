package main

// actions.go —— 互动类接口（点赞/投币/收藏/评论/分P/推荐/云端历史/稍后再看/分享二维码）
// 以及它们共用的「登录态 + csrf」基础设施。
//
// 设计约定：
//   - 所有接口 HTTP 状态码一律 200，业务错误放在 body 的 code/message 里，前端只看 body。
//   - 未登录： {"code":"need_login"}   缺 csrf： {"code":"need_csrf"}
//   - B站 返回非 0：{"code":"bili_<n>","message":"<msg>"}
//   - 写接口 1s 内去重，防连点。

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	qrcode "github.com/skip2/go-qrcode"
)

// ---------- cookie / csrf ----------

func cookieValue(cookie, key string) string {
	for _, part := range strings.Split(cookie, ";") {
		part = strings.TrimSpace(part)
		if strings.HasPrefix(part, key+"=") {
			return strings.TrimPrefix(part, key+"=")
		}
	}
	return ""
}

func csrfToken() string { return cookieValue(loadCookie(), "bili_jct") }

// ensureBuvid 补全 buvid3/buvid4 设备指纹。
// B站写接口（尤其投币）会做风控：cookie 里没有 buvid 时直接返回 -401「非法访问」，
// 实测补上后风控等级从 verify_captcha_level3 降到 level2，其他写接口也更稳。
func ensureBuvid() {
	c := loadCookie()
	if c == "" || cookieValue(c, "buvid3") != "" {
		return
	}
	req, err := http.NewRequest("GET", "https://api.bilibili.com/x/frontend/finger/spi", nil)
	if err != nil {
		return
	}
	req.Header.Set("User-Agent", UserAgent)
	req.Header.Set("Referer", BiliReferer)
	resp, err := apiClient.Do(req)
	if err != nil {
		return
	}
	defer resp.Body.Close()
	var d struct {
		Data struct {
			B3 string `json:"b_3"`
			B4 string `json:"b_4"`
		} `json:"data"`
	}
	if json.NewDecoder(io.LimitReader(resp.Body, 8192)).Decode(&d) != nil || d.Data.B3 == "" {
		return
	}
	nc := strings.TrimSuffix(strings.TrimSpace(c), ";") + "; buvid3=" + d.Data.B3
	if d.Data.B4 != "" {
		nc += "; buvid4=" + d.Data.B4
	}
	saveCookie(nc)
	log.Printf("[BiliDaemon] buvid3 added to cookie")
}

var (
	loginMu        sync.Mutex
	loginCachedOK  bool
	loginCachedMid string
	loginCachedNam string
	loginCheckedAt time.Time
	loginCookieSig string // 上次校验时的 cookie 指纹：cookie 一变就强制重查
)

// ensureLogin 用 nav 接口校验登录态（60s 缓存）。返回 (是否登录, mid, uname)。
func ensureLogin(force bool) (bool, string, string) {
	cookieNow := loadCookie()
	loginMu.Lock()
	if !force && cookieNow == loginCookieSig && time.Since(loginCheckedAt) < 60*time.Second && loginCachedMid != "" {
		ok, mid, name := loginCachedOK, loginCachedMid, loginCachedNam
		loginMu.Unlock()
		return ok, mid, name
	}
	loginMu.Unlock()

	ok, mid, name := false, "", ""
	cookie := cookieNow
	if cookie != "" {
		req, err := http.NewRequest("GET", "https://api.bilibili.com/x/web-interface/nav", nil)
		if err == nil {
			req.Header.Set("User-Agent", UserAgent)
			req.Header.Set("Referer", BiliReferer)
			req.Header.Set("Cookie", cookie)
			if resp, derr := apiClient.Do(req); derr == nil {
				var d struct {
					Code int `json:"code"`
					Data struct {
						IsLogin bool   `json:"isLogin"`
						Mid     int64  `json:"mid"`
						Uname   string `json:"uname"`
					} `json:"data"`
				}
				_ = json.NewDecoder(resp.Body).Decode(&d)
				resp.Body.Close()
				if d.Data.IsLogin {
					ok = true
					mid = fmt.Sprintf("%d", d.Data.Mid)
					name = d.Data.Uname
				}
			}
		}
	}
	loginMu.Lock()
	loginCachedOK, loginCachedMid, loginCachedNam = ok, mid, name
	loginCachedNam = name
	loginCheckedAt = time.Now()
	loginCookieSig = cookieNow
	loginMu.Unlock()
	return ok, mid, name
}

// doBiliPost 以表单 POST 调用 B站 写接口（自动带 csrf 与 cookie）。
func doBiliPost(endpoint string, form url.Values) (int, string, error) {
	req, err := http.NewRequest("POST", endpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return 0, "", err
	}
	req.Header.Set("User-Agent", UserAgent)
	req.Header.Set("Referer", BiliReferer)
	req.Header.Set("Origin", "https://www.bilibili.com")
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	if c := loadCookie(); c != "" {
		req.Header.Set("Cookie", c)
	}
	resp, err := apiClient.Do(req)
	if err != nil {
		return 0, "", err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 8192))
	var d struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	}
	_ = json.Unmarshal(body, &d)
	return d.Code, d.Message, nil
}

func biliErrName(code int) string {
	switch code {
	case -101:
		return "未登录或登录已过期"
	case -111:
		return "CSRF 校验失败，请重新登录"
	case -400:
		return "请求参数错误"
	case -412, -401:
		return "B站风控要求人机验证，请用手机客户端操作"
	case -650:
		return "操作太频繁，请稍后再试"
	case 34005:
		return "超出投币上限"
	case 34006:
		return "该稿件不允许投币"
	}
	return ""
}

// writeBiliResult 把 B站 返回码翻译成统一 JSON
func writeBiliResult(w http.ResponseWriter, code int, msg string) {
	if code == 0 {
		writeJSON(w, 200, map[string]interface{}{"ok": true})
		return
	}
	if m := biliErrName(code); m != "" {
		msg = m
	}
	if msg == "" {
		msg = "操作失败"
	}
	writeJSON(w, 200, map[string]interface{}{
		"ok":      false,
		"code":    fmt.Sprintf("bili_%d", code),
		"message": msg,
	})
}

// requireLoginWrite 写操作统一前置检查：登录态 + csrf
func requireLoginWrite(w http.ResponseWriter) (string, bool) {
	if ok, _, _ := ensureLogin(false); !ok {
		writeJSON(w, 200, map[string]interface{}{"ok": false, "code": "need_login", "message": "请先扫码登录"})
		return "", false
	}
	ensureBuvid()
	csrf := csrfToken()
	if csrf == "" {
		writeJSON(w, 200, map[string]interface{}{"ok": false, "code": "need_csrf", "message": "缺少 CSRF 令牌，请重新登录"})
		return "", false
	}
	return csrf, true
}

// ---------- bvid → aid / stat 缓存 ----------

type viewInfo struct {
	aid  int64
	like int64
	coin int64
	fav  int64
	view int64
	exp  time.Time
}

var (
	viewCacheMu sync.Mutex
	viewCache   = map[string]viewInfo{}
)

func resolveAid(bvid string) (int64, error) {
	viewCacheMu.Lock()
	if e, ok := viewCache[bvid]; ok && time.Now().Before(e.exp) {
		viewCacheMu.Unlock()
		return e.aid, nil
	}
	viewCacheMu.Unlock()

	apiUrl := "https://api.bilibili.com/x/web-interface/view?bvid=" + url.QueryEscape(bvid)
	req, err := http.NewRequest("GET", apiUrl, nil)
	if err != nil {
		return 0, err
	}
	req.Header.Set("User-Agent", UserAgent)
	req.Header.Set("Referer", BiliReferer)
	if c := loadCookie(); c != "" {
		req.Header.Set("Cookie", c)
	}
	resp, err := apiClient.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	var d struct {
		Code int `json:"code"`
		Data struct {
			Aid int64 `json:"aid"`
			Stat struct {
				View     int64 `json:"view"`
				Like     int64 `json:"like"`
				Coin     int64 `json:"coin"`
				Favorite int64 `json:"favorite"`
			} `json:"stat"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&d); err != nil {
		return 0, err
	}
	if d.Code != 0 || d.Data.Aid == 0 {
		return 0, fmt.Errorf("view code=%d", d.Code)
	}
	viewCacheMu.Lock()
	viewCache[bvid] = viewInfo{aid: d.Data.Aid, like: d.Data.Stat.Like, coin: d.Data.Stat.Coin, fav: d.Data.Stat.Favorite, view: d.Data.Stat.View, exp: time.Now().Add(5 * time.Minute)}
	viewCacheMu.Unlock()
	return d.Data.Aid, nil
}

// ---------- 读写接口 ----------

// handleParts 分P列表
func handleParts(w http.ResponseWriter, r *http.Request) {
	bvid := r.URL.Query().Get("bvid")
	if !validBVID(bvid) {
		jsonError(w, "invalid bvid", 400)
		return
	}
	req, _ := http.NewRequest("GET", "https://api.bilibili.com/x/player/pagelist?bvid="+url.QueryEscape(bvid), nil)
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
		Data []struct {
			Cid      int64  `json:"cid"`
			Page     int    `json:"page"`
			Part     string `json:"part"`
			Duration int    `json:"duration"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&d); err != nil || d.Code != 0 {
		jsonError(w, "parts failed", 502)
		return
	}
	writeJSON(w, 200, map[string]interface{}{"items": d.Data})
}

// handleRelated 相关推荐
func handleRelated(w http.ResponseWriter, r *http.Request) {
	bvid := r.URL.Query().Get("bvid")
	if !validBVID(bvid) {
		jsonError(w, "invalid bvid", 400)
		return
	}
	req, _ := http.NewRequest("GET", "https://api.bilibili.com/x/web-interface/archive/related?bvid="+url.QueryEscape(bvid), nil)
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
		Data []struct {
			Bvid   string `json:"bvid"`
			Title  string `json:"title"`
			Pic    string `json:"pic"`
			Owner  struct {
				Name string `json:"name"`
			} `json:"owner"`
			Duration int `json:"duration"`
			Stat struct {
				View int64 `json:"view"`
			} `json:"stat"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&d); err != nil || d.Code != 0 {
		jsonError(w, "related failed", 502)
		return
	}
	items := make([]VideoItem, 0, len(d.Data))
	for _, v := range d.Data {
		items = append(items, VideoItem{Bvid: v.Bvid, Title: cleanTitle(v.Title), Pic: v.Pic, Owner: v.Owner.Name, Duration: v.Duration})
	}
	cacheCoversAsync(items)
	writeJSON(w, 200, map[string]interface{}{"items": items})
}

// handleComments 评论列表（sort: hot|new）
func handleComments(w http.ResponseWriter, r *http.Request) {
	bvid := r.URL.Query().Get("bvid")
	if !validBVID(bvid) {
		jsonError(w, "invalid bvid", 400)
		return
	}
	aid, err := resolveAid(bvid)
	if err != nil {
		jsonError(w, "aid: "+err.Error(), 502)
		return
	}
	sort := "0" // 0=按热度 2=按时间
	if r.URL.Query().Get("sort") == "new" {
		sort = "2"
	}
	pn := r.URL.Query().Get("pn")
	if pn == "" {
		pn = "1"
	}
	apiUrl := fmt.Sprintf("https://api.bilibili.com/x/v2/reply?type=1&oid=%d&sort=%s&ps=10&pn=%s", aid, sort, pn)
	req, _ := http.NewRequest("GET", apiUrl, nil)
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
			Page struct {
				Count int `json:"count"`
			} `json:"page"`
			Replies []struct {
				Member struct {
					Uname  string `json:"uname"`
					Avatar string `json:"avatar"`
				} `json:"member"`
				Ctime int64  `json:"ctime"`
				Like  int    `json:"like"`
				Rcount int   `json:"rcount"`
				Content struct {
					Message string `json:"message"`
				} `json:"content"`
			} `json:"replies"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&d); err != nil || d.Code != 0 {
		jsonError(w, "comments failed", 502)
		return
	}
	list := make([]map[string]interface{}, 0, len(d.Data.Replies))
	for _, c := range d.Data.Replies {
		list = append(list, map[string]interface{}{
			"uname":  c.Member.Uname,
			"ctime":  c.Ctime,
			"message": c.Content.Message,
			"like":   c.Like,
			"rcount": c.Rcount,
		})
	}
	writeJSON(w, 200, map[string]interface{}{"count": d.Data.Page.Count, "items": list, "pn": pn})
}

// fetchRelation 查询三连状态（供 /api/detail 复用）
func fetchRelation(aid int64) map[string]interface{} {
	req, err := http.NewRequest("GET", fmt.Sprintf("https://api.bilibili.com/x/web-interface/archive/relation?aid=%d", aid), nil)
	if err != nil {
		return nil
	}
	req.Header.Set("User-Agent", UserAgent)
	req.Header.Set("Referer", BiliReferer)
	req.Header.Set("Origin", "https://www.bilibili.com")
	if c := loadCookie(); c != "" {
		req.Header.Set("Cookie", c)
	}
	resp, err := apiClient.Do(req)
	if err != nil {
		return nil
	}
	defer resp.Body.Close()
	var d struct {
		Code int `json:"code"`
		Data struct {
			Like     int `json:"like"`
			Coin     int `json:"coin"`
			Favorite int `json:"favorite"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&d); err != nil || d.Code != 0 {
		return nil
	}
	return map[string]interface{}{"like": d.Data.Like, "coin": d.Data.Coin, "favorite": d.Data.Favorite}
}

// handleActionRelation 三连状态
func handleActionRelation(w http.ResponseWriter, r *http.Request) {
	bvid := r.URL.Query().Get("bvid")
	if !validBVID(bvid) {
		jsonError(w, "invalid bvid", 400)
		return
	}
	if ok, _, _ := ensureLogin(false); !ok {
		writeJSON(w, 200, map[string]interface{}{"ok": true, "logged_in": false})
		return
	}
	aid, err := resolveAid(bvid)
	if err != nil {
		jsonError(w, "aid: "+err.Error(), 502)
		return
	}
	req, _ := http.NewRequest("GET", fmt.Sprintf("https://api.bilibili.com/x/web-interface/archive/relation?aid=%d", aid), nil)
	req.Header.Set("User-Agent", UserAgent)
	req.Header.Set("Referer", BiliReferer)
	req.Header.Set("Origin", "https://www.bilibili.com")
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
			Like     int `json:"like"`
			Coin     int `json:"coin"`
			Favorite int `json:"favorite"`
		} `json:"data"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&d)
	writeJSON(w, 200, map[string]interface{}{
		"ok": true, "logged_in": true, "code": d.Code,
		"like": d.Data.Like, "coin": d.Data.Coin, "favorite": d.Data.Favorite,
	})
}

// handleActionLike 点赞/取消
func handleActionLike(w http.ResponseWriter, r *http.Request) {
	bvid := r.URL.Query().Get("bvid")
	if !validBVID(bvid) {
		jsonError(w, "invalid bvid", 400)
		return
	}
	csrf, ok := requireLoginWrite(w)
	if !ok {
		return
	}
	aid, err := resolveAid(bvid)
	if err != nil {
		jsonError(w, "aid: "+err.Error(), 502)
		return
	}
	// B站 web 接口约定：1=点赞，2=取消点赞（like=0 会被判 -400 参数错误）
	like := "1"
	if r.URL.Query().Get("like") == "0" {
		like = "2"
	}
	form := url.Values{}
	form.Set("aid", fmt.Sprintf("%d", aid))
	form.Set("like", like)
	form.Set("csrf", csrf)
	code, msg, err := doBiliPost("https://api.bilibili.com/x/web-interface/archive/like", form)
	if err != nil {
		jsonError(w, err.Error(), 502)
		return
	}
	log.Printf("[BiliDaemon] like bvid=%s aid=%d like=%s code=%d", bvid, aid, like, code)
	writeBiliResult(w, code, msg)
}

// handleActionCoin 投币
func handleActionCoin(w http.ResponseWriter, r *http.Request) {
	bvid := r.URL.Query().Get("bvid")
	if !validBVID(bvid) {
		jsonError(w, "invalid bvid", 400)
		return
	}
	csrf, ok := requireLoginWrite(w)
	if !ok {
		return
	}
	aid, err := resolveAid(bvid)
	if err != nil {
		jsonError(w, "aid: "+err.Error(), 502)
		return
	}
	num := r.URL.Query().Get("num")
	if num != "2" {
		num = "1"
	}
	form := url.Values{}
	form.Set("aid", fmt.Sprintf("%d", aid))
	form.Set("multiply", num)
	form.Set("select_like", "0")
	form.Set("csrf", csrf)
	code, msg, err := doBiliPost("https://api.bilibili.com/x/web-interface/coin/add", form)
	if err != nil {
		jsonError(w, err.Error(), 502)
		return
	}
	log.Printf("[BiliDaemon] coin bvid=%s aid=%d num=%s code=%d", bvid, aid, num, code)
	writeBiliResult(w, code, msg)
}

// handleActionFav 收藏/取消收藏（media_id 为空时用默认收藏夹第一个）
func handleActionFav(w http.ResponseWriter, r *http.Request) {
	bvid := r.URL.Query().Get("bvid")
	if !validBVID(bvid) {
		jsonError(w, "invalid bvid", 400)
		return
	}
	csrf, ok := requireLoginWrite(w)
	if !ok {
		return
	}
	aid, err := resolveAid(bvid)
	if err != nil {
		jsonError(w, "aid: "+err.Error(), 502)
		return
	}
	mediaID := r.URL.Query().Get("media_id")
	if mediaID == "" {
		folders, ferr := fetchFavFolders()
		if ferr != nil || len(folders) == 0 {
			writeJSON(w, 200, map[string]interface{}{"ok": false, "code": "no_folder", "message": "没有可用收藏夹"})
			return
		}
		mediaID = folders[0].ID
	}
	add := r.URL.Query().Get("add") != "0"
	form := url.Values{}
	form.Set("rid", fmt.Sprintf("%d", aid))
	form.Set("type", "2")
	form.Set("csrf", csrf)
	if add {
		form.Set("add_media_ids", mediaID)
		form.Set("del_media_ids", "")
	} else {
		form.Set("add_media_ids", "")
		form.Set("del_media_ids", mediaID)
	}
	code, msg, err := doBiliPost("https://api.bilibili.com/x/v3/fav/resource/deal", form)
	if err != nil {
		jsonError(w, err.Error(), 502)
		return
	}
	log.Printf("[BiliDaemon] fav bvid=%s aid=%d media=%s add=%v code=%d", bvid, aid, mediaID, add, code)
	writeBiliResult(w, code, msg)
}

type favFolder struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	Count int    `json:"count"`
}

func fetchFavFolders() ([]favFolder, error) {
	okLogin, mid, _ := ensureLogin(false)
	if !okLogin || mid == "" {
		return nil, fmt.Errorf("not logged in")
	}
	apiUrl := "https://api.bilibili.com/x/v3/fav/folder/created/list-all?up_mid=" + url.QueryEscape(mid)
	req, _ := http.NewRequest("GET", apiUrl, nil)
	req.Header.Set("User-Agent", UserAgent)
	req.Header.Set("Referer", BiliReferer)
	if c := loadCookie(); c != "" {
		req.Header.Set("Cookie", c)
	}
	resp, err := apiClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var d struct {
		Code int `json:"code"`
		Data struct {
			List []struct {
				Id         int64  `json:"id"`
				Title      string `json:"title"`
				MediaCount int    `json:"media_count"`
			} `json:"list"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&d); err != nil {
		return nil, err
	}
	if d.Code != 0 {
		return nil, fmt.Errorf("fav folders code=%d", d.Code)
	}
	out := make([]favFolder, 0, len(d.Data.List))
	for _, f := range d.Data.List {
		out = append(out, favFolder{ID: fmt.Sprintf("%d", f.Id), Title: f.Title, Count: f.MediaCount})
	}
	return out, nil
}

// handleFavFolders 收藏夹列表
func handleFavFolders(w http.ResponseWriter, r *http.Request) {
	folders, err := fetchFavFolders()
	if err != nil {
		msg := err.Error()
		code := "need_login"
		if strings.Contains(msg, "not logged in") {
			msg = "请先扫码登录"
		} else {
			code = "error"
		}
		writeJSON(w, 200, map[string]interface{}{"ok": false, "code": code, "message": msg})
		return
	}
	writeJSON(w, 200, map[string]interface{}{"ok": true, "items": folders})
}

// handleFavItems 收藏夹内容
func handleFavItems(w http.ResponseWriter, r *http.Request) {
	mediaID := r.URL.Query().Get("media_id")
	if mediaID == "" {
		writeJSON(w, 200, map[string]interface{}{"ok": false, "code": "no_folder", "message": "缺少 media_id"})
		return
	}
	pn := r.URL.Query().Get("pn")
	if pn == "" {
		pn = "1"
	}
	apiUrl := fmt.Sprintf("https://api.bilibili.com/x/v3/fav/resource/list?media_id=%s&pn=%s&ps=20&platform=web", url.QueryEscape(mediaID), pn)
	req, _ := http.NewRequest("GET", apiUrl, nil)
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
			Info struct {
				Title string `json:"title"`
				Count int    `json:"media_count"`
			} `json:"info"`
			Medias []struct {
				Bvid     string `json:"bvid"`
				Title    string `json:"title"`
				Cover    string `json:"cover"`
				Duration int    `json:"duration"`
				Upper    struct {
					Name string `json:"name"`
				} `json:"upper"`
			} `json:"medias"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&d); err != nil || d.Code != 0 {
		jsonError(w, "fav items failed", 502)
		return
	}
	items := make([]VideoItem, 0, len(d.Data.Medias))
	for _, m := range d.Data.Medias {
		if m.Bvid == "" {
			continue
		}
		items = append(items, VideoItem{Bvid: m.Bvid, Title: cleanTitle(m.Title), Pic: m.Cover, Owner: m.Upper.Name, Duration: m.Duration})
	}
	cacheCoversAsync(items)
	writeJSON(w, 200, map[string]interface{}{"ok": true, "title": d.Data.Info.Title, "count": d.Data.Info.Count, "items": items})
}

// handleCloudHistory 云端历史
func handleCloudHistory(w http.ResponseWriter, r *http.Request) {
	if ok, _, _ := ensureLogin(false); !ok {
		writeJSON(w, 200, map[string]interface{}{"ok": false, "code": "need_login", "message": "请先扫码登录"})
		return
	}
	pn := r.URL.Query().Get("pn")
	if pn == "" {
		pn = "1"
	}
	apiUrl := fmt.Sprintf("https://api.bilibili.com/x/v2/history?pn=%s&ps=20", pn)
	req, _ := http.NewRequest("GET", apiUrl, nil)
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
		Data []struct {
			Bvid     string `json:"bvid"`
			Title    string `json:"title"`
			Pic      string `json:"pic"`
			Duration int    `json:"duration"`
			Owner    struct {
				Name string `json:"name"`
			} `json:"owner"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&d); err != nil || d.Code != 0 {
		writeJSON(w, 200, map[string]interface{}{"ok": false, "code": "error", "message": "云端历史获取失败"})
		return
	}
	items := make([]VideoItem, 0, len(d.Data))
	for _, v := range d.Data {
		items = append(items, VideoItem{Bvid: v.Bvid, Title: cleanTitle(v.Title), Pic: v.Pic, Owner: v.Owner.Name, Duration: v.Duration})
	}
	cacheCoversAsync(items)
	writeJSON(w, 200, map[string]interface{}{"ok": true, "items": items})
}

// handleToviewAdd 稍后再看
func handleToviewAdd(w http.ResponseWriter, r *http.Request) {
	bvid := r.URL.Query().Get("bvid")
	if !validBVID(bvid) {
		jsonError(w, "invalid bvid", 400)
		return
	}
	csrf, ok := requireLoginWrite(w)
	if !ok {
		return
	}
	aid, err := resolveAid(bvid)
	if err != nil {
		jsonError(w, "aid: "+err.Error(), 502)
		return
	}
	form := url.Values{}
	form.Set("aid", fmt.Sprintf("%d", aid))
	form.Set("csrf", csrf)
	code, msg, err := doBiliPost("https://api.bilibili.com/x/v2/history/toview/add", form)
	if err != nil {
		jsonError(w, err.Error(), 502)
		return
	}
	log.Printf("[BiliDaemon] toview add bvid=%s code=%d", bvid, code)
	writeBiliResult(w, code, msg)
}

// handleShareQr 生成分享二维码（内容为 b23 短链）
func handleShareQr(w http.ResponseWriter, r *http.Request) {
	bvid := r.URL.Query().Get("bvid")
	if !validBVID(bvid) {
		jsonError(w, "invalid bvid", 400)
		return
	}
	target := "https://b23.tv/" + bvid
	png, err := qrcode.Encode(target, qrcode.Medium, 160)
	if err != nil {
		jsonError(w, err.Error(), 500)
		return
	}
	name := "share_qr_" + bvid + ".png"
	_ = os.MkdirAll(CoverDir, 0755)
	_ = os.WriteFile(filepath.Join(CoverDir, name), png, 0644)
	writeJSON(w, 200, map[string]interface{}{"ok": true, "qr_local": "covers/" + name, "url": target})
}

// handleLoginState 供前端判断登录态
func handleLoginState(w http.ResponseWriter, r *http.Request) {
	ok, mid, name := ensureLogin(r.URL.Query().Get("force") == "1")
	writeJSON(w, 200, map[string]interface{}{"logged_in": ok, "mid": mid, "uname": name})
}
