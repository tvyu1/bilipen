import http from 'http';
import nekolib from 'nekolib';
import softvplayer from 'softvplayer';

// P1 A/B 开关：true = 解码输出对齐实际显示区（适应 306×172 / 铺满 640×172），
// false = 回退旧行为（固定 640×360 + CSS scale(0.478)）。改这一行重编即可对比。
var OUT_ALIGN_DISPLAY = true;
// P2 A/B 开关：true = 用 RGA 硬件做 YUV→BGRA+缩放（失败自动回退 sws），false = 只用 sws。
// 实测结论：设备只有可缓存的 rk-dma-heap-cma，没有 uncached heap，
// 按 Rockchip FAQ（A1.7/A2.21）每次 blit 都会被内核强制同步 cache，
// 净收益为负（draws/s 30→27、maxgap 48→150ms）。默认关闭，保留开关供后续换 uncached heap 再试。
var USE_RGA = false;

function safeJson(body, fallback) {
  if (body === null || body === undefined || body === '') return fallback;
  if (typeof body === 'object') return body;
  if (typeof body !== 'string') return fallback;
  try {
    return JSON.parse(body);
  } catch (e) {
    console.warn('[JSON] parse fail: ' + (e && e.message ? e.message : e) + '; body: ' + String(body).slice(0, 60));
    return fallback;
  }
}


class PageRes extends $falcon.Page {
  constructor() {
    super();
    this.falconOnTokens = [];
    this.timeoutTokens = new Set();
    this.intervalTokens = new Set();
  }
  setTimeout(func, ms) {
    const token = setTimeout(() => {
      this.timeoutTokens.delete(token);
      func();
    }, ms);
    this.timeoutTokens.add(token);
    return token;
  }
  setInterval(func, ms) {
    const token = setInterval(func, ms);
    this.intervalTokens.add(token);
    return token;
  }
  clearTimeout(token) {
    this.timeoutTokens.delete(token);
    clearTimeout(token);
  }
  clearInterval(token) {
    this.intervalTokens.delete(token);
    clearInterval(token);
  }
  release() {
    for (let token of this.timeoutTokens) clearTimeout(token);
    this.timeoutTokens.clear();
    for (let token of this.intervalTokens) clearInterval(token);
    this.intervalTokens.clear();
  }
}

class BasePage extends PageRes {
  constructor() {
    super();
  }
  onLoad(options) {
    super.onLoad(options);
    this.options = options;
  }
  onShow() {
    super.onShow();
    console.warn('[Lifecycle] page onShow');
    try { const vm = globalThis.__biliVm; if (vm && vm.onShow) vm.onShow(); } catch (e) {}
    if (this.$root && this.$root.onShow) this.$root.onShow();
  }
  onHide() {
    console.warn('[Lifecycle] page onHide');
    try { super.onHide(); } catch (e) {}
    try { const vm = globalThis.__biliVm; if (vm && vm.onHide) vm.onHide(); } catch (e) {}
    if (this.$root && this.$root.onHide) this.$root.onHide();
  }
  onUnload() {
    console.warn('[Lifecycle] page onUnload');
    try {
      super.onUnload();
      try { const vm = globalThis.__biliVm; if (vm && vm.onUnload) vm.onUnload(); } catch (e) {}
      if (this.$root && this.$root.onUnload) this.$root.onUnload();
    } finally {
      this.release();
    }
  }
  beforeVueInstantiate(Vue) {
    Vue.prototype.$workspace = globalThis.$workspace;
    Vue.prototype.$appid = globalThis.$appid;
  }
}

class App extends $falcon.App {
  constructor() {
    super();
  }
  onLaunch(options) {
    super.onLaunch(options);
    this.setViewPort(640);
    $falcon.useDefaultBasePageClass(BasePage);
  }
  onDestroy() {
    super.onDestroy();
    try {
      http.request({ url: 'http://127.0.0.1:18080/api/stop', method: 'GET', timeout: 500 });
    } catch(e) {}
  }
}

var App$1 = App;

var script = {
  name: 'BiliApp',
  data() {
    return {
      currentTab: 'feed', // 'feed' | 'search' | 'history' | 'fav' | 'download' | 'login'
    iconTip: '',          // 左栏长按提示
    gridPage: 0,          // 2×2 网格当前页
    favFolders: [],       // 收藏夹列表
    favItems: [],         // 当前收藏夹内容
    favTitle: '',         // 当前收藏夹名
    favLoading: false,
    historySource: 'local', // 'local' | 'cloud'
    cloudHistory: [],
    searchType: 'video',    // 'video' | 'user'
    searchOrder: 'totalrank', // totalrank | click | pubdate
    detailTab: 'info',      // 'info' | 'parts' | 'comment' | 'related'
    partsList: [],
    comments: [],
    commentSort: 'hot',
    commentPn: 1,
    commentCount: 0,
    relatedList: [],
    relation: null,         // {like,coin,favorite} 未登录为 null
    likeState: 0,           // 0/1 本地点赞态（服务端为准，但本地立即反馈）
    coinState: 0,
    favState: 0,
    likeCount: 0,
    currentPartPage: 0,     // 当前播放的分P序号（0/1 都视为 P1）
    currentPartTitle: '',
    moreOpen: false,
      currentView: 'home', // 'home' | 'detail'
      statusText: '初始化中...',
      isPlaying: false,
      audioMode: false,
      currentTitle: '',
      currentBvid: '',
      isStopping: false,
      toast: '',
      // Feed
      videos: [],
      loadingFeed: false,
      // Search
      searchInput: '',
      searchResults: [],
      loadingSearch: false,
      kbVisible: false,
      kbRows: [
        ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
        ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', '⌫'],
        ['z', 'x', 'c', 'v', 'b', 'n', 'm', '空格', '清空', '搜索'],
        ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0']
      ],
      // Detail
      detail: null,
      // History（观看历史，持久化在 daemon 侧）
      history: [],
      loadingHistory: false,
      // Downloads（离线下载）
      downloads: [],
      downloadFreeText: '',
      detailDownload: { status: 'none', progress: 0, text: '⬇ 下载' },
      // 版本号（从 daemon /api/ping 取，显示在「我的」页）
      appVersion: '',
      // Player
      playSize: { w: 640, h: 360 },
      srcSize: { w: 640, h: 360 },
      // 播放器状态机：idle|loading|ready-paused|playing|seeking|error|finished
      playerState: 'idle',
      playerMsg: '',
      playerErr: '',
      coverHold: true,       // 首帧封面暂停（可渲染，不能带下划线）
      streamPct: -1,         // -1 = 未知
      streamSource: '',
      streamDone: false,
      buffering: false,      // 播放中位置停滞 >900ms
      ctrlVisible: true,     // 底部控制条：播放中默认隐藏，点画面唤出 3.5s 后自动收起
      spinIdx: 0,
      sweepPct: 0,
      refreshing: false,
      refreshPct: 0,
      // Cache（在线缓存）
      cacheItems: [],
      cacheSource: 'online', // online | offline
      cacheTotalBytes: 0,
      cacheCapBytes: 0,
      cacheFreeText: '',
      vDuration: 0,
      isPaused: false,
      curPos: 0,
      progress: 0,
      rgav: null,
      // Login
      isLoggedIn: false,
      user: { uname: '', mid: 0, face: '' },
      loginQrPath: '',
      loginQrKey: '',
      loginStatusText: '准备就绪',
      pollTimerToken: null
    };
  },
  mounted() {
    globalThis.__biliVm = this;
    this._logImeSupport();
    this._initImeApi();
    this._bindTextEditFinished();
    this.bootstrapDaemon();
    this.testSoftVideo();
    this.syncDaemonState();
    this.loadNativeVideo();
    this._startHeartbeat();
  },
  onShow() {
    console.warn('[Lifecycle] vm onShow');
    this.ensureDaemonRunning();
    this._startHeartbeat();
    if (this.currentTab === 'feed' && (!this.videos || this.videos.length === 0)) {
      this.fetchFeed();
    }
  },
  onHide() {
    // 系统手势回到桌面时页面进入后台：必须立即停播放，否则音频会继续输出并残留到下一次播放。
    console.warn('[Lifecycle] vm onHide, stop playback');
    this._stopHeartbeat();
    try { this.stop(); } catch (e) {}
  },
  onUnload() {
    console.warn('[Lifecycle] vm onUnload, stop playback');
    try { this.stop(); } catch (e) {}
    try { this._cancelTextEdit(); } catch (e) {}
    try { this._unbindTextEditFinished(); } catch (e) {}
  },
  methods: {
    requestWithRetry(opts, retries) {
      if (retries === undefined || retries === null) retries = 1;
      return new Promise((resolve, reject) => {
        const doReq = (attempt) => {
          http.request(opts).then(resolve).catch((err) => {
            console.warn('[Http] request failed: ' + (opts.url || '') + ', attempt=' + attempt + ', err=' + err);
            const url = opts.url || '';
            const isDaemonUrl = url.indexOf('127.0.0.1:18080') >= 0;
            if (isDaemonUrl && attempt === 0) {
              this.ensureDaemonRunning();
            }
            if (attempt < retries) {
              const delay = isDaemonUrl ? 800 : 500;
              this.$page.setTimeout(() => {
                doReq(attempt + 1);
              }, delay);
            } else {
              reject(err);
            }
          });
        };
        doReq(0);
      });
    },
    ensureDaemonRunning() {
      const now = Date.now();
      if (this._lastDaemonEnsureAt && now - this._lastDaemonEnsureAt < 3000) {
        return;
      }
      this._lastDaemonEnsureAt = now;
      console.warn('[Daemon] check ping...');
      http.request({ url: 'http://127.0.0.1:18080/api/ping', method: 'GET', timeout: 800 })
        .then((res) => {
          const v = safeJson(res.body, {});
          if (v && v.version) {
            this.appVersion = v.version;
          }
        })
        .catch(() => {
          console.warn('[Daemon] ping failed, waking daemon up!');
          this.bootstrapDaemon();
        });
    },
    _startHeartbeat() {
      this._stopHeartbeat();
      this._heartbeatTimer = this.$page.setInterval(() => {
        http.request({ url: 'http://127.0.0.1:18080/api/ping', method: 'GET', timeout: 1200 })
          .catch(() => {
            this.ensureDaemonRunning();
          });
      }, 45000);
    },
    _stopHeartbeat() {
      if (this._heartbeatTimer) {
        this.$page.clearInterval(this._heartbeatTimer);
        this._heartbeatTimer = null;
      }
    },
    async loadNativeVideo() {
      try {
        const mod = await import('rgavideo');
        this.rgav = (mod && mod.default) ? mod.default : mod;
        console.warn('[Rga] import ok start=' + (this.rgav && typeof this.rgav.start));
      } catch (e) {
        this.rgav = null;
        console.warn('[Rga] import failed: ' + e);
      }
    },
    testSoftVideo() {
      const PlayerClass = (softvplayer && softvplayer.SoftVPlayer) || (softvplayer && softvplayer.default && softvplayer.default.SoftVPlayer) || softvplayer;
      console.warn("[SoftVPlayer] Engine ready:", typeof PlayerClass === 'function');
    },
    syncDaemonState() {
      // 清理上一次会话可能残留的 daemon 播放状态；顺带校验 daemon 版本，便于发现“连到旧进程”。
      this.$page.setTimeout(() => {
        try {
          http.request({ url: 'http://127.0.0.1:18080/api/stop', method: 'GET', timeout: 1200 }).catch(() => {});
          http.request({ url: 'http://127.0.0.1:18080/api/ping', method: 'GET', timeout: 1500 })
            .then((res) => {
              const v = safeJson(res.body, {});
              this.appVersion = (v && v.version) || '';
              console.warn('[BiliPen] daemon version:', v && v.version, 'pid:', v && v.pid);
            })
            .catch(() => {});
        } catch (e) {}
      }, 1200);
    },
    bootstrapDaemon() {
      this.statusText = '唤醒后端服务...';
      try {
        const sh = (nekolib && nekolib.shell) || (nekolib && nekolib.default && nekolib.default.shell);
        if (sh && sh.exec) {
          const D = "/userdisk/secondary/miniapp/data/mini_app/pkg/9002000869905604";
          sh.exec("mkdir -p " + D + "/data/covers");
          sh.exec("ln -sf ../data/covers " + D + "/a/covers");
          sh.exec("ln -sf ../data/covers " + D + "/b/covers");
          // 单实例 + 版本一致：先杀旧进程，再只启动「最新安装槽」的那份 daemon。
          // 旧版本会同时拉起 a/ 与 b/，导致旧进程常驻、新前端连到旧后端（"改了没变化"）。
          sh.exec(
            "killall bili-daemon 2>/dev/null; sleep 0.4; " +
            "A=" + D + "/a/libs/bili-daemon; B=" + D + "/b/libs/bili-daemon; " +
            "if [ -f \"$A\" ] && { [ ! -f \"$B\" ] || [ \"$A\" -nt \"$B\" ]; }; then R=\"$A\"; else R=\"$B\"; fi; " +
            "if [ -z \"$R\" ] || [ ! -f \"$R\" ]; then R=\"$A\"; fi; " +
            "chmod +x \"$R\" 2>/dev/null; " +
            "\"$R\" > /userdisk/bili_daemon.log 2>&1 &"
          );
        }
      } catch (err) {
        console.log("bootstrapDaemon error:", err);
      }
      this.$page.setTimeout(() => {
        this.fetchUserInfo();
        this.fetchFeed();
      }, 1000);
      // 登录态探测完成后再决定要不要出二维码：已登录就别再生成（省一次写盘，也避免界面闪回扫码）
      this.$page.setTimeout(() => {
        if (!this.isLoggedIn) this.refreshQr();
      }, 2400);
    },
    _shExec(cmd) {
      try {
        const sh = (nekolib && nekolib.shell) || (nekolib && nekolib.default && nekolib.default.shell);
        if (sh && sh.exec) { sh.exec(cmd); return true; }
      } catch (e) {}
      return false;
    },
    _startKeepScreen() {
      // 设备 input-event-daemon 空闲 30s 降屏 / 60s 息屏 / 600s 关机；
      // 播放期间没有触摸事件，需定时调 hal-screen keep 续亮（单次约 30s）。
      this._stopKeepScreen();
      if (this._shExec('hal-screen keep')) {
        this._keepScreenTimer = this.$page.setInterval(() => {
          this._shExec('hal-screen keep');
        }, 20000);
        console.warn('[Screen] keep on');
      }
    },
    _stopKeepScreen() {
      try {
        if (this._keepScreenTimer) {
          this.$page.clearInterval(this._keepScreenTimer);
          this._keepScreenTimer = null;
        }
      } catch (e) {}
    },
    // ---- 左栏长按显示名称（600ms） ----
    iconPressStart(name) {
      this.iconPressEnd();
      this._iconPressTimer = this.$page.setTimeout(() => {
        this.iconTip = name;
        this._iconTipTimer = this.$page.setTimeout(() => { this.iconTip = ''; }, 1200);
      }, 600);
    },
    iconPressEnd() {
      if (this._iconPressTimer) { this.$page.clearTimeout(this._iconPressTimer); this._iconPressTimer = null; }
    },
    tabTitle() {
      const m = { feed: '首页推荐', search: '搜索', history: this.historySource === 'cloud' ? '云端历史' : '本地历史', fav: this.favTitle || '收藏夹', download: '缓存', login: '我的' };
      return m[this.currentTab] || '';
    },
    // 顶部动作栏的刷新：按当前页刷新对应数据，并给出可见的进度反馈
    async actionRefresh() {
      if (this.refreshing) return;
      const tab = this.currentTab;
      this.refreshing = true;
      this.refreshPct = 8;
      if (this._refreshAnim) this.$page.clearInterval(this._refreshAnim);
      // feed 接口没有真实百分比：用不确定态扫条 + 逐步逼近 90%，结束时补满。
      this._refreshAnim = this.$page.setInterval(() => {
        if (this.refreshPct < 90) this.refreshPct = this.refreshPct + (this.refreshPct < 40 ? 9 : 4);
      }, 120);
      const t0 = Date.now();
      let ok = true;
      try {
        await this._refreshTask(tab);
      } catch (e) {
        ok = false;
      }
      const wait = Math.max(0, 420 - (Date.now() - t0));
      this.$page.setTimeout(() => {
        if (this._refreshAnim) {
          this.$page.clearInterval(this._refreshAnim);
          this._refreshAnim = null;
        }
        this.refreshPct = 100;
        this.$page.setTimeout(() => {
          this.refreshing = false;
          this.refreshPct = 0;
        }, 260);
        if (!ok) this.showToast('刷新失败，请重试');
      }, wait);
    },
    _refreshTask(tab) {
      if (tab === 'feed') return this.fetchFeed();
      if (tab === 'search') return this.submitSearch();
      if (tab === 'history') return this.historySource === 'cloud' ? this.loadCloudHistory() : this.fetchHistory();
      if (tab === 'fav') return this.favTitle ? this.openFavFolder({ id: this._favFolderId || 0 }) : this.loadFavFolders();
      if (tab === 'download') return this.cacheSource === 'online' ? this.fetchCacheList() : this.fetchDownloads();
      return this.fetchUserInfo();
    },
    // ---- 2×2 网格翻页 ----
    gridList() {
      if (this.currentTab === 'feed') return this.videos || [];
      if (this.currentTab === 'history') return this.historySource === 'cloud' ? this.cloudHistory : (this.history || []);
      if (this.currentTab === 'fav') return this.favItems || [];
      if (this.currentTab === 'download') return this.cacheSource === 'online' ? (this.cacheItems || []) : (this.downloads || []);
      if (this.currentTab === 'search') return this.searchResults || [];
      return [];
    },
    gridPages() { return Math.max(1, Math.ceil(this.gridList().length / 4)); },
    // 网格可用高度：172 - 动作栏 26 - 搜索横幅 26 - 芯片行 24
    gridHeightPx() {
      let h = 146;
      if (this.currentTab === 'history') h -= 24;
      if (this.currentTab === 'search') h -= 50; // 横幅26 + 芯片24
      if (this.currentTab === 'download') h -= 24; // 在线缓存/离线下载 chip
      return h;
    },
    cardHeightPx() { return Math.floor(this.gridHeightPx() / 2) - 10; },
    thumbHeightPx() { return Math.max(24, this.cardHeightPx() - 12); },
    gridItems() {
      const list = this.gridList();
      const p = Math.min(this.gridPage || 0, this.gridPages() - 1);
      return list.slice(p * 4, p * 4 + 4);
    },
    gridCardFooter(item) {
      if (this.currentTab === 'history') {
        const t = this.historyTime ? this.historyTime(item.updated) : '';
        const pct = (item.duration > 0) ? Math.round((item.position / item.duration) * 100) : 0;
        return t + (pct > 0 ? (' · ' + pct + '%') : '');
      }
      if (this.currentTab === 'download') {
        if (this.cacheSource === 'online') {
          const b = this.formatBytes(item.bytes || 0);
          if (item.playing) return b + ' · 播放中';
          if (item.status === 'active') return b + ' · 缓存中';
          if (item.status === 'partial') return b + ' · 待续传';
          return b + ' · 在线缓存' + (item.duration > 0 ? (' · ' + this.fmtTime(item.duration)) : '');
        }
        if (item.status === 'completed') return this.formatBytes(item.total_bytes) + ' · 离线可播';
        if (item.status === 'downloading') return (item.progress || 0) + '% 下载中';
        if (item.status === 'paused') return (item.progress || 0) + '% · 已暂停（点按继续）';
        if (item.status === 'error') return (item.progress || 0) + '% · 已中断（点按续传）';
        return '排队中';
      }
      if (this.currentTab === 'fav') return item.owner ? ('UP ' + item.owner) : '';
      const dur = (item.duration > 0) ? (' · ' + this.fmtTime(item.duration)) : '';
      return (item.owner ? ('UP ' + item.owner) : '') + dur;
    },
    gridPrev() { if (this.gridPage > 0) this.gridPage -= 1; },
    gridNext() {
      if (this.gridPage < this.gridPages() - 1) {
        this.gridPage += 1;
        return;
      }
      // 已在最后一页按「下」：首页自动换一批并回到第一页；其它页回到第一页
      this.gridPage = 0;
      if (this.currentTab === 'feed') this.fetchFeed();
    },
    setHistorySource(s) {
      this.historySource = s;
      this.gridPage = 0;
      if (s === 'cloud') this.loadCloudHistory(); else this.fetchHistory();
    },
    async loadCloudHistory() {
      try {
        const res = await this.requestWithRetry({ url: 'http://127.0.0.1:18080/api/history/cloud', method: 'GET', timeout: 10000 });
        const d = safeJson(res.body, {});
        if (d && d.ok) { this.cloudHistory = d.items || []; this.gridPage = 0; }
        else { this.cloudHistory = []; this.showToast((d && d.message) || '云端历史获取失败'); }
      } catch (e) { this.cloudHistory = []; this.showToast('云端历史网络异常'); }
    },
    async loadFavFolders() {
      this.favLoading = true;
      this.favTitle = '';
      try {
        const res = await this.requestWithRetry({ url: 'http://127.0.0.1:18080/api/fav/folders', method: 'GET', timeout: 10000 });
        const d = safeJson(res.body, {});
        if (d && d.ok) { this.favFolders = d.items || []; this.gridPage = 0; }
        else { this.favFolders = []; this.showToast((d && d.message) || '收藏夹获取失败'); }
      } catch (e) { this.favFolders = []; this.showToast('收藏夹网络异常'); }
      this.favLoading = false;
    },
    async openFavFolder(folder) {
      this.favTitle = folder.title || '收藏夹';
      this._favFolderId = folder.id || 0;
      this.favLoading = true;
      this.gridPage = 0;
      try {
        const res = await this.requestWithRetry({ url: 'http://127.0.0.1:18080/api/fav/items?media_id=' + encodeURIComponent(folder.id), method: 'GET', timeout: 12000 });
        const d = safeJson(res.body, {});
        if (d && d.ok) { this.favItems = d.items || []; }
        else { this.favItems = []; this.showToast((d && d.message) || '收藏内容获取失败'); }
      } catch (e) { this.favItems = []; this.showToast('收藏内容网络异常'); }
      this.favLoading = false;
    },
    setSearchType(t) { this.searchType = t; if (this.searchInput) this.submitSearch(); },
    setSearchOrder(o) { this.searchOrder = o; if (this.searchInput) this.submitSearch(); },

    // ---- 播放页右栏：四标签 + 操作行 ----
    setDetailTab(t) {
      if (t === 'parts' && this.partsList.length <= 1) t = 'info';
      this.detailTab = t;
      if (t === 'parts' && this.partsList.length === 0) this.loadParts();
      if (t === 'comment' && this.comments.length === 0) this.loadComments();
      if (t === 'related' && this.relatedList.length === 0) this.loadRelated();
    },
    async loadParts() {
      const item = this._playItem; if (!item) return;
      try {
        const res = await http.request({ url: 'http://127.0.0.1:18080/api/parts?bvid=' + item.bvid, method: 'GET', timeout: 8000 });
        const d = safeJson(res.body, {});
        this.partsList = (d && d.items) ? d.items : [];
      } catch (e) { this.partsList = []; }
    },
    async loadRelated() {
      const item = this._playItem; if (!item) return;
      try {
        const res = await http.request({ url: 'http://127.0.0.1:18080/api/related?bvid=' + item.bvid, method: 'GET', timeout: 10000 });
        const d = safeJson(res.body, {});
        this.relatedList = (d && d.items) ? d.items : [];
      } catch (e) { this.relatedList = []; }
    },
    async loadComments() {
      const item = this._playItem; if (!item) return;
      try {
        const url = 'http://127.0.0.1:18080/api/comments?bvid=' + item.bvid + '&sort=' + this.commentSort + '&pn=' + this.commentPn;
        const res = await http.request({ url: url, method: 'GET', timeout: 10000 });
        const d = safeJson(res.body, {});
        this.comments = (d && d.items) ? d.items : [];
        this.commentCount = (d && d.count) ? d.count : 0;
      } catch (e) { this.comments = []; }
    },
    setCommentSort(s) { this.commentSort = s; this.commentPn = 1; this.comments = []; this.loadComments(); },
    commentNextPage() { this.commentPn += 1; this.loadComments(); },
    commentPrevPage() { if (this.commentPn > 1) { this.commentPn -= 1; this.loadComments(); } },
    toggleMore() { this.moreOpen = !this.moreOpen; },
    async _actionCall(path, okText) {
      const item = this._playItem || this.detailItem();
      if (!item) return null;
      try {
        const sep = path.indexOf('?') >= 0 ? '&' : '?';
        const res = await http.request({ url: 'http://127.0.0.1:18080' + path + sep + 'bvid=' + item.bvid, method: 'GET', timeout: 8000 });
        const d = safeJson(res.body, {});
        if (d && d.ok) { this.showToast(okText || '操作成功'); return d; }
        this.showToast((d && d.message) || '操作失败');
        return d || null;
      } catch (e) { this.showToast('网络异常'); return null; }
    },
    async loadRelation() {
      const item = this._playItem; if (!item) return;
      try {
        const res = await http.request({ url: 'http://127.0.0.1:18080/api/action/relation?bvid=' + item.bvid, method: 'GET', timeout: 8000 });
        const d = safeJson(res.body, {});
        if (Date.now() - (this._actionAt || 0) < 1500) return; // 刚点过，别用旧值覆盖
        if (d && d.logged_in) {
          this.relation = { like: d.like, coin: d.coin, favorite: d.favorite };
          this.likeState = d.like ? 1 : 0;
          this.coinState = d.coin ? 1 : 0;
          this.favState = d.favorite ? 1 : 0;
        } else {
          this.relation = null;
        }
      } catch (e) { this.relation = null; }
    },
    // 互动按钮：本地立即反映（高亮+计数），并防连点；成功后再回读服务端校准
    async doLike() {
      if (this._likeBusy) return;
      this._likeBusy = true;
      const target = this.likeState ? 0 : 1;
      const d = await this._actionCall('/api/action/like?like=' + target, target ? '已点赞' : '已取消赞');
      if (d && d.ok) {
        this.likeState = target;
        this.likeCount = Math.max(0, (this.likeCount || 0) + (target ? 1 : -1));
        this._actionAt = Date.now();
      } else if (d && /重复/.test(d.message || '')) {
        // B站 对已点赞再点赞会返回「重复点赞」：视为已赞，纠正本地状态
        this.likeState = 1;
      }
      this._likeBusy = false;
    },
    async doCoin() {
      if (this._coinBusy) return;
      this._coinBusy = true;
      const d = await this._actionCall('/api/action/coin?num=1', '已投币');
      if (d && d.ok) { this.coinState = 1; this._actionAt = Date.now(); }
      this._coinBusy = false;
    },
    async doFav() {
      if (this._favBusy) return;
      this._favBusy = true;
      const target = this.favState ? 0 : 1;
      const d = await this._actionCall('/api/action/fav?add=' + target, target ? '已收藏到默认收藏夹' : '已取消收藏');
      if (d && d.ok) { this.favState = target; this._actionAt = Date.now(); }
      this._favBusy = false;
    },
    async doToview() { this.moreOpen = false; await this._actionCall('/api/toview/add', '已加入稍后再看'); },
    async doTriple() {
      this.moreOpen = false;
      await this.doLike(); await this.doCoin(); await this.doFav();
      this.showToast('一键三连完成');
    },
    seekRelative(delta) {
      if (!this.isPlaying || this.audioMode) return;
      const t = Math.max(0, Math.round((this.curPos || 0) + delta));
      console.warn('[Seek] relative ' + delta + 's -> ' + t + 's');
      this.seekTo(t);
    },
    async playPart(pt) {
      const item = this._playItem; if (!item) return;
      try {
        await http.request({ url: 'http://127.0.0.1:18080/api/selectcid?bvid=' + item.bvid + '&cid=' + pt.cid, method: 'GET', timeout: 4000 });
      } catch (e) {}
      this.showToast('切换到 P' + pt.page);
      // 直接在本页重开播放（不跳详情页）；P 号持久显示在右侧标题里
      const page = pt.page;
      const partTitle = pt.part || '';
      this.stop();
      this.$page.setTimeout(() => {
        this.currentPartPage = page;
        this.currentPartTitle = partTitle;
        const ss = this.srcSize || { w: 640, h: 360 };
        this.startNativeVideo(Object.assign({}, item, { title: partTitle || item.title }), { width: ss.w || 640, height: ss.h || 360 });
      }, 700);
    },
    playRelated(rv) {
      this.stop();
      this.$page.setTimeout(() => { this.openDetail(rv); }, 700);
    },
    switchTab(tab) {
      if (this.isPlaying) {
        this.stop();
      }
      this.currentView = 'home';
      this.detail = null;
      this.currentTab = tab;
      this.gridPage = 0; // 切tab回到第一页
      if (tab === 'login') {
        if (!this.isLoggedIn) {
          this.refreshQr();
        } else {
          this.fetchUserInfo();
        }
      } else if (tab === 'history') {
        if (this.historySource === 'cloud') this.loadCloudHistory(); else this.fetchHistory();
      } else if (tab === 'download') {
        this.fetchCacheList();
        this.fetchDownloads();
      } else if (tab === 'fav') {
        this.favTitle = '';
        this.favItems = [];
        this.loadFavFolders();
      } else if (tab === 'search') {
        this.submitSearch();
      }
    },
    historyTime(ts) {
      const t = Number(ts) || 0;
      if (!t) return '';
      const d = new Date(t * 1000);
      const p = (n) => (n < 10 ? '0' + n : '' + n);
      return (d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
    },
    async fetchHistory() {
      this.loadingHistory = true;
      try {
        const res = await http.request({
          url: 'http://127.0.0.1:18080/api/history',
          method: 'GET',
          timeout: 4000
        });
        const data = safeJson(res.body, {});
        this.history = (data && data.items) ? data.items : [];
        console.warn('[History] items=' + this.history.length);
      } catch (e) {
        this.history = [];
      }
      this.loadingHistory = false;
    },
    recordHistory(item, position, duration) {
      try {
        if (!item || !item.bvid) return;
        const title = item.title || this.currentTitle || '';
        const pic = item.pic || item.pic_local || '';
        const pos = Number(position) || 0;
        const dur = Number(duration) || 0;
        const url = 'http://127.0.0.1:18080/api/history/add?bvid=' + encodeURIComponent(item.bvid) +
          '&title=' + encodeURIComponent(title) + '&pic=' + encodeURIComponent(pic) +
          '&position=' + pos.toFixed(1) + '&duration=' + dur.toFixed(1);
        http.request({ url: url, method: 'GET', timeout: 2500 }).catch(() => {});
      } catch (e) {}
    },
    async clearHistory() {
      try {
        await http.request({ url: 'http://127.0.0.1:18080/api/history/clear', method: 'GET', timeout: 3000 });
      } catch (e) {}
      this.fetchHistory();
    },
    async fetchUserInfo() {
      try {
        const res = await http.request({
          url: 'http://127.0.0.1:18080/api/user/info',
          method: 'GET',
          timeout: 4000
        });
        const data = safeJson(res.body, {});
        // 后端历史上返回 is_login，新接口返回 logged_in —— 两个都认
        const logged = !!(data && (data.logged_in || data.is_login));
        if (logged) {
          this.isLoggedIn = true;
          this.user = { uname: data.uname, mid: data.mid, face: data.face };
        } else {
          this.isLoggedIn = false;
          this.user = { uname: '', mid: 0, face: '' };
        }
      } catch (e) {}
    },
    async fetchTrending() {
      // 热点搜索已移除，保留该方法仅为兼容旧入口（当前无调用方）。
      return;
    },
    async fetchFeed(attempt) {
      attempt = attempt || 0;
      if (this.loadingFeed) return false;
      this.loadingFeed = true;
      this.statusText = attempt > 0 ? ('等待后端就绪(' + attempt + ')...') : '拉取新推荐...';
      let ok = false;
      try {
        const res = await this.requestWithRetry({
          url: 'http://127.0.0.1:18080/api/feed',
          method: 'GET',
          timeout: 12000
        });
        const data = safeJson(res.body, null);
        const list = Array.isArray(data) ? data : (data && data.items ? data.items : null);
        if (Array.isArray(list) && list.length > 0) {
          this.videos = list;
          this.statusText = '推荐就绪 (' + list.length + '条)';
          ok = true;
        } else if (data && data.error) {
          console.warn('[Feed] daemon error: ' + data.error);
        }
      } catch (err) {
        console.warn('[Feed] err: ' + (err && err.message ? err.message : err));
      }
      this.loadingFeed = false;
      if (ok) return true;
      if (attempt < 4) {
        // 装机后 app 可能先于 daemon 启动，这里自动重试几次，避免首页永久空白。
        await new Promise((resolve) => this.$page.setTimeout(resolve, 1200));
        return this.fetchFeed(attempt + 1);
      }
      this.statusText = '推荐加载失败，点击换一换';
      return false;
    },
    async doSearch(kw) {
      if (!kw || this.loadingSearch) return;
      this.searchInput = kw;
      this.loadingSearch = true;
      this.statusText = '搜索: ' + kw + '...';
      try {
        const res = await this.requestWithRetry({
          url: 'http://127.0.0.1:18080/api/search?keyword=' + encodeURIComponent(kw) +
               '&type=' + this.searchType + '&order=' + this.searchOrder,
          method: 'GET',
          timeout: 10000
        });
        const data = safeJson(res.body, []);
        // daemon 返回 {"items":[...]}；历史上也发过裸数组 —— 两种都吃
        const list = Array.isArray(data) ? data : ((data && data.items) ? data.items : []);
        if (list.length > 0) {
          this.searchResults = list;
          this.statusText = '找到 ' + list.length + ' 个结果';
        } else {
          this.statusText = '未找到相关视频';
        }
      } catch (e) {
        this.statusText = '搜索超时，请重试';
      } finally {
        this.loadingSearch = false;
      }
    },
    onSearchInput(e) {
      let v = '';
      if (e && e.detail && e.detail.value !== undefined) v = e.detail.value;
      else if (e && e.target && e.target.value !== undefined) v = e.target.value;
      else if (e && e.value !== undefined) v = e.value;
      this.searchInput = String(v === undefined || v === null ? '' : v);
    },
    _falconObj() {
      try { if (typeof $falcon !== 'undefined' && $falcon) return $falcon; } catch (e) {}
      try { if (globalThis && globalThis.$falcon) return globalThis.$falcon; } catch (e) {}
      return null;
    },
    _initImeApi() {
      // 原生输入法 API 由 /etc/miniapp/jsapis/libjsapi_export_core.so 提供：
      // import('global').default.Global 是构造函数，实例上才有
      // startTextEdit / closeTextEdit / textEditFinished 等（$falcon.startTextEdit 在本机不存在）。
      const self = this;
      try {
        import('global').then(function (m) {
          const mod = (m && m.default) ? m.default : m;
          const Ctor = (mod && mod.Global) ? mod.Global : null;
          if (typeof Ctor !== 'function') {
            console.warn('[IME] Global constructor not found');
            return;
          }
          const inst = new Ctor();
          self._imeApi = inst;
          const sig = inst.textEditFinished;
          console.warn('[IME] instance ready start=' + (typeof inst.startTextEdit) +
            ' close=' + (typeof inst.closeTextEdit) + ' sig=' + (typeof sig) +
            ' sigOn=' + !!(sig && typeof sig.on === 'function'));
          self._bindTextEditFinished();
        }).catch(function (e) {
          console.warn('[IME] import global failed: ' + e);
        });
      } catch (e) {
        console.warn('[IME] import global throw: ' + e);
      }
    },
    _imeObj() {
      if (this._imeApi) return this._imeApi;
      const f = this._falconObj();
      if (f && typeof f.startTextEdit === 'function') return f;
      return null;
    },
    _logImeSupport() {
      const f = this._falconObj();
      console.warn('[IME] falcon=' + !!f + ' falcon.startTextEdit=' + (f && typeof f.startTextEdit));
      return false;
    },
    _bindTextEditFinished() {
      if (this._imeBound) return;
      const f = this._imeObj();
      if (!f) return;
      const self = this;
      // 必须完整转发所有参数：该信号实际回调为 (taskUuid, resultJson)，
      // 若包装函数只声明一个参数，第二个参数（结果 JSON）会被丢掉。
      const cb = function () { self._onTextEditFinished.apply(self, arguments); };
      try {
        if (f.textEditFinished && typeof f.textEditFinished.on === 'function') {
          f.textEditFinished.on(cb);
          this._imeCb = cb;
          this._imeBound = 'signal';
          console.warn('[IME] textEditFinished bound (signal)');
          return;
        }
        if (typeof f.on === 'function') {
          f.on('textEditFinished', cb);
          this._imeCb = cb;
          this._imeBound = 'event';
          console.warn('[IME] textEditFinished bound (event)');
        }
      } catch (e) {
        console.warn('[IME] bind error: ' + e);
      }
    },
    _unbindTextEditFinished() {
      const f = this._imeObj();
      try {
        if (this._imeCb && f && this._imeBound === 'signal' && f.textEditFinished && typeof f.textEditFinished.off === 'function') {
          f.textEditFinished.off(this._imeCb);
        } else if (this._imeCb && f && this._imeBound === 'event' && typeof f.off === 'function') {
          f.off('textEditFinished', this._imeCb);
        }
      } catch (e) {}
      this._imeCb = null;
      this._imeBound = false;
    },
    _onTextEditFinished() {
      // 实测该信号回调的第一个参数是 taskUuid，真正的结果 JSON 在后续参数中，
      // 因此遍历所有参数、对字符串逐个尝试 JSON.parse，找到含 editConfirmed/text 的对象。
      const n = arguments.length;
      const raw = [];
      for (let i = 0; i < n; i++) {
        try {
          let v = arguments[i];
          if (v && typeof v === 'object') {
            try { v = JSON.stringify(v); } catch (e) { v = '[object]'; }
          }
          raw.push(String(v));
        } catch (e) { raw.push('?'); }
      }
      console.warn('[IME] raw args n=' + n + ' [' + raw.join(' || ').slice(0, 600) + ']');

      let result = null;
      for (let i = 0; i < n; i++) {
        let cand = arguments[i];
        if (cand && typeof cand === 'object') {
          if (cand.text !== undefined || cand.editConfirmed !== undefined) { result = cand; break; }
          continue;
        }
        if (typeof cand !== 'string' || cand.length === 0) continue;
        try {
          const obj = JSON.parse(cand);
          if (obj && typeof obj === 'object' && (obj.text !== undefined || obj.editConfirmed !== undefined)) {
            result = obj;
            break;
          }
        } catch (e) {}
        // 兼容被二次编码的 JSON 字符串
        const idx = cand.indexOf('{');
        if (idx > 0) {
          try {
            const obj2 = JSON.parse(cand.slice(idx));
            if (obj2 && typeof obj2 === 'object' && (obj2.text !== undefined || obj2.editConfirmed !== undefined)) {
              result = obj2;
              break;
            }
          } catch (e) {}
        }
      }

      this._textEditUuid = null;
      if (!result) {
        console.warn('[IME] finished but result not parsed');
        return;
      }
      console.warn('[IME] finished confirmed=' + result.editConfirmed + ' text=' + result.text);
      if (result.text !== undefined && result.text !== null) this.searchInput = String(result.text);
      if (result.editConfirmed !== false && (this.searchInput || '').trim()) {
        this.doSearch(this.searchInput.trim());
      }
    },
    _cancelTextEdit() {
      const f = this._imeObj();
      try {
        if (this._textEditUuid && f && typeof f.closeTextEdit === 'function') f.closeTextEdit(this._textEditUuid);
      } catch (e) {}
      this._textEditUuid = null;
    },
    openKeyboard() {
      // 调起宿主原生输入法：API 由 jsapi_export_core 的 "global" 模块提供（$falcon.startTextEdit 在本机不存在）。
      try {
        const f = this._imeObj();
        if (f && typeof f.startTextEdit === 'function') {
          this._bindTextEditFinished();
          const cfg = {
            inputType: 'text',
            enterButtonText: '搜索',
            confirmButtonDisabledOnTextEmpty: true,
            multiLinesEditVisible: false,
            capsLockSwitchOn: false,
            showCursor: true
          };
          const uuid = f.startTextEdit(JSON.stringify(cfg));
          console.warn('[IME] startTextEdit uuid=' + uuid);
          if (uuid) {
            this._textEditUuid = uuid;
            return;
          }
        }
      } catch (e) {
        console.warn('[IME] startTextEdit error: ' + e);
      }
      // 回退：自绘键盘（原生输入法不可用时）
      this.kbVisible = true;
      console.warn('[Kb] open (fallback)');
    },
    closeKeyboard() {
      this.kbVisible = false;
      console.warn('[Kb] close');
    },
    kbType(k) {
      if (!k) return;
      if (k === '⌫') {
        this.searchInput = this.searchInput.slice(0, -1);
        return;
      }
      if (k === '空格') {
        this.searchInput = this.searchInput + ' ';
        return;
      }
      if (k === '清空') {
        this.searchInput = '';
        return;
      }
      if (k === '搜索') {
        this.kbSearch();
        return;
      }
      if (this.searchInput.length >= 30) return;
      this.searchInput = this.searchInput + k;
    },
    kbSearch() {
      const kw = (this.searchInput || '').trim();
      this.kbVisible = false;
      console.warn('[Kb] search kw=' + kw);
      if (kw) this.doSearch(kw);
    },
    submitSearch() {
      const kw = (this.searchInput || '').trim();
      if (!kw || this.loadingSearch) return Promise.resolve(false);
      return this.doSearch(kw);
    },
    clearSearchInput() {
      this.searchInput = '';
      this.searchResults = [];
      this.statusText = '';
      console.warn('[Search] input cleared');
    },
    showToast(msg) {
      this.toast = msg;
      if (this._toastTimer) this.$page.clearTimeout(this._toastTimer);
      this._toastTimer = this.$page.setTimeout(() => { this.toast = ''; }, 2200);
    },
    formatDur(sec) {
      const s = Number(sec) || 0;
      const m = Math.floor(s / 60);
      const ss = Math.floor(s % 60);
      return m + ':' + (ss < 10 ? '0' + ss : ss);
    },
    fmtTime(sec) {
      const s = Math.max(0, Math.floor(Number(sec) || 0));
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      const ss = s % 60;
      const mm = (h > 0 && m < 10) ? ('0' + m) : ('' + m);
      const sss = ss < 10 ? ('0' + ss) : ('' + ss);
      return (h > 0 ? (h + ':' + mm) : mm) + ':' + sss;
    },
    // 单击画面：唤出/收起底部控制条（双击暂停，避免误触）
    onPlayerAreaClick(e) {
      const now = Date.now();
      if (this._lastAreaClickAt && now - this._lastAreaClickAt < 350) {
        this._lastAreaClickAt = 0;
        this.togglePause(e);
        return;
      }
      this._lastAreaClickAt = now;
      this.toggleCtrlBar();
    },
    toggleCtrlBar() {
      if (this.ctrlVisible) {
        this.ctrlVisible = false;
        if (this._ctrlHideTimer) { this.$page.clearTimeout(this._ctrlHideTimer); this._ctrlHideTimer = null; }
        return;
      }
      this._showCtrlBar();
    },
    _showCtrlBar() {
      this.ctrlVisible = true;
      if (this._ctrlHideTimer) { this.$page.clearTimeout(this._ctrlHideTimer); this._ctrlHideTimer = null; }
      // 播放中 3.5s 后自动收起，暂停/封面/错误态常显
      if (this.playerState === 'playing' && !this.isPaused) {
        this._ctrlHideTimer = this.$page.setTimeout(() => {
          this._ctrlHideTimer = null;
          if (this.playerState === 'playing' && !this.isPaused) this.ctrlVisible = false;
        }, 3500);
      }
    },
    _hideCtrlBar() {
      this.ctrlVisible = false;
      if (this._ctrlHideTimer) { this.$page.clearTimeout(this._ctrlHideTimer); this._ctrlHideTimer = null; }
    },
    togglePause(e) {
      if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
      // 避免点击进度条或刚刚拖动 Seek 时误触背景切换暂停
      const now = Date.now();
      if (this._lastSeekAt && now - this._lastSeekAt < 600) return;
      if (this._lastTouchSeekAt && now - this._lastTouchSeekAt < 600) return;
      if (!this.isPlaying || this.isStopping) return;
      if (this.playerState === 'loading' || this.playerState === 'seeking' || this.playerState === 'error') return;
      // 封面态（首帧暂停、音频未起）：点播放键走 resumeFromCover，而不是简单 unpause。
      if (this.playerState === 'ready-paused' && this.coverHold) {
        this.resumeFromCover();
        return;
      }
      const next = !this.isPaused;
      this.isPaused = next;
      this._audioSyncingPaused = false;
      if (next) {
        // 暂停：视频解码线程原地等待 + 音频设备暂停，两边内容时间都不再推进。
        try { if (this.rgav && typeof this.rgav.pause === 'function') this.rgav.pause(); } catch (e) {}
        try { if (this.audioPlayer && typeof this.audioPlayer.pause === 'function') this.audioPlayer.pause(); } catch (e) {}
        try { if (this.vPlayer && typeof this.vPlayer.pause === 'function') this.vPlayer.pause(); } catch (e) {}
        this._setPlayerState('ready-paused');
        this.coverHold = false;
        this.statusText = '已暂停';
        this.ctrlVisible = true;
        console.warn('[Player] paused');
      } else {
        try { if (this.rgav && typeof this.rgav.unpause === 'function') this.rgav.unpause(); } catch (e) {}
        try { if (this.audioPlayer && typeof this.audioPlayer.resume === 'function') this.audioPlayer.resume(); } catch (e) {}
        try { if (this.vPlayer && typeof this.vPlayer.resume === 'function') this.vPlayer.resume(); } catch (e) {}
        this._setPlayerState('playing');
        this._startedAt = Date.now();
        this._lastAdvanceAt = Date.now();
        this._bufLastAt = Date.now();
        this._bufLastPos = 0;
        this.statusText = '';
        this._showCtrlBar();
        console.warn('[Player] resumed');
      }
    },
    _updateProgress() {
      if (!this.isPlaying || this.audioMode) return;
      const now = Date.now();
      // 200ms + 0.1s 死区：旧实现 400ms/0.2s 会让进度条每 0.4s 跳一格，观感很卡
      if (now - (this._progAt || 0) < 200) return;
      this._progAt = now;
      // 拖动中才冻结刷新；_seekPreview 若因设备不送 touchend 而残留，由下面的看门狗清掉
      if (this._progressDragging) return;
      const pos = this._lastPos || 0;
      const dur = this.vDuration || 0;
      if (pos > 0 && Math.abs(pos - (this.curPos || 0)) >= 0.1) this.curPos = pos;
      if (dur > 0) {
        let p = pos / dur;
        if (!isFinite(p) || p < 0) p = 0;
        if (p > 1) p = 1;
        this.progress = p;
      }
    },
    formatCount(n) {
      const v = Number(n) || 0;
      if (v >= 100000000) return (v / 100000000).toFixed(1) + '亿';
      if (v >= 10000) return (v / 10000).toFixed(1) + '万';
      return String(v);
    },
    formatBytes(bytes) {
      const b = Number(bytes) || 0;
      if (b <= 0) return '0 B';
      if (b >= 1073741824) return (b / 1073741824).toFixed(1) + ' GB';
      if (b >= 1048576) return (b / 1048576).toFixed(1) + ' MB';
      if (b >= 1024) return (b / 1024).toFixed(0) + ' KB';
      return b + ' B';
    },
    async fetchDownloads() {
      try {
        const res = await this.requestWithRetry({
          url: 'http://127.0.0.1:18080/api/download/list',
          method: 'GET',
          timeout: 6000
        });
        const data = safeJson(res.body, {});
        if (data && data.items) {
          this.downloads = data.items;
          this.downloadFreeText = data.free_text || '';
          const hasActive = this.downloads.some(d => d.status === 'downloading' || d.status === 'pending');
          if (hasActive && this.currentTab === 'download') {
            if (this._dlListTimer) this.$page.clearTimeout(this._dlListTimer);
            this._dlListTimer = this.$page.setTimeout(() => {
              if (this.currentTab === 'download') this.fetchDownloads();
            }, 1200);
          }
        }
      } catch (e) {
        console.warn('[Download] fetch error: ' + e);
      }
    },
    setCacheSource(s) {
      this.cacheSource = s;
      this.gridPage = 0;
      if (s === 'online') this.fetchCacheList(); else this.fetchDownloads();
    },
    cacheSummary() {
      if (this.cacheSource === 'offline') {
        return this.downloadFreeText ? ('剩余 ' + this.downloadFreeText) : '';
      }
      return '已用 ' + this.formatBytes(this.cacheTotalBytes || 0) + ' / ' + this.formatBytes(this.cacheCapBytes || 0);
    },
    gridEmptyText() {
      if (this.currentTab === 'download') {
        return this.cacheSource === 'online' ? '暂无在线缓存，播放过的视频会自动缓存' : '暂无离线下载';
      }
      if (this.loadingFeed || this.loadingSearch || this.favLoading) return '加载中...';
      return '暂无内容，点右上角刷新';
    },
    async fetchCacheList() {
      try {
        const res = await this.requestWithRetry({
          url: 'http://127.0.0.1:18080/api/cache/list',
          method: 'GET',
          timeout: 6000
        });
        const data = safeJson(res.body, {});
        if (data && data.items) {
          this.cacheItems = data.items;
          this.cacheTotalBytes = data.total_bytes || 0;
          this.cacheCapBytes = data.cap_bytes || 0;
          this.cacheFreeText = data.free_text || '';
          const hasActive = this.cacheItems.some(d => d.status === 'active');
          if (hasActive && this.currentTab === 'download' && this.cacheSource === 'online') {
            if (this._cacheTimer) this.$page.clearTimeout(this._cacheTimer);
            this._cacheTimer = this.$page.setTimeout(() => {
              if (this.currentTab === 'download' && this.cacheSource === 'online') this.fetchCacheList();
            }, 1500);
          }
        }
      } catch (e) {
        console.warn('[Cache] fetch error: ' + e);
      }
    },
    confirmDeleteCache(bvid) {
      if (!bvid) return;
      const now = Date.now();
      if (this._cacheDelBvid !== bvid || !this._cacheDelUntil || now > this._cacheDelUntil) {
        this._cacheDelBvid = bvid;
        this._cacheDelUntil = now + 3000;
        this.showToast('再点一次「删除」确认（3 秒内）');
        return;
      }
      this._cacheDelBvid = '';
      this._cacheDelUntil = 0;
      this.deleteCache(bvid);
    },
    confirmDeleteDownload(bvid) {
      if (!bvid) return;
      const now = Date.now();
      if (this._dlDelBvid !== bvid || !this._dlDelUntil || now > this._dlDelUntil) {
        this._dlDelBvid = bvid;
        this._dlDelUntil = now + 3000;
        this.showToast('再点一次「删除」确认（3 秒内）');
        return;
      }
      this._dlDelBvid = '';
      this._dlDelUntil = 0;
      this.deleteDownload(bvid);
    },
    // 收藏夹内移除单条（调 B站 del_media_ids），成功后就地删掉卡片
    async removeFromFav(item) {
      if (!item || !item.bvid) return;
      const mid = this._favFolderId || 0;
      if (!mid) { this.showToast('请先打开一个收藏夹'); return; }
      try {
        const res = await http.request({
          url: 'http://127.0.0.1:18080/api/action/fav?add=0&media_id=' + encodeURIComponent(mid) + '&bvid=' + item.bvid,
          method: 'GET',
          timeout: 8000
        });
        const d = safeJson(res.body, {});
        if (d && d.ok) {
          this.favItems = (this.favItems || []).filter(x => x && x.bvid !== item.bvid);
          this.showToast('已移出收藏夹');
        } else {
          this.showToast((d && d.message) || '移除失败');
        }
      } catch (e) {
        this.showToast('移除失败');
      }
    },
    async deleteCache(bvid) {
      try {
        const res = await http.request({
          url: 'http://127.0.0.1:18080/api/cache/delete?bvid=' + bvid,
          method: 'GET',
          timeout: 5000
        });
        const d = safeJson(res.body, {});
        if (d && d.ok) this.showToast('已清理 ' + this.formatBytes(d.freed_bytes || 0));
        else this.showToast((d && d.error) || '删除失败');
      } catch (e) {
        this.showToast('删除失败');
      }
      this.fetchCacheList();
    },
    async clearCache() {
      const now = Date.now();
      if (!this._clearCacheUntil || now > this._clearCacheUntil) {
        this._clearCacheUntil = now + 3000;
        this.showToast('再点一次「清空全部」确认（3 秒内）');
        return;
      }
      this._clearCacheUntil = 0;
      try {
        const res = await http.request({
          url: 'http://127.0.0.1:18080/api/cache/clear',
          method: 'GET',
          timeout: 8000
        });
        const d = safeJson(res.body, {});
        if (d && d.ok) this.showToast('已清理 ' + this.formatBytes(d.freed_bytes || 0));
        else this.showToast('清理失败');
      } catch (e) {
        this.showToast('清理失败');
      }
      this.fetchCacheList();
    },
    async checkDetailDownload(bvid) {
      if (!bvid) return;
      try {
        const res = await this.requestWithRetry({
          url: 'http://127.0.0.1:18080/api/download/status?bvid=' + bvid,
          method: 'GET',
          timeout: 4000
        });
        const data = safeJson(res.body, {});
        if (data && data.status) {
          this.updateDownloadStatus(data.status, data.item);
          if (data.status === 'downloading' || data.status === 'pending') {
            if (this._dlDetailTimer) this.$page.clearTimeout(this._dlDetailTimer);
            this._dlDetailTimer = this.$page.setTimeout(() => {
              if (this.currentView === 'detail' && this.detailItem() && this.detailItem().bvid === bvid) {
                this.checkDetailDownload(bvid);
              }
            }, 1200);
          }
        }
      } catch (e) {}
    },
    updateDownloadStatus(status, item) {
      if (status === 'completed') {
        this.detailDownload = { status: 'completed', progress: 100, text: '✓ 离线可用' };
      } else if (status === 'downloading') {
        const prog = (item && item.progress) || 0;
        this.detailDownload = { status: 'downloading', progress: prog, text: '⏳ 下载中 ' + prog + '%' };
      } else if (status === 'pending') {
        this.detailDownload = { status: 'pending', progress: 0, text: '⏳ 排队中...' };
      } else if (status === 'error') {
        const ep = (item && item.progress) || 0;
        this.detailDownload = { status: 'error', progress: ep, text: '⚠ 下载失败，点按续传' };
      } else {
        this.detailDownload = { status: 'none', progress: 0, text: '⬇ 下载' };
      }
    },
    async onDetailDownloadClick() {
      const item = this.detailItem();
      if (!item || !item.bvid) return;
      if (this.detailDownload.status === 'completed') {
        this.showToast('视频已下载，支持完全离线播放');
        return;
      }
      if (this.detailDownload.status === 'downloading' || this.detailDownload.status === 'pending') {
        this.showToast('正在下载中: ' + (this.detailDownload.progress || 0) + '%');
        return;
      }
      this.showToast('已加入离线下载队列');
      this.detailDownload = { status: 'downloading', progress: 0, text: '⏳ 启动中...' };
      try {
        const res = await this.requestWithRetry({
          url: 'http://127.0.0.1:18080/api/download/start?bvid=' + item.bvid,
          method: 'GET',
          timeout: 8000
        });
        const data = safeJson(res.body, {});
        if (data && data.status) {
          this.updateDownloadStatus(data.status, data.item);
          this.checkDetailDownload(item.bvid);
        }
      } catch (e) {
        this.showToast('下载请求失败');
        this.detailDownload = { status: 'none', progress: 0, text: '⬇ 下载' };
      }
    },
    // 网格卡片点击：下载页里「下载中/已暂停/失败」的项点一下就是暂停/继续，其余进详情
    onGridCardTap(item) {
      if (Date.now() - (this._cardTapAt || 0) < 600) return;
      if (this.currentTab === 'download' && this.cacheSource === 'offline') {
        const st = (item && item.status) || '';
        if (st === 'downloading' || st === 'pending' || st === 'paused' || st === 'error') {
          this.toggleDownload(item);
          return;
        }
      }
      this.openDetail(item);
    },
    async toggleDownload(item) {
      if (!item || !item.bvid) return;
      const st = item.status || '';
      const act = (st === 'downloading' || st === 'pending') ? 'pause' : 'start';
      try {
        const res = await http.request({
          url: 'http://127.0.0.1:18080/api/download/' + act + '?bvid=' + item.bvid,
          method: 'GET',
          timeout: 8000
        });
        const d = safeJson(res.body, {});
        if (d && d.ok) this.showToast(act === 'pause' ? '已暂停下载' : '已继续下载');
        else this.showToast((d && d.message) || (act === 'pause' ? '暂停失败' : '继续失败'));
      } catch (e) {
        this.showToast('操作失败');
      }
      this.fetchDownloads();
    },
    async deleteDownload(bvid) {
      if (!bvid) return;
      try {
        await http.request({
          url: 'http://127.0.0.1:18080/api/download/delete?bvid=' + bvid,
          method: 'GET',
          timeout: 4000
        });
        this.showToast('已删除离线文件');
        this.fetchDownloads();
        if (this.currentView === 'detail' && this.detailItem() && this.detailItem().bvid === bvid) {
          this.detailDownload = { status: 'none', progress: 0, text: '⬇ 下载' };
        }
      } catch (e) {
        this.showToast('删除失败');
      }
    },
    dt(key) {
      const d = this.detail || {};
      const data = d.data || {};
      if (data[key] !== undefined && data[key] !== null && data[key] !== '') return data[key];
      const item = d.item || {};
      return item[key] !== undefined && item[key] !== null ? item[key] : '';
    },
    thumbUrl(u) {
      // 远程封面统一走 B 站图片处理后缀：避免解码 2558x1439 这类大图（14MB+ 位图），
      // 那是设备内存/CPU 的压力源（日志里的 "BitmapFactory: image is too too large" 即此）。
      // 本地缩略图（covers/xxx.jpg）直接返回。
      if (!u) return '';
      if (u.indexOf('http') !== 0) return u;
      if (u.indexOf('@') >= 0) return u;
      return u + '@320w_180h.jpg';
    },
    detailSrc() {
      const d = this.detail || {};
      const data = d.data || {};
      const item = d.item || {};
      return this.thumbUrl(data.pic_local || data.pic || item.pic_local || item.pic || '');
    },
    detailMeta() {
      const up = this.dt('owner') || '未知UP';
      const dur = this.formatDur(this.dt('duration'));
      const v = this.dt('view');
      return 'UP: ' + up + ' · ' + dur + (v ? (' · ' + this.formatCount(v) + '播放') : '');
    },
    async openDetail(item) {
      // 搜索结果里的 UP 主卡片没有 bvid：改为按 TA 的名字搜视频
      if (item && !item.bvid && item.mid) {
        this.showToast('查看 UP 主: ' + (item.title || ''));
        this.searchType = 'video';
        this.searchOrder = 'totalrank';
        this.doSearch(item.title || '');
        return;
      }
      if (!item || !item.bvid) return;
      // 刚点过卡片角落的「移除/删除」按钮：事件冒泡过来的 click 不能当卡片点击
      if (Date.now() - (this._cardTapAt || 0) < 600) return;
      if (this.isStopping) return;
      if (this.isPlaying) this.stop();
      this.currentView = 'detail';
      this.detail = { item: item, data: null, loading: true, error: '' };
      this.detailDownload = { status: 'none', progress: 0, text: '⬇ 下载' };
      this.checkDetailDownload(item.bvid);
      this.statusText = '加载视频详情...';
      console.warn('[Detail] open ' + item.bvid);
      try {
        const res = await this.requestWithRetry({
          url: 'http://127.0.0.1:18080/api/detail?bvid=' + item.bvid,
          method: 'GET',
          timeout: 10000
        });
        const data = safeJson(res.body, null);
        if (!data || !data.title || data.error) throw new Error((data && data.error) || 'empty detail response');
        if (this.detail && this.detail.item && this.detail.item.bvid === item.bvid) {
          this.detail = { item: item, data: data, loading: false, error: '' };
        }
        console.warn('[Detail] ok ' + item.bvid + ' ' + (data.dimension ? (data.dimension.width + 'x' + data.dimension.height) : '?'));
      } catch (e) {
        console.warn('[Detail] failed ' + item.bvid + ': ' + (e && e.message));
        if (this.detail && this.detail.item && this.detail.item.bvid === item.bvid) {
          this.detail = { item: item, data: null, loading: false, error: '详情加载失败，仍可直接播放' };
        }
      }
    },
    closeDetail() {
      this.currentView = 'home';
      this.detail = null;
      if (this._dlDetailTimer) {
        this.$page.clearTimeout(this._dlDetailTimer);
        this._dlDetailTimer = null;
      }
    },
    detailItem() {
      return (this.detail && this.detail.item) ? this.detail.item : null;
    },
    detailData() {
      return (this.detail && this.detail.data) ? this.detail.data : {};
    },
    sideDesc() {
      const d = this.detailData() || {};
      let s = d.desc || '';
      if (!s) return '暂无简介';
      if (s.length > 90) s = s.slice(0, 90) + '…';
      return s;
    },
    _setPlayerState(s) {
      this.playerState = s;
      if (s === 'idle') this.isPaused = false;
      else if (s === 'ready-paused' || s === 'error') this.isPaused = true;
      else this.isPaused = false;
      if (s !== 'playing') this.buffering = false;
      // 控制条：播放中短暂显示后自动隐藏（不再长期压住画面底部）；暂停/错误常显
      if (s === 'playing') this._showCtrlBar();
      else if (s === 'ready-paused' || s === 'error') {
        this.ctrlVisible = true;
        if (this._ctrlHideTimer) { this.$page.clearTimeout(this._ctrlHideTimer); this._ctrlHideTimer = null; }
      }
      else if (s === 'loading' || s === 'seeking') this._hideCtrlBar();
      this._syncAnim();
    },
    _syncAnim() {
      const need = this.playerState === 'loading' || this.playerState === 'seeking' || this.playerState === 'error';
      if (need && !this._animTimer) {
        this._animTimer = this.$page.setInterval(() => {
          this.spinIdx = ((this.spinIdx || 0) + 1) % 4;
          this.sweepPct = (this.sweepPct >= 62) ? 0 : (this.sweepPct + 8);
        }, 120);
      } else if (!need && this._animTimer) {
        this.$page.clearInterval(this._animTimer);
        this._animTimer = null;
      }
    },
    spinChar() {
      return ['|', '/', '-', '\\'][this.spinIdx || 0];
    },
    _startVideoTick(gen) {
      this._stopVideoTick();
      const ctx = this.ctx;
      if (!ctx) return;
      this._vidTimer = this.$page.setInterval(() => {
        if (gen !== this.playGen) return;
        this._nativeTick(gen, ctx);
      }, 8);
    },
    _stopVideoTick() {
      if (this._vidTimer) {
        this.$page.clearInterval(this._vidTimer);
        this._vidTimer = null;
      }
    },
    _startStreamPoll(gen, bvid) {
      this._stopStreamPoll();
      if (!bvid) return;
      this._streamIdleCount = 0;
      this._streamDirectCount = 0;
      this._streamStartedAt = Date.now();
      this._streamPolls = 0;
      const tick = () => {
        if (gen !== this.playGen || this.isStopping || !this.isPlaying) {
          this._stopStreamPoll();
          return;
        }
        this._streamPolls = (this._streamPolls || 0) + 1;
        if (this._streamPolls > 120) {   // 60s 上限，防止 direct 流无限轮询
          this._stopStreamPoll();
          return;
        }
        const url = 'http://127.0.0.1:18080/api/stream/status?bvid=' + bvid +
          (this._seekOffset ? ('&ss=' + this._seekOffset) : '');
        http.request({ url: url, method: 'GET', timeout: 1200 }).then((res) => {
          if (gen !== this.playGen) return;
          const d = safeJson(res.body, {}) || {};
          const pct = (typeof d.percent === 'number') ? d.percent : -1;
          const src = d.source || '';
          if (pct !== this.streamPct) this.streamPct = pct;
          if (src !== this.streamSource) this.streamSource = src;
          const done = !!d.done;
          if (done !== this.streamDone) this.streamDone = done;
          if (src === 'direct' && Date.now() - (this._streamStartedAt || 0) > 3000) this._streamDirectCount++;
          else if (src !== 'direct') this._streamDirectCount = 0;
          if (src === 'idle') this._streamIdleCount++; else this._streamIdleCount = 0;
          if (!this._shouldKeepPoll()) this._stopStreamPoll();
        }).catch(() => {});
      };
      tick();
      this._streamPoll = this.$page.setInterval(tick, 500);
    },
    _stopStreamPoll() {
      if (this._streamPoll) {
        this.$page.clearInterval(this._streamPoll);
        this._streamPoll = null;
      }
    },
    _shouldKeepPoll() {
      if (this.streamDone) return false;
      if (this._streamDirectCount >= 2) return false;
      if (this._streamIdleCount >= 10) return false;
      const s = this.playerState;
      if (s === 'loading' || s === 'seeking') return true;
      if (s === 'playing' || s === 'ready-paused') return !this.streamDone;
      return false;
    },
    // 封面相位：primed 后 resume(0) 放行 sync_ready，读到第一帧立刻 pause。
    // 必须在 readFrame 成功后才能 pause，否则 readFrame 被 paused 门控，封面永远黑屏。
    _coverTick(gen, ctx, now) {
      if (gen !== this.playGen) { this._coverPhase = 0; return; }
      let inf = null;
      try { inf = this.rgav.info(); } catch (e) {}
      if (!inf) return;
      if (inf.finished) { this._handleAbnormalEnd(gen, inf, 'cover-eof'); return; }
      if (this._coverPhase === 'wait-prime') {
        if (now - (this._coverAt || now) > 6000) { this._handleAbnormalEnd(gen, inf, 'prime-timeout'); return; }
        if (!inf.primed) return;
        try { this.rgav.resume(0); } catch (e) {}
        this._coverPhase = 'acquire';
        return;
      }
      if (this._coverPhase === 'acquire') {
        let got = 0;
        try { got = this.rgav.readFrame(); } catch (e) {}
        if (!got) {
          if (now - (this._coverAt || now) > 6000) this._handleAbnormalEnd(gen, inf, 'cover-timeout');
          return;
        }
        try { ctx.putImageData(this.imageData, 0, 0); } catch (e) {}
        // 首帧已经在 JS 缓冲里，此刻冻结。native 的 unpause_delta 会把冻结时长补回 t0。
        try { this.rgav.pause(); } catch (e) {}
        this._coverPhase = 0;
        this.coverHold = true;
        this._lastPos = this._seekOffset || 0;
        this.curPos = this._seekOffset || 0;
        this._lastAdvanceAt = now;
        this._bufLastAt = now;
        this._bufLastPos = 0;
        this._stopVideoTick();
        this._stopStreamPoll();
        this._setPlayerState('ready-paused');
        this.ctrlVisible = false;
        console.warn('[Cover] held at ' + (this._seekOffset || 0) + 's primed=' + inf.primed);
        // 封面期就把音频链路预热到「已出声但被暂停」，点播放时音视频同帧开始，
        // 不必再等厂商播放器 3~4s 的启动（旧逻辑会先响几秒声音，视频才开始追）。
        this._prewarmAudio(gen);
      }
    },
    _prewarmAudio(gen) {
      const item = this._playItem;
      if (!item || this._audioPrewarm || this._audioParked) return;
      if (this.playerState !== 'ready-paused' || !this.coverHold) return;
      this._audioPrewarm = true;
      this._audioParkAt = 0;
      console.warn('[Cover] prewarm audio');
      this._startNativeAudio(gen, item);
    },
    _onBigPlay(e) {
      if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
      this.resumeFromCover();
    },
    resumeFromCover() {
      if (this.isStopping || this.playerState !== 'ready-paused' || !this.coverHold) return;
      const now = Date.now();
      if (this._lastBigPlayAt && now - this._lastBigPlayAt < 800) return;
      this._lastBigPlayAt = now;
      const gen = this.playGen;
      const item = this._playItem;
      if (!item) return;
      this.coverHold = false;
      this._coverResumed = true;
      this._syncDone = false;
      this._setPlayerState('playing');
      this._startedAt = now;
      this._lastAdvanceAt = now;
      this._bufLastAt = now;
      this._bufLastPos = 0;
      this._nextDue = 0;
      this._emptyTicks = 0;
      this._lastAudioNow = 0;
      this._lastAudioNowAt = 0;
      this._startStreamPoll(gen, item.bvid);
      if (this._audioParked && this.audioPlayer) {
        // 音频已预热并停在 parkedAt：此刻同时放行音视频，内容 0 点完全对齐
        const parkedAt = this._audioParkAt || 0;
        this._audioParked = false;
        this._audioPrewarm = false;
        this._audioParkAt = 0;
        try { if (typeof this.audioPlayer.resume === 'function') this.audioPlayer.resume(); } catch (e) {}
        this._syncResume(gen, 'cover-parked', parkedAt);
        console.warn('[Cover] resume both at ' + parkedAt.toFixed(2) + 's');
      } else {
        this._audioPrewarm = false;
        this._startAudioGate(gen, item);
        console.warn('[Cover] resume -> start audio (cold)');
      }
    },
    _startAudioGate(gen, item) {
      this._startNativeAudio(gen, item);
      if (this._syncTimer) this.$page.clearTimeout(this._syncTimer);
      this._syncTimer = this.$page.setTimeout(() => {
        this._syncResume(gen, 'fallback-timeout', this._audioPos || 0);
      }, 7000);
    },
    _isAbnormalEnd(info) {
      if (this.isStopping || this.audioMode) return false;
      let err = '';
      try { err = (this.rgav && typeof this.rgav.error === 'function') ? (this.rgav.error() || '') : ''; } catch (e) {}
      this._lastRgavErr = err;
      if (err && err !== 'eof') return true;
      const dur = this.vDuration || 0;
      if (dur <= 0) return false;
      const abs = (this._seekOffset || 0) + (Number(info && info.position) || 0);
      return abs < dur - 3;
    },
    _handleFinished(gen, info) {
      if (gen !== this.playGen) return;
      if (this._isAbnormalEnd(info)) {
        this._handleAbnormalEnd(gen, info, 'eof-mid');
        return;
      }
      const abs = (this._seekOffset || 0) + (Number(info && info.position) || 0);
      console.warn('[Rga] finished (normal) pos=' + abs.toFixed(1) + '/' + this.vDuration);
      this._stopStreamPoll();
      this.stop();
    },
    _handleAbnormalEnd(gen, info, why) {
      if (gen !== this.playGen || this.isStopping || this._retryBusy) return;
      this._retryBusy = true;
      this._seekBusy = false;
      this._pendingSeekTo = null;
      this._stopVideoTick();
      this._stopStreamPoll();
      this._stopAudioOnly();
      try { if (this.rgav && this.rgav.stop) this.rgav.stop(); } catch (e) {}
      this._syncDone = false;
      this.coverHold = false;
      this._coverResumed = false;
      this._coverPhase = 0;
      this._setPlayerState('error');

      const dur = this.vDuration || 0;
      let abs = (this._seekOffset || 0) + (Number(info && info.position) || 0);
      if (!(abs > 0.5)) abs = this._seekOffset || 0;
      let at = Math.floor(abs);
      if (dur > 0 && at > dur - 2) at = Math.max(0, Math.floor(dur - 2));
      console.warn('[Retry] abnormal why=' + why + ' at=' + at + 's pos=' + abs.toFixed(1) + '/' + dur +
        ' err=' + (this._lastRgavErr || ''));

      if ((this._autoRetry || 0) < 1) {
        this._autoRetry = 1;
        this.playerErr = '播放中断，正在重试…';
        this._retryTimer = this.$page.setTimeout(() => {
          this._retryTimer = null;
          if (gen !== this.playGen || this.isStopping) return;
          this._retryBusy = false;
          this._lastSeekAt = 0;   // 绕过 seekTo 的 400ms 节流
          this.seekTo(at);
        }, 400);
        return;
      }
      this._retryBusy = false;
      this.playerErr = '播放中断，即将返回详情';
      this._retryReturnTimer = this.$page.setTimeout(() => {
        this._retryReturnTimer = null;
        if (!this.isStopping) this.stop();
      }, 2500);
    },
    retryNow() {
      if (!this._playItem || this.isStopping) return;
      if (this._retryReturnTimer) {
        this.$page.clearTimeout(this._retryReturnTimer);
        this._retryReturnTimer = null;
      }
      this._autoRetry = 0;
      this._retryBusy = false;
      this._lastSeekAt = 0;
      this.seekTo(Math.floor(this._lastPos || 0));
    },
    startVideo() {
      const item = this.detailItem();
      if (!item) return;
      // 防抖：触摸屏偶尔会把一次点击识别成两次，重复起播会重启解码、拖慢出画。
      const now = Date.now();
      if (this._lastVideoStartAt && now - this._lastVideoStartAt < 600) {
        console.warn('[Rga] startVideo debounce');
        return;
      }
      this._lastVideoStartAt = now;
      const d = this.detailData();
      const dim = (d && d.dimension) || item.dimension || { width: 640, height: 360 };
      if (this.rgav && typeof this.rgav.start === 'function') {
        this.startNativeVideo(item, dim);
        return;
      }
      this.play(item, { src: { w: Number(dim.width) || 640, h: Number(dim.height) || 360 }, drawFrames: true });
    },
    predictDecode(w, h) {
      const sw = Math.max(1, Number(w) || 640);
      const sh = Math.max(1, Number(h) || 360);
      const even = (v) => Math.max(2, Math.round(v / 2) * 2);
      if (!OUT_ALIGN_DISPLAY) {
        const s0 = Math.min(640 / sw, 360 / sh, 1);
        return { w: even(sw * s0), h: even(sh * s0) };
      }
      // 播放层实际可见区就是 player-canvas-box 的 640×172。
      // 旧实现固定输出 640×360 再用 CSS 缩到 0.478，等于每帧多搬 4.4 倍像素
      // （解码→sws→环缓 memcpy→putImageData 四级全按 640×360 走）。
      const boxW = 640, boxH = 172;
      // 固定「适应」：等比装入显示框（16:9 源 → 306×172），不裁切源画面
      const s = Math.min(boxW / sw, boxH / sh, 1);
      return { w: even(sw * s), h: even(sh * s) };
    },
    startNativeVideo(item, dim) {
      if (this.isStopping) return;
      this.playGen = (this.playGen || 0) + 1;
      const gen = this.playGen;
      const dec = this.predictDecode(dim.width, dim.height);
      this.audioMode = false;
      this.currentTitle = item.title || '';
      this.currentBvid = item.bvid;
      this._playItem = item;
      // 右栏重置 + 预取三连状态（未登录时 relation 为 null，按钮不高亮）
      this.detailTab = 'info';
      this.moreOpen = false;
      this.partsList = [];
      this.loadParts();
      this.comments = [];
      this.commentPn = 1;
      this.commentSort = 'hot';
      this.relatedList = [];
      this.relation = null;
      this.likeState = 0;
      this.coinState = 0;
      this.favState = 0;
      if (this._lastPartBvid !== item.bvid) {
        this._lastPartBvid = item.bvid;
        this.currentPartPage = 0;
        this.currentPartTitle = '';
      }
      this.likeCount = Number((this.detailData() || {}).like) || 0;
      this.loadRelation();
      this.recordHistory(item);
      this.srcSize = { w: Number(dim.width) || 640, h: Number(dim.height) || 360 };
      this.playSize = dec;
      // 用详情页返回的时长先填进度条：native 的 info().duration 在切片流/收紧 probe 后可能为 0，
      // 旧逻辑只在 duration>0 时才更新，于是会**一直沿用上一部视频的时长**（表现为固定显示某个旧值）。
      const dmeta = this.detailData ? this.detailData() : null;
      let dsec = dmeta && Number(dmeta.duration) ? Number(dmeta.duration) : 0;
      if (!dsec && item && Number(item.duration)) dsec = Number(item.duration);
      // 记录权威时长：native 从分片流(empty_moov)解析出的 duration 经常是错的（实测约 5s），
      // 所以有权威值时不让 native 覆盖，否则进度条右侧总时长会永远停在那个错值上。
      this._durFromDetail = dsec > 0 ? dsec : 0;
      this.vDuration = this._durFromDetail;
      this.statusText = '准备播放...';
      this.isPlaying = true;
      this.isStopping = false;
      // 默认暂停：先解首帧当封面，等用户点播放再起音频、走时间轴。
      this.coverHold = true;
      this._coverPhase = 'wait-prime';
      this._coverAt = 0;
      this._coverResumed = false;
      this._autoRetry = 0;
      this._retryBusy = false;
      this._retryTimer = null;
      this._retryReturnTimer = null;
      this.streamPct = -1;
      this.streamSource = '';
      this.streamDone = false;
      this.buffering = false;
      this._bufLastAt = 0;
      this._bufLastPos = 0;
      this._setPlayerState('loading');
      this._startKeepScreen();
      this._frames = 0;
      this._drawMs = 0;
      this._perfAt = Date.now();
      this._lastCb = 0;
      this._maxGap = 0;
      this._audioRetry = 0;
      this._lastNativeRead = 0;
      this._emptyTicks = 0;
      this._lastPosCbTime = 0;
      this._posCbCount = 0;
      this._syncDone = false;
      this._lastPos = 0;
      this._audioPos = 0;
      this._audioPosAt = 0;
      // 厂商 onPosition 实测固定为「整数秒」。旧代码用视频位置做秒/毫秒自适应，
      // 默认暂停时首个回调的视频位置还是 0，会被误判成毫秒 → apos 恒为 0、漂移 -20s。
      this._audioUnit = 1;
      this._lastAdjustAt = 0;
      this._resumeAt = 0;
      this._latePrimeAt = 0;
      this._latePrimeDone = false;
      this._primeCheckAt = 0;
      this._driftEwma = 0;
      this._syncSampleCount = 0;
      this._nextDue = 0;
      this._audioClockReset();
      this._hardResyncStrikes = 0;
      this._lastAdvancePos = 0;
      this._lastAdvanceAt = 0;
      this._stallAudioPaused = false;
      this._audioPrewarm = false;
      this._audioParked = false;
      this._audioParkAt = 0;
      this._audioSyncingPaused = false;
      this._startedAt = Date.now();
      this._lastAudioNow = 0;
      this._lastAudioNowAt = 0;
      this._audioPosAt = 0;
      this._stallVideoPaused = false;
      this.isPaused = false;
      this.curPos = 0;
      this.progress = 0;
      this._seekOffset = 0;
      this._progAt = 0;
      this._driftLogged = false;
      console.warn('[Rga] play ' + item.bvid + ' dec=' + dec.w + 'x' + dec.h);
      // 尽早在起播阶段就释放上一路音频，给 ALSA 更长的回收时间。
      this._stopAudioOnly();
      try {
        http.request({
          url: 'http://127.0.0.1:18080/api/play?bvid=' + item.bvid + '&mode=video&title=' + encodeURIComponent(item.title || ''),
          method: 'GET',
          timeout: 1500
        }).catch(() => {});
      } catch (e) {}
      this.$page.setTimeout(() => {
        if (gen !== this.playGen) return;
        this._initNativeVideo(gen, item, dec);
      }, 300);
    },
    _initNativeVideo(gen, item, dec) {
      try {
        const canvas = this.$refs.vCanvas;
        if (!canvas) { console.warn('[Rga] no canvas'); return; }
        let ctx = null;
        if (typeof createCanvasContext === 'function') ctx = createCanvasContext(canvas);
        else if (typeof canvas.getContext === 'function') ctx = canvas.getContext('2d');
        if (!ctx) { console.warn('[Rga] no ctx'); return; }
        this.ctx = ctx;
        const sizeKey = dec.w + 'x' + dec.h;
        if (!this.imageData || this._imageSize !== sizeKey) {
          this.imageData = ctx.getImageData(0, 0, dec.w, dec.h);
          this._imageSize = sizeKey;
        }
        if (!this.imageData || !this.imageData.data || !this.imageData.data.buffer) {
          console.warn('[Rga] no imageData');
          return;
        }
        if (this.rgav && typeof this.rgav.setCropMode === 'function') {
          try { this.rgav.setCropMode(0); } catch (e) {}
        }
        if (this.rgav && typeof this.rgav.setRGAEnabled === 'function') {
          try {
            const avail = this.rgav.setRGAEnabled(USE_RGA ? 1 : 0);
            console.warn('[Rga] RGA available=' + avail + ' enabled=' + (USE_RGA ? 1 : 0));
          } catch (e) { console.warn('[Rga] setRGAEnabled failed: ' + e); }
        }
        this.rgav.setBuffer(this.imageData.data.buffer, dec.w, dec.h);
        const streamUrl = 'http://127.0.0.1:18080/api/stream?bvid=' + item.bvid + (this._seekOffset ? ('&ss=' + this._seekOffset) : '');
        this.rgav.start(streamUrl);
        console.warn('[Rga] video started: ' + streamUrl);
        // 默认暂停：这里只解首帧，不定时间轴、不起音频。音频在 resumeFromCover 里启动。
        this._coverAt = Date.now();
        this._startStreamPoll(gen, item.bvid);
        this._startVideoTick(gen);
      } catch (e) {
        console.warn('[Rga] init error: ' + e);
        this.showToast('原生播放失败，回退');
        this._stopNative();
        this.play(item, { src: this.srcSize, drawFrames: true });
      }
    },
    _nativeTick(gen, ctx) {
      try {
        const now = Date.now();
        // 封面相位：只做「等 primed → 读首帧 → 冻结」，不跑节拍/同步/进度。
        if (this._coverPhase) { this._coverTick(gen, ctx, now); return; }
        // 跳转锁兜底：10s 还没出帧说明这条路已经废了，放开锁避免后续快进全部被吞
        if (this._seekBusy && this._seekSince && now - this._seekSince > 10000) {
          this._seekBusy = false;
          console.warn('[Seek] busy timeout, unlock');
        }
        // 渲染节拍：截止时间制，目标 30fps（与 B 站 30fps 视频流一致）。
        // 旧写法「距上次出帧 >= 33ms」在 16ms 轮询下会产出 32/48ms 交替的采样周期，
        // 均值 40ms > 内容 33.3ms，每帧漂移 +6.7ms，约每 12 帧必撞 native 侧 80ms 丢帧线
        // （实测 24~25 draws/s、maxgap 55~73ms 即此）。改为维护 nextDue 累加，采样抖动不再累积。
        const FRAME_MS = 33.34;
        if (now < (this._nextDue || 0) - 2) return;
        this._infoAt = this._infoAt || 0;
        const t0 = now;
        const got = this.rgav.readFrame();
        if (got) {
          this._emptyTicks = 0;
          this._lastNativeRead = now;
          if (this._seekBusy) this._seekBusy = false;
          ctx.putImageData(this.imageData, 0, 0);
          this._drawMs += (Date.now() - t0);
          this._frames++;
          // 推进下一帧截止时间：正常 +33.3ms；若已落后超过一帧则重置为 now+33.3
          // （丢弃积压而不是突发补帧，避免画面"快进"一下）
          if (this._nextDue && this._nextDue > now - FRAME_MS) this._nextDue += FRAME_MS;
          else this._nextDue = now + FRAME_MS;
          const nowPerf = Date.now();
          if (this._lastCb) {
            const gap = nowPerf - this._lastCb;
            if (gap > (this._maxGap || 0)) this._maxGap = gap;
          }
          this._lastCb = nowPerf;
          if (nowPerf - this._perfAt >= 2000) {
            const sec = (nowPerf - this._perfAt) / 1000;
            const fps = Math.round(this._frames / sec);
            const avg = this._frames > 0 ? Math.round(this._drawMs / this._frames) : 0;
            console.warn('[Perf] native draws/s=' + fps + ' avg=' + avg + 'ms maxgap=' + (this._maxGap || 0)
              + ' pos=' + (this._lastPos || 0).toFixed(1) + ' apos=' + (this._audioPos || 0).toFixed(1)
              + ' cp=' + (this.curPos || 0).toFixed(1) + ' dur=' + (this.vDuration || 0).toFixed(1)
              + ' drg=' + (this._progressDragging ? 1 : 0)
              + ' out=' + this.playSize.w + 'x' + this.playSize.h);
            this._frames = 0;
            this._drawMs = 0;
            this._maxGap = 0;
            this._perfAt = nowPerf;
          }
        } else {
          // 未取到帧：不打断下一轮轮询，但连续 3 次空帧（约 24ms）后退避一帧，避免 CPU 空转抢占解码线程
          this._emptyTicks = (this._emptyTicks || 0) + 1;
          if (this._emptyTicks >= 3) {
            this._emptyTicks = 0;
            this._nextDue = now + FRAME_MS;
          }
        }
        // 跳转串行化：当前跳转已经出帧，若期间用户又点了快进，这里补跳一次
        if (!this._seekBusy && this._pendingSeekTo != null && !this._seekDeferTimer) {
          const t = this._pendingSeekTo;
          this._pendingSeekTo = null;
          this._seekDeferTimer = this.$page.setTimeout(() => {
            this._seekDeferTimer = null;
            this.seekTo(t);
          }, 150);
        }
        // 每帧只取 position 数值（不创建 JS 对象）；info() 降到 ~0.8s 一次，
        // 减少 QuickJS 堆分配与 GC 抖动（这是主线程偶发卡顿的来源之一）。
        try {
          const pos = this.rgav.position();
          if (pos > 0) this._lastPos = (this._seekOffset || 0) + pos;
          // 播放中位置停滞 >900ms = 真缓冲（与用户暂停分开），右上角显示缓冲药丸。
          const advanced = pos > (this._bufLastPos || 0) + 1e-6;
          if (advanced) this._bufLastPos = pos;
          if (this.playerState === 'playing' && !this.isPaused && this._syncDone) {
            if (advanced) {
              this._bufLastAt = now;
              if (this.buffering) this.buffering = false;
            } else if (this._bufLastAt && now - this._bufLastAt > 900) {
              if (!this.buffering) {
                this.buffering = true;
                this._startStreamPoll(gen, this.currentBvid);
              }
            }
          }
          // ---- 音频冻结自愈 ----
          // 实测出现 apos 长时间不动（音频链路静默死亡），此时控制器所有纠偏都无意义。
          // 用「回调心跳」判定，超过 2.5s 没有新回调就用当前视频位置重开一路音频（10s 冷却）。
          // 音频冻结只记录，不再自动重开：
          // 实测「自愈重开 + 紧接着的 seek」会在极短时间内换手两次 vendor player，
          // 触发项目文档记载的 UAF（旧 160x90 缓冲被 GC 后厂商线程仍写入）→ miniapp 崩溃。
          if (this._syncDone && this._audioCbAt && (now - this._audioCbAt) > 5000
              && (now - (this._audioFrozenLoggedAt || 0)) > 15000) {
            this._audioFrozenLoggedAt = now;
            console.warn('[Sync] audio position frozen ' + Math.round(now - this._audioCbAt) + 'ms (no auto-restart)');
          }

          // ---- 只保留「谁在推进」的观测，不再互相暂停 ----
          // 旧版这里视频卡 700ms 就 pause 音频、音频卡 900ms 就 pause 视频，
          // 但音频回调节奏本身就有 ~1s，这条规则会误伤并和纠偏互相激化（实测越纠越卡）。
          // 现在统一交给「音频跑前就点刹」的漂移控制（见下方 _parkAudio）。
          if (!this.isPaused && !this.isStopping && this._syncDone) {
            const aNow = this._audioClockNow();
            const vAdv = pos > (this._lastAdvancePos || 0) + 1e-6;
            if (aNow < (this._lastAudioNow || 0) - 0.5) { this._lastAudioNow = aNow; this._lastAudioNowAt = now; }
            if (aNow > (this._lastAudioNow || 0) + 0.05) { this._lastAudioNow = aNow; this._lastAudioNowAt = now; }
            if (vAdv) { this._lastAdvancePos = pos; this._lastAdvanceAt = now; }
          }
        } catch (e) {}
        this._updateProgress();
        // 视频首帧晚于音频起播（primed 超时兜底路径）：视频内容从 0 开始而音频已经播了一段，
        // 等视频真正就绪后，按“起播后已过去的时间”额外跳帧追上音频。
        if (this._latePrimeAt && !this._latePrimeDone && this._syncDone) {
          if (now - (this._primeCheckAt || 0) > 200) {
            this._primeCheckAt = now;
            let primedNow = false;
            try {
              const inf = this.rgav.info();
              primedNow = !!(inf && inf.primed);
            } catch (e) {}
            if (primedNow) {
              this._latePrimeDone = true;
              const D = (Date.now() - (this._resumeAt || this._latePrimeAt)) / 1000;
              if (D > 0.2) {
                try {
                  const safeD = Math.min(D, 0.5);
                  this.rgav.adjust(safeD);
                  console.warn('[Sync] late-prime adjust D=' + safeD.toFixed(2));
                } catch (e) {}
              }
            }
          }
        }
        // 动态闭环音画对齐 (Audio-Master-Clock with EWMA & Deadband)
        if (now - (this._infoAt || 0) >= 500) {
          this._infoAt = now;
          const info = this.rgav.info();
          if (info) {
            // 仅在「没有权威时长」时才采用 native 的 duration（0 视为未知）
            if (!this._durFromDetail && info.duration > 0 && Math.abs(info.duration - this.vDuration) > 0.5) {
              this.vDuration = info.duration;
            }
            if (info.finished) {
              this._handleFinished(gen, info);
              return;
            }

            // 当视频与音频均在正常播放中时计算实时时钟偏差
            if (this._syncDone && this._audioPos > 0 && this._audioPosAt > 0 && info.position > 1.0) {
              const audioElapsed = (now - this._audioPosAt) / 1000;
              // 追踪实际音频物理位置是否在推进，检测弱网断流卡顿
              if (this._lastTrackedAudioPos !== this._audioPos) {
                this._lastTrackedAudioPos = this._audioPos;
                this._lastTrackedAudioMovedAt = now;
              }
              const audioElapsedSinceMove = now - (this._lastTrackedAudioMovedAt || now);
              const audioStalled = audioElapsedSinceMove > 2000;

              // 仅当音频进度在正常更新周期内且音频未卡死断流时，才进行动态微调
              if (audioElapsed < 2.5 && !audioStalled) {
                // 用斜率回归时钟代替「整数位置 + 墙钟外推」：后者的等效速率只有 ~92.6%，
                // 会把口径误差当成真实失步，导致闭环持续误判视频领先。
                const audioNow = this._audioClockNow();
                // 关键：audioNow 是「绝对内容时间」（_audioPos 已加过 _seekOffset），
                // 而 info.position 是 native 本次流的相对位置（seek 后从 0 开始）。
                // 两者直接相减会把 seek 偏移量当成永久失步（实测 seek 10s 后
                // pos=32.9/apos=37.0 实际只差 4.1s，却报 14.66s），进而每 300ms
                // 触发一次 fast catch-up 疯狂跳帧。这里必须补回偏移。
                const videoNow = (this._seekOffset || 0) + info.position;
                const rawDrift = audioNow - videoNow; // >0 视频落后需跳帧；<0 视频超前需等待

                // 大偏差处理：只要 |drift| > 1s 就累计 strike，连续 3 次即做一次硬重同步。
                // 旧实现在 >2s 时「清空滤波什么都不做」，结果视频卡顿 2.9s 后音频跑前 5s，
                // 偏差永远回不来（日志里 apos−pos 稳定在 5.0s 就是这个原因）。
                // 硬重同步的前置门（关键）：
                //  1) 起播/seek 后 6s 内音频还在爬坡，此时的巨大偏差是假象，绝不能 seek；
                //  2) 音频位置 <2s 说明它根本没真正开走，此时 seek 只会回跳到开头形成死循环。
                // 硬重同步已关闭（v2.4.12）：实测它会与卡顿保护互相激化成「回跳开头」死循环。
                // 现在大偏差只记录 + 重置滤波器，不再 seek；同步交给双向卡顿保护兜。
                // 只有音频回调是新鲜的（<2s）才允许纠偏：
                // apos 陈旧或为 0 时算出的「几十秒偏差」会把视频疯狂跳帧（日志 -27~-31s 即此）。
                const audioFresh = this._audioCbAt && (now - this._audioCbAt) < 2000;
                if (this._audioSyncingPaused) {
                  // 音频已刹住：用最后一次回调位置（外推时钟会继续涨，不能用来判据）
                  const cbDrift = (this._audioCbPos || 0) - videoNow;
                  this._driftEwma = 0;
                  this._syncSampleCount = 0;
                  if (cbDrift <= 0.12) this._unparkAudio('caught-up ' + cbDrift.toFixed(2) + 's');
                } else if (audioFresh && rawDrift > 0.45) {
                  // 音频明显跑前：直接刹住音频等视频，不再「狂跳帧追音频」（那是卡顿主因）
                  console.warn('[Sync] audio ahead ' + rawDrift.toFixed(2) + 's -> park');
                  this._parkAudio('ahead');
                  this._driftEwma = 0;
                  this._syncSampleCount = 0;
                } else if (!audioFresh) {
                  this._driftEwma = 0;
                  this._syncSampleCount = 0;
                } else if (Math.abs(rawDrift) > 1.0) {
                  // 音频落后超过 1s（视频跑前）：无法快进音频，只能轻微刹车视频；
                  // 负数大偏差时保持不动作，等视频自己消耗（旧版狂 adjust 反而抖）。
                  this._driftEwma = 0;
                  this._syncSampleCount = 0;
                } else {
                  this._hardResyncStrikes = 0;
                  // EWMA 低通滤波平滑单核调度偶发抖动 (0.75 惯性 + 0.25 采样，有效滤除 60ms 锯齿波)
                  if (this._driftEwma === 0 || this._driftEwma === undefined) {
                    this._driftEwma = rawDrift;
                  } else {
                    this._driftEwma = this._driftEwma * 0.5 + rawDrift * 0.5;
                  }
                  this._syncSampleCount = (this._syncSampleCount || 0) + 1;

                  // 至少累积 3 次采样（约 1.5s）后再做决策，防止起播偶发瞬态误调
                  if (this._syncSampleCount >= 3) {
                    const elapsedSinceAdjust = now - (this._lastAdjustAt || 0);
                    // 冷却：小偏差 1000ms；大偏差 700ms（要追 1s 以上不能等）
                    const cooldownMs = Math.abs(this._driftEwma) > 0.5 ? 700 : 1000;
                    if (elapsedSinceAdjust >= cooldownMs) {
                      // 对称死区 ±45ms：时钟估计精度提升到 ~50ms 后，旧的非对称死区（+90/−180ms）
                      // 已经把两个方向都放成了死区，负向更是完全不动（见下一处注释）。
                      if (this._driftEwma > 0.045) {
                        // 视频滞后音频 > 90ms: 温和追赶，比例调节 min(max(ewma*0.5, 30ms), 50ms)
                        // 与 native 300ms 环形缓冲溢出丢帧串联互补：90ms~300ms 由控制器主动拉回，杜绝无干预空档
                        // 小偏差温和（≤50ms）；大偏差放大步长快速收敛（视频落后→跳帧，安全上限 400ms）
                        const mag = this._driftEwma;
                        const delta = Math.min(Math.max(mag * 0.5, 0.030), mag > 0.5 ? 0.400 : 0.050);
                        try {
                          this.rgav.adjust(delta);
                          console.warn('[Sync] dynamic adjust (catch-up): drift=' + rawDrift.toFixed(3) + 's ewma=' + this._driftEwma.toFixed(3) + 's adj=' + delta.toFixed(3) + 's');
                          this._lastAdjustAt = now;
                          this._driftEwma = 0;
                        } catch (e) {
                          console.warn('[Sync] adjust error: ' + e);
                        }
                      } else if (this._driftEwma < -0.045) {
                        // 视频超前音频 > 180ms（超出人类视听感知极限 +185ms 时微量刹车）
                        // 注意：旧值 -0.020 在 native 侧是空操作（判定是 d < -0.02，等于没生效），
                        // 所以「刹车」从来没真正执行过。改为 -0.030（一次 30ms 的轻微等待，不会定格）。
                        // 负向是「等一等」（native 侧 t0 += |d|，会造成最多一次 |d| 的停顿），
                        // 所以上限压到 120ms，避免大偏差时出现肉眼可见定格。
                        const magN = -this._driftEwma;
                        const delta = -Math.min(Math.max(magN * 0.5, 0.030), magN > 0.5 ? 0.120 : 0.050);
                        try {
                          this.rgav.adjust(delta);
                          console.warn('[Sync] dynamic adjust (lead-brake): drift=' + rawDrift.toFixed(3) + 's ewma=' + this._driftEwma.toFixed(3) + 's adj=' + delta.toFixed(3) + 's');
                          this._lastAdjustAt = now;
                          this._driftEwma = 0;
                        } catch (e) {
                          console.warn('[Sync] adjust error: ' + e);
                        }
                      }
                      // 注：-0.180s ~ +0.090s 属于感知与采样死区，完全不调用 adjust()，保持画面极致流畅！
                    }
                  }
                }
              }
            }
          }
        }
      } catch (e) {
        console.warn('[Rga] tick error: ' + e);
      }
    },
    _waitPrimedThenAudio(gen, item) {
      const startedAt = Date.now();
      const tryStart = () => {
        if (gen !== this.playGen || this.isStopping) return;
        let primed = false;
        try {
          const i = this.rgav.info();
          primed = !!(i && i.primed);
        } catch (e) {}
        // 视频首帧就绪后再起音频，让两端内容 0 点尽量对齐；超时 4s 也起音频，避免完全没声音。
        if (primed || Date.now() - startedAt > 4000) {
          console.warn('[Sync] video primed=' + primed + ' after ' + (Date.now() - startedAt) + 'ms, start audio');
          if (!primed) {
            // 视频首帧比音频晚很多：先起音频，等视频真正就绪后按“已过去的时间”补跳帧（见 _nativeTick）。
            this._latePrimeAt = Date.now();
            this._latePrimeDone = false;
          }
          this._startNativeAudio(gen, item);
          if (this._syncTimer) this.$page.clearTimeout(this._syncTimer);
          this._syncTimer = this.$page.setTimeout(() => {
            // 兜底放宽到 7000ms：实测厂商播放器从 start() 到真正出声约 4s，
            // 旧的 3000ms 必然先到，于是每次都以 offset=0 放行视频（实测 100% 命中该路径）。
            this._syncResume(gen, 'fallback-timeout', this._audioPos || 0);
          }, 7000);
          return;
        }
        this.$page.setTimeout(tryStart, 100);
      };
      this.$page.setTimeout(tryStart, 80);
    },
    _startNativeAudio(gen, item) {
      // 重入保护：1.5s 内重复调用会叠出两个 vendor player（项目文档记载的 UAF 崩溃源）
      const nowStart = Date.now();
      if (this._audioStartingAt && nowStart - this._audioStartingAt < 1500) {
        console.warn('[Rga] audio start throttled');
        return;
      }
      this._audioStartingAt = nowStart;
      // 音频重开 = 新的内容时间轴：必须重置回归时钟与回调心跳，
      // 否则会拿上一条时间轴的拟合值算出荒唐偏差（日志里 -30s 的 large drift 即此）。
      this._audioClockReset();
      this._audioCbPos = 0;
      this._audioCbAt = 0;
      this._audioPos = 0;
      this._audioPosAt = 0;
      // 先彻底释放上一路音频：softvideo 的 stop 会 closeAudioDevice，需要时间让 ALSA 回收。
      // 优先通过 /api/alsa/ready 设备就绪探针消除盲等，既能毫秒级起播，又杜绝两路抢设备爆音。
      this._stopAudioOnly();
      const elapsed = this._audioStoppedAt ? (Date.now() - this._audioStoppedAt) : 1e9;
      const maxWait = Math.max(0, 500 - elapsed);

      let started = false;
      const startAudioPlayer = () => {
        if (started) return;
        started = true;
        if (gen !== this.playGen || !this.isPlaying || this.isStopping) return;
        try {
          const ac = this.$refs.aCanvas;
          if (!ac) { console.warn('[Rga] no audio canvas'); return; }
          let actx = null;
          if (typeof createCanvasContext === 'function') actx = createCanvasContext(ac);
          else if (typeof ac.getContext === 'function') actx = ac.getContext('2d');
          if (!actx) { console.warn('[Rga] no audio ctx'); return; }
          const PlayerClass = (softvplayer && softvplayer.SoftVPlayer) || (softvplayer && softvplayer.default && softvplayer.default.SoftVPlayer) || softvplayer;
          if (typeof PlayerClass !== 'function') return;
          const ap = new PlayerClass();
          this.audioPlayer = ap;
          const adata = actx.getImageData(0, 0, 160, 90);
          // ★ 关键修复：native 侧只保存裸指针，JS 必须持有该 ArrayBuffer 的强引用，
          // 否则 QuickJS GC 回收后 vendor 解码线程仍往这块内存写像素 → 踩坏 mimalloc 堆，
          // 表现为之后任意 malloc（如图片解码/getImageData）随机崩溃。已用 core dump 证实。
          this._audioImageData = adata;
          this._audioBuffer = (adata && adata.data) ? adata.data.buffer : null;
          ap.setVideoInfo(160, 90);
          if (adata && adata.data) ap.setImageDataBuffer(adata.data.buffer);
          this._audioBind = [];
          const bind = (name, cb) => {
            try {
              const sig = ap[name];
              if (sig && typeof sig.on === 'function') {
                const tok = sig.on(cb);
                this._audioBind.push({ sig: sig, token: tok });
              }
            } catch (e) {}
          };
          bind('onError', (c) => {
            console.warn('[Rga] audio error ' + c);
            // remux 刚启动时首字节可能还没到，软解会 avformat_open_input 失败：自动重试两次。
            if ((this._audioRetry || 0) < 2) {
              this._audioRetry = (this._audioRetry || 0) + 1;
              this.$page.setTimeout(() => {
                if (gen === this.playGen && this.isPlaying) this._startNativeAudio(gen, item);
              }, 1200);
            }
          });
          bind('onPosition', (p) => {
            // vendor 播放器回调音频播放位置：用它做动态音画对齐。
            const nowPerf = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
            let a = Number(p) || 0;
            const vpos = this._lastPos || 0;

            // P1 统计插桩：记录回调时间间隔、原始值、是否严格递增与整数性
            if (this._lastPosCbTime) {
              const dt = nowPerf - this._lastPosCbTime;
              this._posCbCount = (this._posCbCount || 0) + 1;
              if (this._posCbCount % 3 === 0) {
                console.warn('[PosStats] cb#' + this._posCbCount + ' dt=' + dt.toFixed(1) + 'ms raw=' + p + ' val=' + a.toFixed(3) + ' isInt=' + (a === Math.floor(a)));
              }
            }
            this._lastPosCbTime = nowPerf;

            if (!this._audioUnit && a > 0) {
              // 自动识别单位：秒 or 毫秒（取与视频位置更接近的换算）。
              this._audioUnit = (Math.abs(a - vpos) <= Math.abs(a / 1000 - vpos)) ? 1 : 1000;
            }
            if (this._audioUnit === 1000) a = a / 1000;
            this._audioPos = (this._seekOffset || 0) + a;
            this._audioPosAt = Date.now();
            // 投喂斜率回归样本（修正 1.08s/整数秒口径造成的 -7.4% 低估）
            this._audioClockPush(this._audioPos, nowPerf);
            // 回调心跳：外推时钟会让「音频真的停了」看起来仍在走，
            // 所以卡顿/冻结判定必须用原始回调值 + 回调时间（日志里 apos 冻在 188.0 就是这种情形）。
            this._audioCbPos = this._audioPos;
            this._audioCbAt = Date.now();

            // 封面预热：首个位置回调说明声音已经真正出来，立刻把音频停住，
            // 等用户点播放时再与视频一起从这一位置开始（避免先响几秒、视频才开始追）。
            if (this.coverHold && this._audioPrewarm && a > 0.05) {
              if (!this._audioParked) {
                this._audioParked = true;
                this._audioParkAt = a;
                this._audioCbAt = Date.now();   // 暂停期间不再刷新回调心跳，避免误报「音频冻结」
                try { if (typeof ap.pause === 'function') ap.pause(); } catch (e) {}
                console.warn('[Cover] audio parked at ' + a.toFixed(2) + 's');
              } else {
                // pause 没拦住（仍在回调）：持续跟随最新位置，保证放行时仍然对齐
                this._audioParkAt = a;
              }
              this._audioPos = (this._seekOffset || 0) + a;
              this._audioPosAt = Date.now();
              return;
            }
            // ★ 精准对齐起播：以首个实际音频播放位置直接放行视频，消除起播 1~2s 盲猜误差
            // 要求音频已实际走起来（≥0.3s）才放行视频，避免 offset≈0 就放行、随后音频停滞造成大偏差
            if (!this._syncDone && a >= 0.3) {
              if (this._infoResumeTimer) { this.$page.clearTimeout(this._infoResumeTimer); this._infoResumeTimer = null; }
              this._syncResume(gen, 'audio-pos', a);
            }
          });
          bind('onInfo', () => {
            // 封面预热阶段绝不能放行视频（否则用户还没点播放，画面就开始跑了）
            if (this.coverHold || this._audioPrewarm) return;
            // 兜底保护：若 2800ms 内未收到 onPosition，通过 onInfo 兜底放行避免挂起
            if (this._infoResumeTimer) this.$page.clearTimeout(this._infoResumeTimer);
            this._infoResumeTimer = this.$page.setTimeout(() => {
              if (!this._syncDone && !this.coverHold) {
                this._syncResume(gen, 'audio-info-fallback', 0.5);
              }
            }, 2800);
          });
          const audioUrl = 'http://127.0.0.1:18080/api/audio?bvid=' + item.bvid + '&variant=remux' + (this._seekOffset ? ('&ss=' + this._seekOffset) : '');
          ap.start(audioUrl);
          console.warn('[Rga] audio started: ' + audioUrl + ', pause=' + (typeof ap.pause));
        } catch (e) {
          console.warn('[Rga] audio init error: ' + e);
        }
      };

      // 兜底定时器：若探针超时或网络异常，至多等待 maxWait 后强制启动
      const fallbackTimer = this.$page.setTimeout(() => {
        startAudioPlayer();
      }, maxWait);

      // 探测底层 ALSA 设备真正释放情况，消除盲等
      http.request({
        url: 'http://127.0.0.1:18080/api/alsa/ready?timeout=400',
        method: 'GET',
        timeout: 600,
      }).then((res) => {
        const body = safeJson(res.body, {});
        if (body && body.ready) {
          console.warn('[Audio] ALSA device ready in ' + (body.waited_ms || 0) + 'ms, launch immediately');
          this.$page.clearTimeout(fallbackTimer);
          startAudioPlayer();
        }
      }).catch(() => {
        // 出错走 fallbackTimer
      });
    },
    // ---- 音频主时钟估计器（斜率回归） ----
    // 厂商 onPosition 的实测口径：每 ~1.08s 回调一次、值为「整数秒」(isInt=true)。
    // 若直接做「位置 + 墙钟外推」，等效速率只有 1/1.08 ≈ 92.6%，闭环会持续误判
    // 「视频领先 70ms/s」，而负向修正被限死在 20ms/3s，drift 必然单调恶化到秒级。
    // 这里用最近 N 个 (时间, 位置) 样本做最小二乘，恢复真实速率 m 与相位 b，
    // 并强制估计值单调，避免抖动回退。
    _audioClockReset() {
      this._acSamples = [];
      this._acSlope = 0;
      this._acIntercept = 0;
      this._acLast = 0;
    },
    _audioClockPush(pos, tms) {
      const arr = this._acSamples || (this._acSamples = []);
      arr.push({ t: tms, p: pos });
      if (arr.length > 10) arr.shift();
      const n = arr.length;
      if (n < 4) return;
      let st = 0, sp = 0, stt = 0, stp = 0;
      for (let i = 0; i < n; i++) {
        const s = arr[i];
        st += s.t; sp += s.p; stt += s.t * s.t; stp += s.t * s.p;
      }
      const den = n * stt - st * st;
      if (den <= 0) return;
      const m = (n * stp - st * sp) / den; // 内容秒 / 毫秒
      // 只接受 0.85x~1.15x 实时；异常样本（卡顿/回退）保持旧斜率
      if (m > 0.00085 && m < 0.00115) {
        this._acSlope = m;
        this._acIntercept = (sp - m * st) / n;
      }
    },
    _audioClockNow() {
      const tms = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      if (this._acSlope > 0 && (this._acSamples || []).length >= 4) {
        const v = this._acSlope * tms + this._acIntercept;
        if (v > (this._acLast || 0)) this._acLast = v;
        return this._acLast || v;
      }
      const base = this._audioPos || 0;
      const baseAt = this._audioPosAt || 0;
      // 时间基未初始化/异常时直接返回已知位置：否则会算出 epoch 级（1.79e9）的假时钟，
      // 把 _lastAudioNow 抬到天文数字，随后被判成「音频停走」→ 误暂停视频。
      if (!baseAt || baseAt <= 0) return base;
      const elapsed = (Date.now() - baseAt) / 1000;
      if (!(elapsed >= 0) || elapsed > 60) return base;
      return base + elapsed;
    },
    // 音频「点刹」：偏差大时把音频原地停住，让视频按 1x 追上来。
    // 比原来的「狂跳帧追音频」对观感友好得多（弱网下后者会卡成幻灯片）。
    _parkAudio(why) {
      if (this._audioSyncingPaused) return;
      this._audioSyncingPaused = true;
      this._audioParkCbAt = Date.now();
      try { if (this.audioPlayer && typeof this.audioPlayer.pause === 'function') this.audioPlayer.pause(); } catch (e) {}
      console.warn('[Sync] park audio (' + why + ')');
    },
    _unparkAudio(why) {
      if (!this._audioSyncingPaused) return;
      this._audioSyncingPaused = false;
      try { if (this.audioPlayer && typeof this.audioPlayer.resume === 'function') this.audioPlayer.resume(); } catch (e) {}
      this._lastAudioNow = 0;
      this._lastAudioNowAt = 0;
      console.warn('[Sync] unpark audio (' + why + ')');
    },
    _syncResume(gen, why, offset) {
      if (gen !== this.playGen || this._syncDone || this.isStopping) return;
      // 封面暂停期间不允许放行视频（预热音频的兜底定时器可能在这时到点）
      if (this.coverHold && !this._coverResumed) return;
      this._syncDone = true;
      try {
        if (this._syncTimer) { this.$page.clearTimeout(this._syncTimer); this._syncTimer = null; }
        if (this._infoResumeTimer) { this.$page.clearTimeout(this._infoResumeTimer); this._infoResumeTimer = null; }
        if (this._coverResumed) {
          // 封面态：native 已经 release 过 t0，只是被 pause 冻结；unpause 会自动补回冻结时长。
          try { if (this.rgav && this.rgav.unpause) this.rgav.unpause(); } catch (e) {}
          const coff = Math.min(Number(offset) || 0, 1.0);
          if (coff > 0.05) { try { this.rgav.adjust(coff); } catch (e) {} }
          this._coverResumed = false;
          this._resumeAt = Date.now();
          this._lastAdvanceAt = Date.now();
          this._bufLastAt = Date.now();
          this._bufLastPos = 0;
          this._startVideoTick(gen);
          console.warn('[Sync] resume from cover (' + why + ') off=' + coff.toFixed(2));
          return;
        }
        const off = Number(offset) || 0;
        this._resumeAt = Date.now();
        if (this.rgav && typeof this.rgav.resume === 'function') this.rgav.resume(off);
        this._setPlayerState('playing');
        this._lastAdvanceAt = Date.now();
        this._bufLastAt = Date.now();
        this._bufLastPos = 0;
        console.warn('[Sync] resume video (' + why + ') offset=' + off.toFixed(2));
      } catch (e) {
        console.warn('[Sync] resume failed: ' + e);
      }
    },
    _stopAudioOnly() {
      let stopped = false;
      try {
        if (this._audioBind) {
          for (let i = 0; i < this._audioBind.length; i++) {
            const b = this._audioBind[i];
            if (b && b.sig && typeof b.sig.off === 'function' && b.token !== undefined) b.sig.off(b.token);
          }
          this._audioBind = [];
        }
      } catch (e) {}
      try {
        if (this.audioPlayer) {
          this.audioPlayer.stop();
          this.audioPlayer = null;
          stopped = true;
        }
      } catch (e) {}
      if (stopped) {
        this._audioStoppedAt = Date.now();
        // 注意：这里不立即释放 this._audioImageData / this._audioBuffer。
        // 它们的强引用会在下一次 _startNativeAudio 覆盖时自然释放（那时旧播放器已 stop 并 join），
        // 避免极端时序下 vendor 内部线程仍在收尾而缓冲区已被 GC 回收。
      }
    },
    _stopNative() {
      this._stopKeepScreen();
      this._stopVideoTick();
      this._stopStreamPoll();
      try {
        if (this._syncTimer) {
          this.$page.clearTimeout(this._syncTimer);
          this._syncTimer = null;
        }
      } catch (e) {}
      try {
        if (this._infoResumeTimer) {
          this.$page.clearTimeout(this._infoResumeTimer);
          this._infoResumeTimer = null;
        }
      } catch (e) {}
      if (this._retryTimer) {
        this.$page.clearTimeout(this._retryTimer);
        this._retryTimer = null;
      }
      if (this._retryReturnTimer) {
        this.$page.clearTimeout(this._retryReturnTimer);
        this._retryReturnTimer = null;
      }
      this._retryBusy = false;
      this._seekBusy = false;
      this._pendingSeekTo = null;
      if (this._seekDeferTimer) { this.$page.clearTimeout(this._seekDeferTimer); this._seekDeferTimer = null; }
      this._coverPhase = 0;
      this.coverHold = false;
      this._coverResumed = false;
      this.buffering = false;
      this.streamPct = -1;
      this.streamSource = '';
      this.streamDone = false;
      this._syncDone = false;
      this._driftEwma = 0;
      this._syncSampleCount = 0;
      this._audioPrewarm = false;
      this._audioParked = false;
      this._audioParkAt = 0;
      this._audioSyncingPaused = false;
      this._audioPos = 0;
      this._audioPosAt = 0;
      this._lastTrackedAudioPos = null;
      this._lastTrackedAudioMovedAt = 0;
      this._stopAudioOnly();
      try {
        if (this.rgav) this.rgav.stop();
      } catch (e) {}
    },
    startAudio() {
      const item = this.detailItem();
      if (!item) return;
      // 真机实测：原生软解无法打开纯音频 m4s（streamDecoder init failed），
      // 因此音频模式直接用 daemon 的 ffmpeg 重封装流（带 160x90@1fps 黑帧视频轨）。
      console.warn('[Audio] start remux for ' + item.bvid);
      this.play(item, {
        audioMode: true,
        src: { w: 160, h: 90 },
        out: { w: 160, h: 90 },
        drawFrames: false,
        streamUrl: 'http://127.0.0.1:18080/api/audio?bvid=' + item.bvid + '&variant=remux'
      });
    },
    async refreshQr() {
      this.loginStatusText = '正在生成二维码...';
      this.loginQrPath = '';
      try {
        const res = await http.request({
          url: 'http://127.0.0.1:18080/api/login/qr',
          method: 'GET',
          timeout: 6000
        });
        const data = safeJson(res.body, {});
        // 后端返回 qr_local（历史也发过 qr_path），两个都接受，避免字段名再次对不上导致永远「生成失败」
        const qp = (data && (data.qr_local || data.qr_path)) || '';
        if (data && data.qrcode_key && qp) {
          this.loginQrKey = data.qrcode_key;
          this.loginQrPath = qp;
          this.loginStatusText = '请用B站手机客户端扫码';
          this.startQrPoll();
        } else {
          this.loginStatusText = '生成二维码失败，请刷新';
        }
      } catch (e) {
        this.loginStatusText = '网络异常，请重试';
      }
    },
    startQrPoll() {
      if (this.pollTimerToken) {
        this.$page.clearInterval(this.pollTimerToken);
      }
      this.pollTimerToken = this.$page.setInterval(async () => {
        if (!this.loginQrKey || this.isLoggedIn || this.currentTab !== 'login') {
          if (this.pollTimerToken) this.$page.clearInterval(this.pollTimerToken);
          return;
        }
        try {
          const res = await http.request({
            url: 'http://127.0.0.1:18080/api/login/poll?qrcode_key=' + this.loginQrKey,
            method: 'GET',
            timeout: 5000
          });
          const st = safeJson(res.body, {});
          if (st && (st.logged_in || st.status === 'success')) {
            this.loginStatusText = '登录成功！';
            this.isLoggedIn = true;
            if (this.pollTimerToken) { this.$page.clearInterval(this.pollTimerToken); this.pollTimerToken = null; }
            this.loginQrKey = '';
            this.loginQrPath = '';
            this.fetchUserInfo();
          } else if (st && st.status === 'scanned') {
            // 已扫码待确认：这是「扫完没反应」最需要反馈的状态
            this.loginStatusText = '已扫码，请在手机上确认';
          } else if (st && st.status === 'expired') {
            this.loginStatusText = '二维码已过期，点此刷新';
            if (this.pollTimerToken) { this.$page.clearInterval(this.pollTimerToken); this.pollTimerToken = null; }
            this.loginQrKey = '';
          } else if (st && (st.message || st.msg)) {
            this.loginStatusText = st.message || st.msg;
          }
        } catch (e) {}
      }, 2000);
    },
    async logout() {
      try {
        await http.request({ url: 'http://127.0.0.1:18080/api/login/logout', method: 'GET', timeout: 2000 });
      } catch (e) {}
      this.isLoggedIn = false;
      this.user = { uname: '', mid: 0, face: '' };
      this.loginStatusText = '已退出登录';
      this.refreshQr();
    },
    async play(item, opts) {
      opts = opts || {};
      if (!item || !item.bvid) return;
      if (this.isStopping) {
        console.warn("[SoftVPlayer] play ignored: stop in progress");
        return;
      }
      this.playGen = (this.playGen || 0) + 1;
      const gen = this.playGen;
      const prevPlayer = this.vPlayer;
      this.isStopping = false;
      this.audioMode = !!opts.audioMode;
      this.currentTitle = item.title || '';
      this.currentBvid = item.bvid;
      this.vDuration = 0;
      this._playItem = item;
      this.recordHistory(item);
      this._playOpts = opts;
      this._signalSeen = false;
      this._audioFailed = false;
      this._sizeRetried = !!opts.sizeRetried;
      this._lastDraw = 0;
      this._frames = 0;
      this._drawMs = 0;
      this._perfAt = Date.now();
      this._bindTokens = [];

      const src = opts.src || this.srcSize || { w: 640, h: 360 };
      this.srcSize = src;
      // 实测：setVideoInfo 只用于缓冲区校验，软解始终按解码分辨率写满整帧（不会缩放）。
      // 因此视频首帧按 360P 上限 640x360 分配；若 onInfo 报出别的尺寸，再按实际尺寸重开一次。
      const out = opts.out || (this.audioMode ? { w: 160, h: 90 } : { w: 640, h: 360 });
      this.playSize = out;
      this._probeLogged = false;
      console.warn("[SoftVPlayer] play#" + gen + " " + item.bvid + " mode=" + (this.audioMode ? 'audio' : 'video') + " out=" + out.w + "x" + out.h + " src=" + src.w + "x" + src.h);

      this.statusText = '准备播放: ' + (item.title ? item.title.slice(0, 10) : '') + '...';
      this.isPlaying = true;
      this._startKeepScreen();
      if (prevPlayer) {
        try { prevPlayer.stop(); } catch(e) { console.warn("[SoftVPlayer] prev player stop error:", e); }
      }
      this.vPlayer = null;

      try {
        http.request({
          url: 'http://127.0.0.1:18080/api/play?bvid=' + item.bvid + '&mode=' + (this.audioMode ? 'audio' : 'video') + '&title=' + encodeURIComponent(item.title || ''),
          method: 'GET',
          timeout: 1500
        }).catch(() => {});
      } catch (err) {}

      const streamUrl = opts.streamUrl || ('http://127.0.0.1:18080/api/stream?bvid=' + item.bvid);
      this.$page.setTimeout(() => {
        if (gen !== this.playGen || this.isStopping) {
          console.warn("[SoftVPlayer] stale play timer #" + gen + ", abort");
          return;
        }
        this._initPlayer(gen, streamUrl, out, !!opts.drawFrames, item);
      }, 200);
    },

    _initPlayer(gen, streamUrl, out, drawFrames, item) {
      try {
        const canvas = this.$refs.vCanvas;
        console.warn("[SoftVPlayer] canvas ref:", !!canvas);
        if (!canvas) return;
        let ctx = null;
        if (typeof createCanvasContext === 'function') {
          ctx = createCanvasContext(canvas);
        } else if (typeof globalThis !== 'undefined' && typeof globalThis.createCanvasContext === 'function') {
          ctx = globalThis.createCanvasContext(canvas);
        } else if (typeof this.createCanvasContext === 'function') {
          ctx = this.createCanvasContext(canvas);
        } else if (typeof $falcon !== 'undefined' && typeof $falcon.createCanvasContext === 'function') {
          ctx = $falcon.createCanvasContext(canvas);
        } else if (typeof canvas.getContext === 'function') {
          ctx = canvas.getContext('2d');
        }
        if (!ctx) {
          console.warn("[SoftVPlayer] no canvas context");
          return;
        }
        this.ctx = ctx;
        const PlayerClass = (softvplayer && softvplayer.SoftVPlayer) || (softvplayer && softvplayer.default && softvplayer.default.SoftVPlayer) || softvplayer;
        if (typeof PlayerClass !== 'function') {
          console.warn("[SoftVPlayer] player class missing");
          return;
        }
        const player = new PlayerClass();
        this.vPlayer = player;
        this.imageData = null;

        const bindSignal = (name, cb) => {
          try {
            const sig = player[name];
            if (!sig || typeof sig.on !== 'function') {
              console.warn("[SoftVPlayer] signal missing:", name);
              return;
            }
            const tok = sig.on(cb);
            this._bindTokens.push({ sig: sig, token: tok });
          } catch(e) {
            console.warn("[SoftVPlayer] bind " + name + " error:", e);
          }
        };

        // 关键：先声明输出尺寸，让 native 的 sws 目标与 JS 缓冲区一致。
        // 640x360=921600B -> 320x180=230400B，单帧内存/拷贝量降到 1/4。
        try {
          if (typeof player.setVideoInfo === 'function') {
            player.setVideoInfo(out.w, out.h);
            console.warn("[SoftVPlayer] setVideoInfo(" + out.w + "," + out.h + ")");
          }
        } catch (e) {
          console.warn("[SoftVPlayer] setVideoInfo error:", e);
        }

        try {
          if (typeof ctx.getImageData === 'function') {
            this.imageData = ctx.getImageData(0, 0, out.w, out.h);
            if (this.imageData && this.imageData.data && this.imageData.data.buffer) {
              player.setImageDataBuffer(this.imageData.data.buffer);
              console.warn("[SoftVPlayer] buffer " + out.w + "x" + out.h + " bytes=" + this.imageData.data.buffer.byteLength);
            }
          }
        } catch(e) {
          console.warn("[SoftVPlayer] buffer init error:", e);
        }

        // onInfo 实际发射顺序为 (width, height, duration)，duration 单位为秒。
        bindSignal('onInfo', (width, height, duration) => {
          if (gen !== this.playGen) return;
          this._signalSeen = true;
          const iw = Number(width) || 0;
          const ih = Number(height) || 0;
          if (typeof duration === 'number' && duration > 0) this.vDuration = duration;
          console.warn("[SoftVPlayer] onInfo " + iw + "x" + ih + " dur=" + duration);
          if (this.audioMode) return;
          if (iw <= 0 || ih <= 0) return;
          this.decodedSize = { w: iw, h: ih };
          if (Math.abs(iw - out.w) > 2 || Math.abs(ih - out.h) > 2) {
            // 非 16:9（如 4:3 480x360、2:1 640x320）会把解码尺寸报成实际值，按它重开一次。
            console.warn("[SoftVPlayer] decoded " + iw + "x" + ih + " != buffer " + out.w + "x" + out.h);
            this._retryWithSize(iw, ih);
          }
        });

        bindSignal('onDrawFrame', () => {
          if (gen !== this.playGen || this.isStopping) return;
          this._signalSeen = true;
          const now = Date.now();
          this._cbCount = (this._cbCount || 0) + 1;
          if (this._lastCb) {
            const gap = now - this._lastCb;
            if (gap > (this._maxGap || 0)) this._maxGap = gap;
          }
          this._lastCb = now;
          if (!this.imageData || !ctx || typeof ctx.putImageData !== 'function') return;
          if (now - this._lastDraw < 25) return;
          this._lastDraw = now;
          try {
            const t0 = Date.now();
            ctx.putImageData(this.imageData, 0, 0);
            this._drawMs += (Date.now() - t0);
            this._frames++;
          } catch (e) {
            console.warn("[SoftVPlayer] putImageData error:", e);
          }
          if (now - this._perfAt >= 2000) {
            const sec = (now - this._perfAt) / 1000;
            const fps = Math.round(this._frames / sec);
            const avg = this._frames > 0 ? Math.round(this._drawMs / this._frames) : 0;
            const cbs = Math.round((this._cbCount || 0) / sec);
            console.warn("[Perf] cb/s=" + cbs + " draws/s=" + fps + " avg=" + avg + "ms maxgap=" + (this._maxGap || 0) + "ms out=" + this.playSize.w + "x" + this.playSize.h);
            this._frames = 0;
            this._drawMs = 0;
            this._cbCount = 0;
            this._maxGap = 0;
            this._perfAt = now;
          }
        });

        bindSignal('onComplete', () => {
          if (gen !== this.playGen) return;
          console.warn("[SoftVPlayer] Video complete");
          // 不能在原生回调里同步 stop()：会与解码线程互相等待。
          this.$page.setTimeout(() => {
            if (gen === this.playGen && !this.isStopping) this.stop();
          }, 0);
        });

        bindSignal('onError', (code) => {
          if (gen !== this.playGen) return;
          console.warn("[SoftVPlayer] Error:", code);
          this._audioFailed = true;
          const isAudio = this.audioMode;
          this.$page.setTimeout(() => {
            if (gen !== this.playGen) return;
            if (isAudio) {
              this.showToast('音频播放失败: ' + code);
            } else {
              this.statusText = '播放出错: ' + code;
            }
            if (!this.isStopping) this.stop();
          }, 300);
        });

        console.warn("[SoftVPlayer] start: " + streamUrl);
        if (typeof player.start === 'function') {
          player.start(streamUrl);
        } else if (typeof player.play === 'function') {
          player.play(streamUrl);
        }
      } catch (e) {
        console.warn("[SoftVPlayer] Exception:", e.message, e.stack);
      }
    },

    _retryWithSize(w, h) {
      if (this._sizeRetried || !this._playItem) return;
      this._sizeRetried = true;
      const item = this._playItem;
      const opts = this._playOpts || {};
      console.warn("[SoftVPlayer] retry with size " + w + "x" + h);
      // 从 onInfo 回调里同步 stop() 会与解码线程互锁，先让回调返回再重启。
      this.$page.setTimeout(() => {
        this.stop();
        this.$page.setTimeout(() => {
          const next = Object.assign({}, opts, { src: { w: w, h: h }, out: { w: w, h: h }, sizeRetried: true });
          this.play(item, next);
        }, 400);
      }, 0);
    },

    async stop() {
      if (this.isStopping) return;
      this.isStopping = true;
      const gen = ++this.playGen;
      // 先让 daemon 取消音频/视频流：解码线程才能尽快退出，否则 stop() 会等网络读超时，声音拖尾约 1s。
      try {
        http.request({
          url: 'http://127.0.0.1:18080/api/stop',
          method: 'GET',
          timeout: 500
        }).catch(() => {});
      } catch (e) {}
      this._stopNative();
      // 更新观看历史：记录本次播放停止时的进度与时长。
      try {
        if (this._playItem) this.recordHistory(this._playItem, this._lastPos || this.curPos || 0, this.vDuration || 0);
      } catch (e) {}
      this.statusText = '正在退出播放...';
      const player = this.vPlayer;
      if (player) {
        // 解绑：优先 off(token)/clear()，最后无论如何都要执行 stop()。
        const tokens = this._bindTokens || [];
        for (let i = 0; i < tokens.length; i++) {
          try {
            const b = tokens[i];
            if (!b || !b.sig) continue;
            if (typeof b.sig.off === 'function' && b.token !== undefined) {
              b.sig.off(b.token);
            } else if (typeof b.sig.clear === 'function') {
              b.sig.clear();
            }
          } catch(e) {
            console.warn("[SoftVPlayer] unbind error:", e);
          }
        }
        this._bindTokens = [];
        try {
          player.stop();
        } catch(e) {
          console.warn("[SoftVPlayer] vPlayer.stop error:", e);
        }
      }
      this.$page.setTimeout(() => {
        if (gen !== (this.playGen || 0)) {
          console.warn("[SoftVPlayer] teardown skipped: newer play started (#" + gen + " -> #" + this.playGen + ")");
          return;
        }
        this.vPlayer = null;
        this.imageData = null;
        this._imageSize = '';
        this.isPlaying = false;
        this.isPaused = false;
        this.curPos = 0;
        this.progress = 0;
        this._seekOffset = 0;
        this.audioMode = false;
        this.currentTitle = '';
        this.currentBvid = '';
        this.coverHold = false;
        this.buffering = false;
        this.streamPct = -1;
        this.streamDone = false;
        this.toast = '';
        this._setPlayerState('idle');
        this.isStopping = false;
        this.statusText = '播放已退出';
      }, 300);
    },
    readTouchPoint(e) {
      if (!e) return null;
      const t = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]) || (e.detail && typeof e.detail === 'object' ? e.detail : null) || e;
      const x = (typeof t.screenX === 'number') ? t.screenX :
                (typeof t.pageX === 'number') ? t.pageX :
                (typeof t.clientX === 'number') ? t.clientX :
                (typeof t.x === 'number') ? t.x : null;
      const y = (typeof t.screenY === 'number') ? t.screenY :
                (typeof t.pageY === 'number') ? t.pageY :
                (typeof t.clientY === 'number') ? t.clientY :
                (typeof t.y === 'number') ? t.y : null;
      if (x === null || y === null) return null;
      return { x: x, y: y };
    },
    // 进度条只支持「点击跳转」，已移除拖动 seek（设备触摸事件不稳，容易误触发连续重开解码）
    _handleProgressSeek(e) {
      if (!this.isPlaying || !this.vDuration || this.vDuration <= 0) return;
      if (this.playerState === 'loading' || this.playerState === 'seeking' || this.playerState === 'error') return;
      // 与 ctrl-bar 固定布局一致：4(padding)+30+2+24+2 = 62；轨道宽 150。
      const PROG_X = 62;
      const PROG_W = 150;
      let pct = -1;
      if (e && typeof e.offsetX === 'number' && e.offsetX >= 0 && e.offsetX <= PROG_W + 4) {
        pct = e.offsetX / PROG_W;
      } else {
        const p = this.readTouchPoint(e);
        if (p && typeof p.x === 'number') pct = (p.x - PROG_X) / PROG_W;
      }
      if (pct < 0) return;
      if (pct > 1) pct = 1;
      const targetSec = Math.max(0, Math.round(pct * this.vDuration));
      console.warn('[Seek] progress tap: pct=' + pct.toFixed(3) + ' targetSec=' + targetSec + ' / ' + this.vDuration);
      this.seekTo(targetSec);
    },
    onProgressClick(e) {
      if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
      this._showCtrlBar();
      this._handleProgressSeek(e);
    },
    seekTo(targetSec) {
      if (this.isStopping || !this.isPlaying) return;
      const item = this._playItem || this.detailItem();
      if (!item) return;

      // 统一取整：拖动/裁剪切换都会传进小数（日志里出现过 ss=35.493812500000006）
      targetSec = Math.round(Number(targetSec) || 0);
      if (targetSec < 0) targetSec = 0;
      if (this.vDuration > 0 && targetSec > this.vDuration - 2) targetSec = Math.max(0, this.vDuration - 2);

      const now = Date.now();
      // 连续快进会把「stop → 重建解码/音频」叠起来：旧的 native 线程还没收尾就换缓冲区 = UAF 崩溃。
      // 改成串行：正在跳转时只记下最后一次目标，等当前跳转真正出帧后（_nativeTick）再补跳。
      if (this._seekBusy) {
        this._pendingSeekTo = targetSec;
        console.warn('[Seek] busy, queue ' + targetSec + 's');
        return;
      }
      if (this._lastSeekAt && now - this._lastSeekAt < 900) {
        this._pendingSeekTo = targetSec;
        if (!this._seekDeferTimer) {
          const wait = 900 - (now - this._lastSeekAt);
          this._seekDeferTimer = this.$page.setTimeout(() => {
            this._seekDeferTimer = null;
            const t = this._pendingSeekTo;
            this._pendingSeekTo = null;
            if (t != null) this.seekTo(t);
          }, wait);
        }
        return;
      }
      this._lastSeekAt = now;
      this._seekBusy = true;
      this._seekSince = now;

      console.warn('[Seek] seekTo ' + targetSec + 's for ' + item.bvid);
      this.isPaused = false;
      this.coverHold = false;
      this._coverPhase = 0;
      this._coverResumed = false;
      this.streamPct = -1;
      this.streamSource = '';
      this.streamDone = false;
      this.buffering = false;
      this._setPlayerState('seeking');
      this.curPos = targetSec;
      this.progress = this.vDuration > 0 ? (targetSec / this.vDuration) : 0;
      this._lastPos = targetSec;
      this._seekOffset = targetSec;
      this.statusText = '跳转中 ' + this.fmtTime(targetSec) + '...';

      // 彻底停止上一路音视频
      this._stopAudioOnly();
      this._stopVideoTick();
      if (this._syncTimer) {
        this.$page.clearTimeout(this._syncTimer);
        this._syncTimer = null;
      }
      if (this._infoResumeTimer) {
        this.$page.clearTimeout(this._infoResumeTimer);
        this._infoResumeTimer = null;
      }
      if (this.rgav && typeof this.rgav.stop === 'function') {
        try { this.rgav.stop(); } catch (e) {}
      }

      this.playGen = (this.playGen || 0) + 1;
      const gen = this.playGen;

      // 重置同步对齐状态
      this._frames = 0;
      this._drawMs = 0;
      this._perfAt = Date.now();
      this._lastCb = 0;
      this._maxGap = 0;
      this._audioRetry = 0;
      this._lastNativeRead = 0;
      this._emptyTicks = 0;
      this._lastPosCbTime = 0;
      this._posCbCount = 0;
      this._syncDone = false;
      this._audioPos = targetSec;
      this._audioPosAt = 0;
      this._lastAdjustAt = 0;
      this._resumeAt = 0;
      this._latePrimeAt = 0;
      this._latePrimeDone = false;
      this._primeCheckAt = 0;
      this._driftEwma = 0;
      this._syncSampleCount = 0;
      this._nextDue = 0;
      this._audioClockReset();
      this._hardResyncStrikes = 0;
      this._lastAdvancePos = 0;
      this._lastAdvanceAt = Date.now();
      this._stallAudioPaused = false;
      this._audioPrewarm = false;
      this._audioParked = false;
      this._audioParkAt = 0;
      this._audioSyncingPaused = false;
      this._startedAt = Date.now();
      this._lastAudioNow = 0;
      this._lastAudioNowAt = 0;
      this._audioPosAt = 0;
      this._stallVideoPaused = false;
      this._bufLastAt = Date.now();
      this._bufLastPos = 0;

      // 启动视频；若输出尺寸随模式变化，先重建缓冲区（rgav 已 stop，可安全 setBuffer）
      let dec = this.playSize || { w: 640, h: 360 };
      const decNew = this.predictDecode((this.srcSize || {}).w, (this.srcSize || {}).h);
      if (OUT_ALIGN_DISPLAY && (decNew.w !== dec.w || decNew.h !== dec.h) && this.ctx) {
        dec = decNew;
        this.playSize = decNew;
        try {
          this.imageData = this.ctx.getImageData(0, 0, dec.w, dec.h);
          this._imageSize = dec.w + 'x' + dec.h;
          if (this.rgav && typeof this.rgav.setCropMode === 'function') this.rgav.setCropMode(0);
          if (this.imageData && this.imageData.data) this.rgav.setBuffer(this.imageData.data.buffer, dec.w, dec.h);
          console.warn('[Rga] out size -> ' + dec.w + 'x' + dec.h);
        } catch (e) {
          console.warn('[Rga] resize failed: ' + e);
        }
      }
      const streamUrl = 'http://127.0.0.1:18080/api/stream?bvid=' + item.bvid + '&ss=' + targetSec;
      try {
        this.rgav.start(streamUrl);
        console.warn('[Seek] rgav started: ' + streamUrl);
      } catch (e) {
        console.warn('[Seek] rgav start error: ' + e);
      }

      // 等待首帧就绪后启动音频并对齐
      this._waitPrimedThenAudio(gen, item);
      this._startStreamPoll(gen, item.bvid);
      this._startVideoTick(gen);
    }
  }
};

var style_0 = { "_": {
  "app-container": {
    "width": "640px",
    "height": "172px",
    "flexDirection": "row",
    "backgroundColor": "#0d0f12"
  },
  "base-layer": {
    "width": "640px",
    "height": "172px",
    "flexDirection": "row"
  },
  "left-nav": {
    "width": "48px",
    "height": "172px",
    "padding": "6px",
    "backgroundColor": "#14161a",
    "borderRightWidth": "1px",
    "borderRightStyle": "solid",
    "borderRightColor": "#282a30",
    "justifyContent": "space-between"
  },
  "brand-box": {
    "flexDirection": "row",
    "alignItems": "center",
    "marginBottom": "4px"
  },
  "brand-badge": {
    "backgroundColor": "#fb7299",
    "borderRadius": "3px",
    "paddingLeft": "3px",
    "paddingRight": "3px",
    "marginRight": "4px"
  },
  "brand-badge-text": {
    "color": "#ffffff",
    "fontSize": "9px",
    "fontWeight": "bold"
  },
  "brand-title": {
    "color": "#ffffff",
    "fontSize": "11px",
    "fontWeight": "bold"
  },
  "nav-list": {
    "flexDirection": "column"
  },
  "nav-btn": {
    "height": "22px",
    "borderRadius": "4px",
    "justifyContent": "center",
    "alignItems": "center",
    "marginBottom": "3px",
    "backgroundColor": "#1e2127"
  },
  "nav-btn-active": {
    "backgroundColor": "#fb7299"
  },
  "nav-btn-text": {
    "color": "#99a2aa",
    "fontSize": "11px"
  },
  "nav-btn-text-active": {
    "color": "#ffffff",
    "fontWeight": "bold"
  },
  "content-panel": {
    "position": "relative",
    "width": "592px",
    "height": "172px",
    "flexDirection": "column",
    "backgroundColor": "#0d0f12"
  },
  "banner": {
    "height": "26px",
    "backgroundColor": "#181a20",
    "flexDirection": "row",
    "alignItems": "center",
    "justifyContent": "space-between",
    "paddingLeft": "8px",
    "paddingRight": "8px",
    "borderBottomWidth": "1px",
    "borderBottomStyle": "solid",
    "borderBottomColor": "#242730"
  },
  "banner-text": {
    "color": "#00aeec",
    "fontSize": "11px",
    "lines": 1,
    "textOverflow": "ellipsis",
    "maxWidth": "400px"
  },
  "btn-change": {
    "backgroundColor": "#282b33",
    "borderRadius": "3px",
    "paddingLeft": "6px",
    "paddingRight": "6px",
    "paddingTop": "2px",
    "paddingBottom": "2px"
  },
  "btn-change-text": {
    "color": "#fb7299",
    "fontSize": "10px",
    "fontWeight": "bold"
  },
  "card-scroller": {
    "width": "545px",
    "height": "146px",
    "flexDirection": "row"
  },
  "nav-icons": {
    "flexDirection": "column",
    "alignItems": "center",
    "marginTop": "6px"
  },
  "nav-icon": {
    "width": "36px",
    "height": "36px",
    "marginBottom": "6px",
    "borderRadius": "8px",
    "backgroundColor": "#1a1c22",
    "justifyContent": "center",
    "alignItems": "center"
  },
  "nav-icon-active": {
    "backgroundColor": "#fb7299"
  },
  "nav-icon-text": {
    "color": "#ffffff",
    "fontSize": "14px",
    "fontWeight": "bold"
  },
  "nav-tip": {
    "position": "absolute",
    "left": "2px",
    "bottom": "2px",
    "width": "40px",
    "justifyContent": "center"
  },
  "nav-tip-text": {
    "color": "#99a2aa",
    "fontSize": "8px"
  },
  "action-bar": {
    "height": "26px",
    "flexDirection": "row",
    "alignItems": "center",
    "justifyContent": "space-between",
    "paddingLeft": "6px",
    "paddingRight": "6px",
    "backgroundColor": "#14161a"
  },
  "action-title": {
    "color": "#ffffff",
    "fontSize": "11px",
    "fontWeight": "bold"
  },
  "action-btns": {
    "flexDirection": "row",
    "alignItems": "center"
  },
  "action-btn": {
    "height": "20px",
    "paddingLeft": "6px",
    "paddingRight": "6px",
    "marginLeft": "4px",
    "borderRadius": "4px",
    "backgroundColor": "#22252c",
    "justifyContent": "center",
    "alignItems": "center"
  },
  "action-btn-active": {
    "backgroundColor": "#0a84ff"
  },
  "action-btn-refresh": {
    "backgroundColor": "#2b2f38"
  },
  "action-btn-busy": {
    "backgroundColor": "#1b3a4a"
  },
  "action-btn-danger": {
    "backgroundColor": "#3a1d24"
  },
  "refresh-bar": {
    "position": "absolute",
    "left": "0px",
    "top": "26px",
    "width": "592px",
    "height": "2px",
    "backgroundColor": "rgba(255,255,255,0.08)",
    "zIndex": 110
  },
  "refresh-fill": {
    "height": "2px",
    "backgroundColor": "#00aeec"
  },
  "action-btn-text": {
    "color": "#ffffff",
    "fontSize": "10px"
  },
  "grid-row": {
    "position": "relative",
    "flexDirection": "row",
    "width": "596px",
    "height": "142px"
  },
  "grid-2x2": {
    "width": "556px",
    "height": "142px",
    "flexDirection": "row",
    "flexWrap": "wrap"
  },
  "video-card-grid": {
    "width": "274px",
    "height": "67px",
    "margin": "2px",
    "flexDirection": "row",
    "alignItems": "center",
    "padding": "2px"
  },
  "card-thumb-grid": {
    "width": "92px",
    "height": "54px",
    "borderRadius": "4px"
  },
  "card-info-grid": {
    "width": "172px",
    "height": "60px",
    "paddingLeft": "4px",
    "flexDirection": "column",
    "justifyContent": "center"
  },
  "video-card-title-grid": {
    "fontSize": "10px",
    "height": "30px"
  },
  "video-card-owner-grid": {
    "fontSize": "9px",
    "color": "#99a2aa"
  },
  "pager": {
    "width": "30px",
    "height": "146px",
    "flexDirection": "column",
    "alignItems": "center",
    "justifyContent": "space-between",
    "paddingTop": "4px",
    "paddingBottom": "4px"
  },
  "pager-num": {
    "color": "#99a2aa",
    "fontSize": "9px"
  },
  "pager-btn": {
    "width": "28px",
    "height": "44px",
    "borderRadius": "6px",
    "backgroundColor": "#22252c",
    "justifyContent": "center",
    "alignItems": "center"
  },
  "pager-btn-text": {
    "color": "#ffffff",
    "fontSize": "12px"
  },
  "fav-folders": {
    "width": "564px",
    "height": "142px",
    "flexDirection": "row",
    "flexWrap": "wrap"
  },
  "fav-folder": {
    "width": "278px",
    "height": "40px",
    "margin": "2px",
    "borderRadius": "6px",
    "backgroundColor": "#1a1c22",
    "flexDirection": "row",
    "alignItems": "center",
    "justifyContent": "space-between",
    "paddingLeft": "8px",
    "paddingRight": "8px"
  },
  "fav-folder-name": {
    "color": "#ffffff",
    "fontSize": "11px"
  },
  "fav-folder-count": {
    "color": "#99a2aa",
    "fontSize": "9px"
  },
  "video-card": {
    "position": "relative",
    "width": "135px",
    "height": "138px",
    "margin": "4px",
    "backgroundColor": "#1a1c22",
    "borderRadius": "6px",
    "overflow": "hidden",
    "justifyContent": "space-between"
  },
  "card-thumb": {
    "width": "135px",
    "height": "76px",
    "backgroundColor": "#252830"
  },
  "card-info": {
    "padding": "4px",
    "flexDirection": "column",
    "justifyContent": "space-between",
    "height": "58px"
  },
  "video-card-title": {
    "color": "#ffffff",
    "fontSize": "10px",
    "lines": 2,
    "textOverflow": "ellipsis",
    "height": "26px"
  },
  "video-card-footer": {
    "flexDirection": "row",
    "justifyContent": "space-between",
    "alignItems": "center"
  },
  "video-card-owner": {
    "color": "#fb7299",
    "fontSize": "9px",
    "maxWidth": "80px",
    "lines": 1,
    "textOverflow": "ellipsis"
  },
  "video-card-action": {
    "color": "#00aeec",
    "fontSize": "9px",
    "fontWeight": "bold"
  },
  "chips-scroller": {
    "width": "545px",
    "height": "28px",
    "backgroundColor": "#121418",
    "flexDirection": "row",
    "alignItems": "center",
    "paddingLeft": "6px",
    "paddingRight": "6px"
  },
  "chip-item": {
    "backgroundColor": "#22252c",
    "borderRadius": "3px",
    "paddingLeft": "6px",
    "paddingRight": "6px",
    "paddingTop": "2px",
    "paddingBottom": "2px",
    "marginRight": "6px",
    "height": "20px",
    "justifyContent": "center"
  },
  "chip-item-text": {
    "color": "#00aeec",
    "fontSize": "10px"
  },
  "login-box": {
    "width": "545px",
    "height": "146px",
    "flexDirection": "row",
    "alignItems": "center",
    "padding": "12px"
  },
  "qr-image": {
    "width": "110px",
    "height": "110px",
    "borderRadius": "6px",
    "backgroundColor": "#ffffff",
    "marginRight": "16px"
  },
  "avatar-badge": {
    "width": "60px",
    "height": "60px",
    "borderRadius": "30px",
    "backgroundColor": "#fb7299",
    "justifyContent": "center",
    "alignItems": "center",
    "marginRight": "16px"
  },
  "avatar-text": {
    "color": "#ffffff",
    "fontSize": "18px",
    "fontWeight": "bold"
  },
  "login-info-box": {
    "flexDirection": "column",
    "justifyContent": "center"
  },
  "login-title": {
    "color": "#ffffff",
    "fontSize": "13px",
    "fontWeight": "bold",
    "marginBottom": "4px"
  },
  "login-tip": {
    "color": "#99a2aa",
    "fontSize": "10px",
    "marginBottom": "4px"
  },
  "login-status": {
    "color": "#fb7299",
    "fontSize": "11px",
    "marginBottom": "8px"
  },
  "app-version": {
    "color": "#666b75",
    "fontSize": "10px",
    "marginTop": "6px"
  },
  "btn-action": {
    "backgroundColor": "#fb7299",
    "borderRadius": "4px",
    "height": "24px",
    "width": "90px",
    "justifyContent": "center",
    "alignItems": "center"
  },
  "btn-action-text": {
    "color": "#ffffff",
    "fontSize": "11px",
    "fontWeight": "bold"
  },
  "play-left": {
    "position": "relative",
    "width": "306px",
    "height": "172px",
    "backgroundColor": "#000000",
    "justifyContent": "center",
    "alignItems": "center"
  },
  "ctrl-bar": {
    "position": "absolute",
    "left": "0px",
    "bottom": "0px",
    "width": "306px",
    "height": "24px",
    "backgroundColor": "rgba(0,0,0,0.62)",
    "flexDirection": "row",
    "alignItems": "center",
    "paddingLeft": "4px",
    "paddingRight": "4px",
    "zIndex": 101
  },
  "ctrl-btn": {
    "width": "30px",
    "height": "20px",
    "marginRight": "2px",
    "borderRadius": "3px",
    "backgroundColor": "rgba(255,255,255,0.18)",
    "justifyContent": "center",
    "alignItems": "center"
  },
  "ctrl-btn-sm": {
    "width": "24px"
  },
  "ctrl-btn-text": {
    "color": "#ffffff",
    "fontSize": "9px"
  },
  "ctrl-track": {
    "position": "relative",
    "width": "150px",
    "height": "12px",
    "marginRight": "2px",
    "backgroundColor": "rgba(255,255,255,0.28)",
    "borderRadius": "6px",
    "justifyContent": "center",
    "overflow": "hidden"
  },
  "ctrl-buf": {
    "position": "absolute",
    "left": "0px",
    "top": "0px",
    "height": "12px",
    "backgroundColor": "rgba(255,255,255,0.38)",
    "borderRadius": "6px"
  },
  "ctrl-fill": {
    "position": "absolute",
    "left": "0px",
    "top": "2px",
    "height": "8px",
    "backgroundColor": "#fb7299",
    "borderRadius": "4px"
  },
  "ctrl-time": {
    "width": "56px",
    "color": "#ffffff",
    "fontSize": "8px",
    "textAlign": "right"
  },
  "pl-mask": {
    "position": "absolute",
    "left": "0px",
    "top": "0px",
    "width": "306px",
    "height": "148px",
    "backgroundColor": "rgba(0,0,0,0.55)",
    "justifyContent": "center",
    "alignItems": "center",
    "zIndex": 103
  },
  "pl-spin": {
    "color": "#fb7299",
    "fontSize": "18px",
    "height": "22px"
  },
  "pl-msg": {
    "color": "#ffffff",
    "fontSize": "10px",
    "marginTop": "2px"
  },
  "pl-bar": {
    "width": "160px",
    "height": "3px",
    "marginTop": "8px",
    "borderRadius": "2px",
    "backgroundColor": "rgba(255,255,255,0.22)",
    "flexDirection": "row"
  },
  "pl-bar-fill": {
    "height": "3px",
    "borderRadius": "2px",
    "backgroundColor": "#fb7299"
  },
  "pl-bar-sweep": {
    "height": "3px",
    "borderRadius": "2px",
    "backgroundColor": "#fb7299"
  },
  "pl-err-btns": {
    "flexDirection": "row",
    "marginTop": "10px"
  },
  "pl-err-btn": {
    "width": "56px",
    "height": "20px",
    "marginLeft": "4px",
    "marginRight": "4px",
    "borderRadius": "4px",
    "backgroundColor": "#fb7299",
    "justifyContent": "center",
    "alignItems": "center"
  },
  "pl-err-btn-text": {
    "color": "#ffffff",
    "fontSize": "10px"
  },
  "pl-bigplay": {
    "position": "absolute",
    "left": "117px",
    "top": "50px",
    "width": "72px",
    "height": "72px",
    "borderRadius": "36px",
    "backgroundColor": "rgba(0,0,0,0.55)",
    "borderWidth": "1px",
    "borderStyle": "solid",
    "borderColor": "rgba(255,255,255,0.55)",
    "justifyContent": "center",
    "alignItems": "center",
    "zIndex": 104
  },
  "pl-bigplay-icon": {
    "color": "#ffffff",
    "fontSize": "26px",
    "marginLeft": "4px"
  },
  "pl-pill": {
    "position": "absolute",
    "right": "6px",
    "top": "6px",
    "height": "14px",
    "paddingLeft": "5px",
    "paddingRight": "5px",
    "borderRadius": "7px",
    "backgroundColor": "rgba(0,0,0,0.6)",
    "justifyContent": "center",
    "zIndex": 102
  },
  "pl-pill-text": {
    "color": "#ffffff",
    "fontSize": "8px"
  },
  "side-panel": {
    "width": "334px",
    "height": "172px",
    "backgroundColor": "#0f1116"
  },
  "side-head": {
    "height": "24px",
    "flexDirection": "row",
    "alignItems": "center",
    "backgroundColor": "#161922",
    "paddingLeft": "2px",
    "paddingRight": "2px"
  },
  "side-back": {
    "width": "20px",
    "height": "20px",
    "justifyContent": "center",
    "alignItems": "center"
  },
  "side-back-text": {
    "color": "#ffffff",
    "fontSize": "15px"
  },
  "side-tabs": {
    "flexDirection": "row",
    "flex": 1
  },
  "side-tab": {
    "flex": 1,
    "height": "24px",
    "justifyContent": "center",
    "alignItems": "center"
  },
  "side-tab-active": {
    "borderBottomWidth": "2px",
    "borderBottomStyle": "solid",
    "borderBottomColor": "#fb7299"
  },
  "side-tab-text": {
    "color": "#ffffff",
    "fontSize": "10px"
  },
  "side-body": {
    "width": "334px",
    "height": "148px",
    "paddingLeft": "6px",
    "paddingRight": "6px",
    "paddingTop": "3px"
  },
  "side-title": {
    "color": "#ffffff",
    "fontSize": "11px",
    "height": "30px",
    "lines": 2,
    "textOverflow": "ellipsis"
  },
  "side-desc": {
    "color": "#99a2aa",
    "fontSize": "9px",
    "height": "36px",
    "lines": 3,
    "textOverflow": "ellipsis",
    "marginTop": "2px"
  },
  "side-sub": {
    "color": "#99a2aa",
    "fontSize": "9px"
  },
  "side-scroller": {
    "width": "322px",
    "height": "104px"
  },
  "side-row": {
    "height": "22px",
    "justifyContent": "center"
  },
  "side-row-text": {
    "color": "#d9dde3",
    "fontSize": "10px",
    "lines": 1,
    "textOverflow": "ellipsis"
  },
  "rel-row": {
    "flexDirection": "row",
    "width": "318px",
    "height": "32px",
    "marginBottom": "2px",
    "borderRadius": "3px",
    "backgroundColor": "#1c1f25",
    "alignItems": "center",
    "paddingLeft": "2px"
  },
  "rel-thumb": {
    "width": "52px",
    "height": "29px",
    "borderRadius": "2px",
    "backgroundColor": "#2a2d34"
  },
  "rel-info": {
    "width": "258px",
    "flexDirection": "column",
    "justifyContent": "center",
    "paddingLeft": "4px"
  },
  "rel-title": {
    "color": "#ffffff",
    "fontSize": "9px",
    "height": "12px",
    "lines": 1,
    "textOverflow": "ellipsis"
  },
  "rel-sub": {
    "color": "#8b8f98",
    "fontSize": "8px",
    "height": "11px",
    "lines": 1,
    "textOverflow": "ellipsis"
  },
  "act-row": {
    "flexDirection": "row",
    "height": "26px",
    "alignItems": "center"
  },
  "act-btn": {
    "height": "20px",
    "paddingLeft": "6px",
    "paddingRight": "6px",
    "marginRight": "4px",
    "borderRadius": "4px",
    "backgroundColor": "#22252c",
    "justifyContent": "center",
    "alignItems": "center"
  },
  "act-btn-on": {
    "backgroundColor": "#fb7299"
  },
  "act-btn-text": {
    "color": "#ffffff",
    "fontSize": "9px"
  },
  "more-row": {
    "flexDirection": "row",
    "height": "22px",
    "alignItems": "center"
  },
  "more-btn": {
    "height": "18px",
    "paddingLeft": "5px",
    "paddingRight": "5px",
    "marginRight": "4px",
    "borderRadius": "3px",
    "backgroundColor": "#2b2f38",
    "justifyContent": "center",
    "alignItems": "center"
  },
  "more-btn-text": {
    "color": "#ffffff",
    "fontSize": "9px"
  },
  "chip-row": {
    "flexDirection": "row",
    "height": "20px",
    "alignItems": "center"
  },
  "chip": {
    "height": "16px",
    "paddingLeft": "5px",
    "paddingRight": "5px",
    "marginRight": "4px",
    "borderRadius": "3px",
    "backgroundColor": "#22252c",
    "justifyContent": "center",
    "alignItems": "center"
  },
  "chip-on": {
    "backgroundColor": "#0a84ff"
  },
  "chip-text": {
    "color": "#ffffff",
    "fontSize": "9px"
  },
  "chip-bar": {
    "height": "24px",
    "flexDirection": "row",
    "alignItems": "center",
    "paddingLeft": "6px",
    "backgroundColor": "#0d0f12"
  },
  "chip-note": {
    "marginLeft": "6px",
    "color": "#99a2aa",
    "fontSize": "9px"
  },
  "card-del": {
    "position": "absolute",
    "right": "4px",
    "bottom": "4px",
    "width": "42px",
    "height": "20px",
    "borderRadius": "4px",
    "backgroundColor": "rgba(251,114,153,0.22)",
    "justifyContent": "center",
    "alignItems": "center",
    "zIndex": 12
  },
  "card-del-text": {
    "color": "#fb7299",
    "fontSize": "9px"
  },
  "grid-empty": {
    "position": "absolute",
    "left": "0px",
    "top": "0px",
    "width": "556px",
    "height": "100px",
    "justifyContent": "center",
    "alignItems": "center",
    "zIndex": 5
  },
  "grid-empty-text": {
    "color": "#666b75",
    "fontSize": "11px"
  },
  "chip-nav": {
    "width": "34px",
    "height": "22px",
    "backgroundColor": "#333842",
    "borderRadius": "5px"
  },
  "chip-nav-text": {
    "color": "#ffffff",
    "fontSize": "16px",
    "fontWeight": "bold"
  },
  "cm-row": {
    "height": "34px",
    "flexDirection": "column",
    "justifyContent": "center"
  },
  "cm-name": {
    "color": "#99a2aa",
    "fontSize": "9px"
  },
  "cm-text": {
    "color": "#d9dde3",
    "fontSize": "10px",
    "lines": 1,
    "textOverflow": "ellipsis"
  },
  "player-panel": {
    "position": "absolute",
    "left": "0px",
    "top": "0px",
    "width": "640px",
    "height": "172px",
    "flexDirection": "row",
    "backgroundColor": "#000000",
    "zIndex": 99
  },
  "player-canvas-box": {
    "position": "absolute",
    "left": "0px",
    "top": "0px",
    "width": "306px",
    "height": "172px",
    "justifyContent": "center",
    "alignItems": "center",
    "backgroundColor": "#000000",
    "overflow": "hidden"
  },
  "player-canvas": {
    "width": "640px",
    "height": "360px",
    "transform": "scale(0.4777)",
    "transformOrigin": "center center"
  },
  "player-progress": {
    "position": "absolute",
    "left": "10px",
    "width": "620px",
    "bottom": "4px",
    "height": "18px",
    "flexDirection": "row",
    "alignItems": "center",
    "zIndex": 101
  },
  "pp-time": {
    "width": "72px",
    "color": "#ffffff",
    "fontSize": "10px"
  },
  "pp-bar": {
    "width": "500px",
    "height": "12px",
    "marginLeft": "8px",
    "backgroundColor": "rgba(255,255,255,0.25)",
    "borderRadius": "4px",
    "justifyContent": "center"
  },
  "pp-fill": {
    "height": "12px",
    "backgroundColor": "#fb7299",
    "borderRadius": "4px"
  },
  "pp-btn": {
    "width": "30px",
    "height": "16px",
    "marginLeft": "8px",
    "backgroundColor": "rgba(255,255,255,0.18)",
    "borderRadius": "3px",
    "justifyContent": "center",
    "alignItems": "center"
  },
  "pp-btn-text": {
    "color": "#ffffff",
    "fontSize": "10px",
    "fontWeight": "bold"
  },
  "player-header": {
    "position": "absolute",
    "left": "0px",
    "top": "0px",
    "width": "640px",
    "height": "28px",
    "backgroundColor": "rgba(0, 0, 0, 0.65)",
    "flexDirection": "row",
    "alignItems": "center",
    "justifyContent": "space-between",
    "paddingLeft": "10px",
    "paddingRight": "10px",
    "zIndex": 100
  },
  "btn-exit": {
    "backgroundColor": "#fb7299",
    "borderRadius": "4px",
    "paddingLeft": "10px",
    "paddingRight": "10px",
    "height": "22px",
    "justifyContent": "center",
    "alignItems": "center"
  },
  "player-actions": {
    "flexDirection": "row",
    "alignItems": "center"
  },
  "btn-exit-text": {
    "color": "#ffffff",
    "fontSize": "11px",
    "fontWeight": "bold"
  },
  "search-banner": {
    "paddingLeft": "6px",
    "paddingRight": "6px"
  },
  "search-input": {
    "width": "360px",
    "height": "22px",
    "backgroundColor": "#1e2127",
    "borderRadius": "3px",
    "paddingLeft": "8px",
    "paddingRight": "8px",
    "justifyContent": "center"
  },
  "search-input-text": {
    "color": "#ffffff",
    "fontSize": "11px",
    "lines": 1,
    "textOverflow": "ellipsis",
    "maxWidth": "340px"
  },
  "search-input-placeholder": {
    "color": "#666b75"
  },
  "search-input-box": {
    "width": "360px",
    "height": "22px",
    "marginRight": "8px",
    "backgroundColor": "#1e2127",
    "borderRadius": "3px"
  },
  "kb-panel": {
    "position": "absolute",
    "left": "0px",
    "top": "0px",
    "width": "640px",
    "height": "172px",
    "flexDirection": "column",
    "backgroundColor": "#0b0d10",
    "zIndex": 130
  },
  "kb-top": {
    "width": "640px",
    "height": "26px",
    "flexDirection": "row",
    "alignItems": "center",
    "paddingLeft": "8px",
    "paddingRight": "8px",
    "backgroundColor": "#181a20"
  },
  "kb-preview": {
    "width": "470px",
    "color": "#ffffff",
    "fontSize": "11px",
    "lines": 1,
    "textOverflow": "ellipsis"
  },
  "kb-top-btn": {
    "height": "20px",
    "paddingLeft": "10px",
    "paddingRight": "10px",
    "marginLeft": "6px",
    "borderRadius": "3px",
    "backgroundColor": "#282b33",
    "justifyContent": "center",
    "alignItems": "center"
  },
  "kb-top-btn-go": {
    "backgroundColor": "#00aeec"
  },
  "kb-top-btn-text": {
    "color": "#ffffff",
    "fontSize": "10px",
    "fontWeight": "bold"
  },
  "kb-row": {
    "width": "640px",
    "height": "34px",
    "flexDirection": "row",
    "alignItems": "center"
  },
  "kb-key": {
    "width": "60px",
    "height": "30px",
    "margin": "2px",
    "borderRadius": "4px",
    "backgroundColor": "#1e2127",
    "justifyContent": "center",
    "alignItems": "center"
  },
  "kb-key-text": {
    "color": "#ffffff",
    "fontSize": "11px"
  },
  "search-count": {
    "color": "#99a2aa",
    "fontSize": "9px",
    "marginRight": "8px"
  },
  "btn-clear": {
    "width": "20px",
    "height": "20px",
    "borderRadius": "10px",
    "marginRight": "8px",
    "backgroundColor": "#3a3f49",
    "justifyContent": "center",
    "alignItems": "center"
  },
  "btn-clear-text": {
    "color": "#c7ccd4",
    "fontSize": "11px",
    "fontWeight": "bold"
  },
  "btn-search": {
    "backgroundColor": "#00aeec",
    "borderRadius": "3px",
    "height": "20px",
    "paddingLeft": "10px",
    "paddingRight": "10px",
    "justifyContent": "center",
    "alignItems": "center"
  },
  "btn-search-text": {
    "color": "#ffffff",
    "fontSize": "10px",
    "fontWeight": "bold"
  },
  "detail-panel": {
    "position": "absolute",
    "left": "0px",
    "top": "0px",
    "width": "640px",
    "height": "172px",
    "flexDirection": "column",
    "backgroundColor": "#0d0f12",
    "zIndex": 90
  },
  "detail-header": {
    "width": "640px",
    "height": "28px",
    "flexDirection": "row",
    "alignItems": "center",
    "justifyContent": "space-between",
    "paddingLeft": "8px",
    "paddingRight": "8px",
    "backgroundColor": "#181a20",
    "borderBottomWidth": "1px",
    "borderBottomStyle": "solid",
    "borderBottomColor": "#242730"
  },
  "btn-back": {
    "backgroundColor": "#282b33",
    "borderRadius": "4px",
    "height": "22px",
    "paddingLeft": "8px",
    "paddingRight": "8px",
    "justifyContent": "center",
    "alignItems": "center"
  },
  "btn-back-text": {
    "color": "#ffffff",
    "fontSize": "10px"
  },
  "detail-title": {
    "color": "#ffffff",
    "fontSize": "11px",
    "maxWidth": "500px",
    "lines": 1,
    "textOverflow": "ellipsis"
  },
  "detail-badge": {
    "color": "#00aeec",
    "fontSize": "9px"
  },
  "detail-body": {
    "width": "640px",
    "height": "144px",
    "flexDirection": "row",
    "padding": "8px"
  },
  "detail-cover": {
    "width": "160px",
    "height": "90px",
    "borderRadius": "6px",
    "backgroundColor": "#252830",
    "marginRight": "12px"
  },
  "detail-info": {
    "width": "440px",
    "height": "128px",
    "flexDirection": "column",
    "justifyContent": "space-between"
  },
  "detail-name": {
    "color": "#ffffff",
    "fontSize": "12px",
    "height": "32px",
    "lines": 2,
    "textOverflow": "ellipsis"
  },
  "detail-meta": {
    "color": "#99a2aa",
    "fontSize": "9px"
  },
  "detail-error": {
    "color": "#ff8a80",
    "fontSize": "9px"
  },
  "detail-actions": {
    "flexDirection": "row",
    "alignItems": "center",
    "height": "28px"
  },
  "detail-btn": {
    "height": "26px",
    "borderRadius": "4px",
    "paddingLeft": "12px",
    "paddingRight": "12px",
    "marginRight": "8px",
    "justifyContent": "center",
    "alignItems": "center"
  },
  "detail-btn-play": {
    "backgroundColor": "#00aeec"
  },
  "detail-btn-audio": {
    "backgroundColor": "#fb7299"
  },
  "detail-btn-dl": {
    "backgroundColor": "#2a2d35"
  },
  "detail-btn-text": {
    "color": "#ffffff",
    "fontSize": "11px",
    "fontWeight": "bold"
  },
  "detail-btn-text-dl": {
    "color": "#99a2aa"
  },
  "detail-btn-dl-done": {
    "backgroundColor": "#16382b",
    "borderWidth": "1px",
    "borderStyle": "solid",
    "borderColor": "#00e676"
  },
  "detail-btn-text-done": {
    "color": "#00e676"
  },
  "detail-btn-delete": {
    "backgroundColor": "#3a1d24",
    "borderWidth": "1px",
    "borderStyle": "solid",
    "borderColor": "#fb7299",
    "paddingLeft": "8px",
    "paddingRight": "8px"
  },
  "detail-btn-text-delete": {
    "color": "#fb7299"
  },
  "toast-box": {
    "position": "absolute",
    "left": "170px",
    "top": "138px",
    "width": "300px",
    "height": "24px",
    "borderRadius": "12px",
    "backgroundColor": "rgba(0, 0, 0, 0.82)",
    "justifyContent": "center",
    "alignItems": "center",
    "zIndex": 120
  },
  "toast-text": {
    "color": "#ffffff",
    "fontSize": "10px"
  },
  "audio-ui": {
    "position": "absolute",
    "left": "0px",
    "top": "28px",
    "width": "640px",
    "height": "144px",
    "flexDirection": "row",
    "alignItems": "center",
    "paddingLeft": "16px",
    "backgroundColor": "#0d0f12",
    "zIndex": 99
  },
  "audio-cover": {
    "width": "150px",
    "height": "84px",
    "borderRadius": "6px",
    "backgroundColor": "#252830",
    "marginRight": "16px"
  },
  "audio-info": {
    "width": "430px",
    "height": "100px",
    "flexDirection": "column",
    "justifyContent": "center"
  },
  "audio-tag": {
    "color": "#fb7299",
    "fontSize": "10px",
    "marginBottom": "4px"
  },
  "audio-title": {
    "color": "#ffffff",
    "fontSize": "13px",
    "fontWeight": "bold",
    "lines": 1,
    "textOverflow": "ellipsis",
    "marginBottom": "4px"
  },
  "audio-tip": {
    "color": "#99a2aa",
    "fontSize": "9px"
  }
}};

var render = function () {
  var _vm = this;
  var _h = _vm.$createElement;
  var _c = _vm._self._c || _h;

  var baseVisible = !_vm.isPlaying && _vm.currentView !== 'detail' && !_vm.kbVisible;
  return _c('div', { staticClass: ["app-container"] }, [
    (!baseVisible) ? _vm._e() : _c('div', { staticClass: ["base-layer"] }, [
    // Left Navigation
    _c('div', { staticClass: ["left-nav"] }, [
      // 左栏 3 个图标（首页 / 历史 / 我的），长按显示名称——对齐市面版本的交互
      _c('div', { staticClass: ["nav-icons"] }, [
        _c('div', {
          staticClass: ["nav-icon"],
          class: [_vm.currentTab === 'feed' ? 'nav-icon-active' : ''],
          on: {
            "click": function () { _vm.switchTab('feed'); },
            "touchstart": function () { _vm.iconPressStart('首页推荐'); },
            "touchend": function () { _vm.iconPressEnd(); },
            "touchmove": function () { _vm.iconPressEnd(); }
          }
        }, [_c('text', { staticClass: ["nav-icon-text"] }, [_vm._v("首")])]),
        _c('div', {
          staticClass: ["nav-icon"],
          class: [(_vm.currentTab === 'history' || _vm.currentTab === 'fav' || _vm.currentTab === 'download') ? 'nav-icon-active' : ''],
          on: {
            "click": function () { _vm.switchTab('history'); },
            "touchstart": function () { _vm.iconPressStart('历史 / 收藏 / 缓存'); },
            "touchend": function () { _vm.iconPressEnd(); },
            "touchmove": function () { _vm.iconPressEnd(); }
          }
        }, [_c('text', { staticClass: ["nav-icon-text"] }, [_vm._v("史")])]),
        _c('div', {
          staticClass: ["nav-icon"],
          class: [_vm.currentTab === 'login' ? 'nav-icon-active' : ''],
          on: {
            "click": function () { _vm.switchTab('login'); },
            "touchstart": function () { _vm.iconPressStart('我的 / 登录'); },
            "touchend": function () { _vm.iconPressEnd(); },
            "touchmove": function () { _vm.iconPressEnd(); }
          }
        }, [_c('text', { staticClass: ["nav-icon-text"] }, [_vm._v("我")])])
      ]),
      // 长按提示（不占常驻空间）
      (_vm.iconTip) ? _c('div', { staticClass: ["nav-tip"] }, [
        _c('text', { staticClass: ["nav-tip-text"] }, [_vm._v(_vm.iconTip)])
      ]) : _vm._e(),
      _c('div', { staticClass: ["nav-list-old"], style: { "display": "none" } }, [
        _c('div', {
          staticClass: ["nav-btn"],
          class: [_vm.currentTab === 'feed' ? 'nav-btn-active' : ''],
          on: { "click": function () { _vm.switchTab('feed'); } }
        }, [
          _c('text', {
            staticClass: ["nav-btn-text"],
            class: [_vm.currentTab === 'feed' ? 'nav-btn-text-active' : ''],
            on: { "click": function () { _vm.switchTab('feed'); } }
          }, [_vm._v("推荐")])
        ]),
        _c('div', {
          staticClass: ["nav-btn"],
          class: [_vm.currentTab === 'history' ? 'nav-btn-active' : ''],
          on: { "click": function () { _vm.switchTab('history'); } }
        }, [
          _c('text', {
            staticClass: ["nav-btn-text"],
            class: [_vm.currentTab === 'history' ? 'nav-btn-text-active' : ''],
            on: { "click": function () { _vm.switchTab('history'); } }
          }, [_vm._v("历史")])
        ]),
        _c('div', {
          staticClass: ["nav-btn"],
          class: [_vm.currentTab === 'download' ? 'nav-btn-active' : ''],
          on: { "click": function () { _vm.switchTab('download'); } }
        }, [
          _c('text', {
            staticClass: ["nav-btn-text"],
            class: [_vm.currentTab === 'download' ? 'nav-btn-text-active' : ''],
            on: { "click": function () { _vm.switchTab('download'); } }
          }, [_vm._v("下载")])
        ]),
        _c('div', {
          staticClass: ["nav-btn"],
          class: [_vm.currentTab === 'search' ? 'nav-btn-active' : ''],
          on: { "click": function () { _vm.switchTab('search'); } }
        }, [
          _c('text', {
            staticClass: ["nav-btn-text"],
            class: [_vm.currentTab === 'search' ? 'nav-btn-text-active' : ''],
            on: { "click": function () { _vm.switchTab('search'); } }
          }, [_vm._v("搜索")])
        ]),
        _c('div', {
          staticClass: ["nav-btn"],
          class: [_vm.currentTab === 'login' ? 'nav-btn-active' : ''],
          on: { "click": function () { _vm.switchTab('login'); } }
        }, [
          _c('text', {
            staticClass: ["nav-btn-text"],
            class: [_vm.currentTab === 'login' ? 'nav-btn-text-active' : ''],
            on: { "click": function () { _vm.switchTab('login'); } }
          }, [_vm._v(_vm.isLoggedIn ? '我的' : '登录')])
        ])
      ])
    ]),

    // Right Content Panel
    _c('div', { staticClass: ["content-panel"] }, [
      // 顶部动作栏：标题 + 搜索/历史/收藏/缓存/刷新（对齐市面版本）
      _c('div', { staticClass: ["action-bar"] }, [
        _c('text', { staticClass: ["action-title"] }, [_vm._v(_vm.tabTitle())]),
        _c('div', { staticClass: ["action-btns"] }, [
          _c('div', { staticClass: ["action-btn"], class: [_vm.currentTab === 'search' ? 'action-btn-active' : ''], on: { "click": function () { _vm.switchTab('search'); } } }, [
            _c('text', { staticClass: ["action-btn-text"] }, [_vm._v("搜索")])
          ]),
          _c('div', { staticClass: ["action-btn"], class: [_vm.currentTab === 'history' ? 'action-btn-active' : ''], on: { "click": function () { _vm.switchTab('history'); } } }, [
            _c('text', { staticClass: ["action-btn-text"] }, [_vm._v("历史")])
          ]),
          _c('div', { staticClass: ["action-btn"], class: [_vm.currentTab === 'fav' ? 'action-btn-active' : ''], on: { "click": function () { _vm.switchTab('fav'); } } }, [
            _c('text', { staticClass: ["action-btn-text"] }, [_vm._v("收藏")])
          ]),
          _c('div', { staticClass: ["action-btn"], class: [_vm.currentTab === 'download' ? 'action-btn-active' : ''], on: { "click": function () { _vm.switchTab('download'); } } }, [
            _c('text', { staticClass: ["action-btn-text"] }, [_vm._v("缓存")])
          ]),
          (_vm.currentTab === 'fav' && _vm.favTitle) ? _c('div', { staticClass: ["action-btn"], on: { "click": function () { _vm.favTitle = ''; _vm.favItems = []; _vm.gridPage = 0; _vm.loadFavFolders(); } } }, [
            _c('text', { staticClass: ["action-btn-text"] }, [_vm._v("返回")])
          ]) : _vm._e(),
          (_vm.currentTab === 'history' && _vm.historySource === 'local') ? _c('div', { staticClass: ["action-btn"], on: { "click": _vm.clearHistory } }, [
            _c('text', { staticClass: ["action-btn-text"] }, [_vm._v("清空")])
          ]) : _vm._e(),
          (_vm.currentTab === 'download' && _vm.cacheSource === 'online' && _vm.cacheItems.length > 0) ? _c('div', { staticClass: ["action-btn", "action-btn-danger"], on: { "click": _vm.clearCache } }, [
            _c('text', { staticClass: ["action-btn-text"] }, [_vm._v("清空")])
          ]) : _vm._e(),
          _c('div', { staticClass: ["action-btn", "action-btn-refresh"], class: [_vm.refreshing ? 'action-btn-busy' : ''], on: { "click": _vm.actionRefresh } }, [
            _c('text', { staticClass: ["action-btn-text"] }, [_vm._v(_vm.refreshing ? "刷新中" : "刷新")])
          ])
        ])
      ]),
      (_vm.refreshing) ? _c('div', { staticClass: ["refresh-bar"] }, [
        _c('div', { staticClass: ["refresh-fill"], style: { width: _vm.refreshPct + '%' } })
      ]) : _vm._e(),
      // Top Banner
        (_vm.currentTab === 'search') ? _c('div', { staticClass: ["banner", "search-banner"] }, [
          _c('div', { staticClass: ["search-input"], on: { "click": _vm.openKeyboard } }, [
            _c('text', {
              staticClass: ["search-input-text"],
              class: [_vm.searchInput ? '' : 'search-input-placeholder']
            }, [_vm._v(_vm.searchInput || '点此输入关键词')])
          ]),
          _c('div', { staticClass: ["btn-clear"], on: { "click": _vm.clearSearchInput } }, [
            _c('text', { staticClass: ["btn-clear-text"] }, [_vm._v("✕")])
          ]),
          _c('text', { staticClass: ["search-count"] }, [_vm._v(_vm._s(_vm.searchResults.length) + " 条")]),
          _c('div', { staticClass: ["btn-search"], on: { "click": _vm.submitSearch } }, [
            _c('text', { staticClass: ["btn-search-text"] }, [_vm._v("搜索")])
          ])
        ]) : _vm._e(),
        // 二级芯片行：搜索=类型/排序，历史=来源
        (_vm.currentTab === 'search') ? _c('div', { staticClass: ["chip-bar"] }, [
          _c('div', { staticClass: ["chip"], class: [_vm.searchType === 'video' ? 'chip-on' : ''], on: { "click": function () { _vm.setSearchType('video'); } } }, [_c('text', { staticClass: ["chip-text"] }, [_vm._v("视频")])]),
          _c('div', { staticClass: ["chip"], class: [_vm.searchType === 'user' ? 'chip-on' : ''], on: { "click": function () { _vm.setSearchType('user'); } } }, [_c('text', { staticClass: ["chip-text"] }, [_vm._v("UP主")])]),
          _c('div', { staticClass: ["chip"], class: [_vm.searchOrder === 'totalrank' ? 'chip-on' : ''], on: { "click": function () { _vm.setSearchOrder('totalrank'); } } }, [_c('text', { staticClass: ["chip-text"] }, [_vm._v("综合")])]),
          _c('div', { staticClass: ["chip"], class: [_vm.searchOrder === 'click' ? 'chip-on' : ''], on: { "click": function () { _vm.setSearchOrder('click'); } } }, [_c('text', { staticClass: ["chip-text"] }, [_vm._v("播放")])]),
          _c('div', { staticClass: ["chip"], class: [_vm.searchOrder === 'pubdate' ? 'chip-on' : ''], on: { "click": function () { _vm.setSearchOrder('pubdate'); } } }, [_c('text', { staticClass: ["chip-text"] }, [_vm._v("最新")])])
        ]) : (_vm.currentTab === 'history') ? _c('div', { staticClass: ["chip-bar"] }, [
          _c('div', { staticClass: ["chip"], class: [_vm.historySource === 'local' ? 'chip-on' : ''], on: { "click": function () { _vm.setHistorySource('local'); } } }, [_c('text', { staticClass: ["chip-text"] }, [_vm._v("本地")])]),
          _c('div', { staticClass: ["chip"], class: [_vm.historySource === 'cloud' ? 'chip-on' : ''], on: { "click": function () { _vm.setHistorySource('cloud'); } } }, [_c('text', { staticClass: ["chip-text"] }, [_vm._v("云端")])])
        ]) : (_vm.currentTab === 'download') ? _c('div', { staticClass: ["chip-bar"] }, [
          _c('div', { staticClass: ["chip"], class: [_vm.cacheSource === 'online' ? 'chip-on' : ''], on: { "click": function () { _vm.setCacheSource('online'); } } }, [_c('text', { staticClass: ["chip-text"] }, [_vm._v("在线缓存")])]),
          _c('div', { staticClass: ["chip"], class: [_vm.cacheSource === 'offline' ? 'chip-on' : ''], on: { "click": function () { _vm.setCacheSource('offline'); } } }, [_c('text', { staticClass: ["chip-text"] }, [_vm._v("离线下载")])]),
          _c('text', { staticClass: ["chip-note"] }, [_vm._v(_vm.cacheSummary())])
        ]) : _vm._e(),
        (_vm.currentTab === 'feed' || _vm.currentTab === 'history' || _vm.currentTab === 'fav' ||
         _vm.currentTab === 'download' || _vm.currentTab === 'search') ? _c('div', { staticClass: ["grid-row"], style: { height: _vm.gridHeightPx() + 'px' } }, [
          ((_vm.currentTab === 'fav') && !_vm.favTitle && _vm.favFolders.length > 0)
            ? _c('div', { staticClass: ["fav-folders"] }, _vm._l(_vm.favFolders, function (fo) {
                return _c('div', { staticClass: ["fav-folder"], on: { "click": function () { _vm.openFavFolder(fo); } } }, [
                  _c('text', { staticClass: ["fav-folder-name"] }, [_vm._v(_vm._s(fo.title))]),
                  _c('text', { staticClass: ["fav-folder-count"] }, [_vm._v(_vm._s(fo.count) + " 个")])
                ]);
              }))
            : _c('div', { staticClass: ["grid-2x2"] }, _vm._l(_vm.gridItems(), function (item, index) {
                return _c('div', {
                  key: item.bvid || ('g' + index),
                  staticClass: ["video-card", "video-card-grid"],
                  style: { height: _vm.cardHeightPx() + 'px' },
                  on: { "click": function () { _vm.onGridCardTap(item); } }
                }, [
                  _c('image', {
                    staticClass: ["card-thumb", "card-thumb-grid"],
                    style: { height: _vm.thumbHeightPx() + 'px' },
                    attrs: { "src": _vm.thumbUrl(item.pic_local || item.pic) }
                  }),
                  _c('div', { staticClass: ["card-info", "card-info-grid"] }, [
                    _c('text', { staticClass: ["video-card-title", "video-card-title-grid"] }, [_vm._v(_vm._s(item.title) || item.bvid)]),
                    _c('text', { staticClass: ["video-card-owner", "video-card-owner-grid"] }, [_vm._v(_vm.gridCardFooter(item))])
                  ]),
                  (_vm.currentTab === 'download' && _vm.cacheSource === 'online')
                    ? _c('div', { staticClass: ["card-del"], on: { "click": function ($event) { if ($event && typeof $event.stopPropagation === 'function') $event.stopPropagation(); _vm._cardTapAt = Date.now(); _vm.confirmDeleteCache(item.bvid); } } }, [
                      _c('text', { staticClass: ["card-del-text"] }, [_vm._v("删除")])
                    ])
                    : ((_vm.currentTab === 'download' && _vm.cacheSource === 'offline')
                      ? _c('div', { staticClass: ["card-del"], on: { "click": function ($event) { if ($event && typeof $event.stopPropagation === 'function') $event.stopPropagation(); _vm._cardTapAt = Date.now(); _vm.confirmDeleteDownload(item.bvid); } } }, [
                        _c('text', { staticClass: ["card-del-text"] }, [_vm._v("移除")])
                      ])
                      : ((_vm.currentTab === 'fav' && _vm.favTitle)
                        ? _c('div', { staticClass: ["card-del"], on: { "click": function ($event) { if ($event && typeof $event.stopPropagation === 'function') $event.stopPropagation(); _vm._cardTapAt = Date.now(); _vm.removeFromFav(item); } } }, [
                          _c('text', { staticClass: ["card-del-text"] }, [_vm._v("移除")])
                        ])
                        : _vm._e()))
                ]);
              })),
          (_vm.gridItems().length === 0) ? _c('div', { staticClass: ["grid-empty"] }, [
            _c('text', { staticClass: ["grid-empty-text"] }, [_vm._v(_vm.gridEmptyText())])
          ]) : _vm._e(),
          _c('div', { staticClass: ["pager"], style: { height: _vm.gridHeightPx() + 'px' } }, [
            _c('text', { staticClass: ["pager-num"] }, [_vm._v((_vm.gridPage + 1) + "/" + _vm.gridPages())]),
            _c('div', { staticClass: ["pager-btn"], on: { "click": _vm.gridPrev } }, [_c('text', { staticClass: ["pager-btn-text"] }, [_vm._v("上")])]),
            _c('div', { staticClass: ["pager-btn"], on: { "click": _vm.gridNext } }, [_c('text', { staticClass: ["pager-btn-text"] }, [_vm._v("下")])])
          ])
        ]) : _vm._e(),

        // Tab: History（观看历史）
        // legacy: 历史卡片已并入统一网格
        (false && _vm.currentTab === 'history') ? (_vm.history.length > 0 ? _c('scroller', {
          staticClass: ["card-scroller"],
          style: { "height": "146px" },
          attrs: { "scrollDirection": "horizontal" }
        }, _vm._l(_vm.history, function (item, index) {
          return _c('div', {
            key: item.bvid,
            staticClass: ["video-card"],
            style: { "height": "138px" },
            on: { "click": function ($event) { _vm.openDetail({ bvid: item.bvid, title: item.title, pic: item.pic }); } }
          }, [
            _c('image', {
              staticClass: ["card-thumb"],
              attrs: { "src": _vm.thumbUrl(item.pic) }
            }),
            _c('div', { staticClass: ["card-info"] }, [
              _c('text', { staticClass: ["video-card-title"] }, [_vm._v(_vm._s(item.title) || item.bvid)]),
              _c('div', { staticClass: ["video-card-footer"] }, [
                _c('text', { staticClass: ["video-card-owner"] }, [_vm._v(_vm.historyTime(item.updated))]),
                _c('text', { staticClass: ["video-card-action"] }, [_vm._v(item.duration > 0 ? ('看至 ' + Math.round((item.position / (item.duration || 1)) * 100) + '%') : '详情')])
              ])
            ])
          ]);
        })) : _c('div', { staticClass: ["banner"] }, [
          _c('text', { staticClass: ["banner-text"] }, [_vm._v("暂无观看历史，播放过的视频会出现在这里")])
        ])) : _vm._e(),

        // Tab: Download（离线下载）
        // legacy: 缓存卡片已并入统一网格
        (false && _vm.currentTab === 'download') ? (_vm.downloads.length > 0 ? _c('scroller', {
          staticClass: ["card-scroller"],
          style: { "height": "146px" },
          attrs: { "scrollDirection": "horizontal" }
        }, _vm._l(_vm.downloads, function (item, index) {
          return _c('div', {
            key: item.bvid,
            staticClass: ["video-card"],
            style: { "height": "138px" },
            on: { "click": function ($event) { _vm.openDetail({ bvid: item.bvid, title: item.title, pic: item.pic, pic_local: item.pic_local }); } }
          }, [
            _c('image', {
              staticClass: ["card-thumb"],
              attrs: { "src": _vm.thumbUrl(item.pic_local || item.pic) }
            }),
            _c('div', { staticClass: ["card-info"] }, [
              _c('text', { staticClass: ["video-card-title"] }, [_vm._v(_vm._s(item.title) || item.bvid)]),
              _c('div', { staticClass: ["video-card-footer"] }, [
                _c('text', { staticClass: ["video-card-owner"] }, [_vm._v(item.status === 'completed' ? _vm.formatBytes(item.total_bytes) : (item.status === 'downloading' ? (item.progress + '%') : '排队中'))]),
                _c('text', {
                  staticClass: ["video-card-action"],
                  style: { color: item.status === 'completed' ? '#00e676' : '#fb7299' }
                }, [_vm._v(item.status === 'completed' ? "离线播放" : "下载中")])
              ])
            ])
          ]);
        })) : _c('div', { staticClass: ["banner"] }, [
          _c('text', { staticClass: ["banner-text"] }, [_vm._v("暂无离线内容，在任意视频详情页点击「下载」即可离线观看")])
        ])) : _vm._e(),

        // Tab 2: Search
        // legacy: 搜索结果已并入统一网格
        (false && _vm.currentTab === 'search') ? _c('scroller', {
          staticClass: ["card-scroller"],
          style: { "height": "146px" },
          attrs: { "scrollDirection": "horizontal" }
        }, _vm._l(_vm.searchResults, function (item, index) {
          return _c('div', {
            key: item.bvid,
            staticClass: ["video-card"],
            style: { "height": "138px" },
            on: { "click": function ($event) { _vm.openDetail(item); } }
          }, [
            _c('image', {
              staticClass: ["card-thumb"],
              attrs: { "src": _vm.thumbUrl(item.pic_local || item.pic) }
            }),
            _c('div', { staticClass: ["card-info"] }, [
              _c('text', { staticClass: ["video-card-title"] }, [_vm._v(_vm._s(item.title))]),
              _c('div', { staticClass: ["video-card-footer"] }, [
                _c('text', { staticClass: ["video-card-owner"] }, [_vm._v("UP: " + _vm._s(item.owner))]),
                _c('text', { staticClass: ["video-card-action"] }, [_vm._v("详情")])
              ])
            ])
          ]);
        })) : _vm._e(),

        // Tab 3: Login
        (_vm.currentTab === 'login') ? _c('div', { staticClass: ["login-box"] }, [
          (!_vm.isLoggedIn) ? _c('div', { style: { "flexDirection": "row", "alignItems": "center" } }, [
            (_vm.loginQrPath) ? _c('image', {
              staticClass: ["qr-image"],
              attrs: { "src": _vm.loginQrPath }
            }) : _c('div', { staticClass: ["qr-image"], style: { "justifyContent": "center", "alignItems": "center" } }, [
              _c('text', { style: { "color": "#666", "fontSize": "11px" } }, [_vm._v("生成中...")])
            ]),
            _c('div', { staticClass: ["login-info-box"] }, [
              _c('text', { staticClass: ["login-title"] }, [_vm._v("哔哩哔哩扫码登录")]),
              _c('text', { staticClass: ["login-tip"] }, [_vm._v("请打开手机B站App「扫一扫」")]),
              _c('text', { staticClass: ["login-status"] }, [_vm._v(_vm._s(_vm.loginStatusText))]),
              _c('div', {
                staticClass: ["btn-action"],
                on: { "click": _vm.refreshQr }
              }, [
                _c('text', { staticClass: ["btn-action-text"] }, [_vm._v("刷新二维码")])
              ])
            ])
          ]) : _c('div', { style: { "flexDirection": "row", "alignItems": "center" } }, [
            _c('div', { staticClass: ["avatar-badge"] }, [
              _c('text', { staticClass: ["avatar-text"] }, [_vm._v("UP")])
            ]),
            _c('div', { staticClass: ["login-info-box"] }, [
              _c('text', { staticClass: ["login-title"] }, [_vm._v("欢迎，" + _vm._s(_vm.user.uname))]),
              _c('text', { staticClass: ["login-tip"] }, [_vm._v("UID: " + _vm._s(_vm.user.mid))]),
              _c('text', { staticClass: ["login-status"], style: { "color": "#00e676" } }, [_vm._v("已成功登录，解锁全清高码流")]),
              _c('div', {
                staticClass: ["btn-action"],
                style: { "backgroundColor": "#333742" },
                on: { "click": _vm.logout }
              }, [
                _c('text', { staticClass: ["btn-action-text"] }, [_vm._v("退出登录")])
              ])
            ])
          ]),
          _c('text', { staticClass: ["app-version"] }, [_vm._v("BiliPen v" + (_vm.appVersion || '-'))])
        ]) : _vm._e()
      ])
    ]),

    // Video Detail Overlay
    (_vm.currentView === 'detail' && _vm.detail) ? _c('div', { staticClass: ["detail-panel"] }, [
      _c('div', { staticClass: ["detail-header"] }, [
        _c('div', { staticClass: ["btn-back"], on: { "click": _vm.closeDetail } }, [
          _c('text', { staticClass: ["btn-back-text"] }, [_vm._v("← 返回")])
        ]),
        _c('text', { staticClass: ["detail-title"] }, [_vm._v(_vm._s(_vm.detail.data ? _vm.detail.data.title : (_vm.detail.item ? _vm.detail.item.title : '')))]),
        _c('text', { staticClass: ["detail-badge"] }, [_vm._v(_vm.detail.loading ? "加载中..." : "视频详情")])
      ]),
      _c('div', { staticClass: ["detail-body"] }, [
        _c('image', {
          staticClass: ["detail-cover"],
          attrs: { "src": _vm.detailSrc() }
        }),
        _c('div', { staticClass: ["detail-info"] }, [
          _c('text', { staticClass: ["detail-name"] }, [_vm._v(_vm._s(_vm.detail.data ? _vm.detail.data.title : (_vm.detail.item ? _vm.detail.item.title : '')))]),
          _c('text', { staticClass: ["detail-meta"] }, [_vm._v(_vm._s(_vm.detailMeta()))]),
          (_vm.detail.error) ? _c('text', { staticClass: ["detail-error"] }, [_vm._v(_vm._s(_vm.detail.error))]) : _vm._e(),
          _c('div', { staticClass: ["detail-actions"] }, [
            _c('div', { staticClass: ["detail-btn", "detail-btn-play"], on: { "click": _vm.startVideo } }, [
              _c('text', { staticClass: ["detail-btn-text"] }, [_vm._v("看视频")])
            ]),
            _c('div', { staticClass: ["detail-btn", "detail-btn-audio"], on: { "click": _vm.startAudio } }, [
              _c('text', { staticClass: ["detail-btn-text"] }, [_vm._v("听视频")])
            ]),
            _c('div', {
              staticClass: ["detail-btn", "detail-btn-dl"],
              class: [_vm.detailDownload.status === 'completed' ? 'detail-btn-dl-done' : ''],
              on: { "click": _vm.onDetailDownloadClick }
            }, [
              _c('text', {
                staticClass: ["detail-btn-text", "detail-btn-text-dl"],
                class: [_vm.detailDownload.status === 'completed' ? 'detail-btn-text-done' : '']
              }, [_vm._v(_vm.detailDownload.text || "⬇ 下载")])
            ]),
            (_vm.detailDownload.status === 'completed') ? _c('div', {
              staticClass: ["detail-btn", "detail-btn-delete"],
              on: { "click": function () { _vm.deleteDownload(_vm.detailItem() ? _vm.detailItem().bvid : ''); } }
            }, [
              _c('text', { staticClass: ["detail-btn-text", "detail-btn-text-delete"] }, [_vm._v("删除")])
            ]) : _vm._e()
          ])
        ])
      ])
    ]) : _vm._e(),

    // 全局 toast：必须放在播放页之上（详情页内部时播放页会挡住）
    (_vm.toast) ? _c('div', { staticClass: ["toast-box"] }, [
      _c('text', { staticClass: ["toast-text"] }, [_vm._v(_vm._s(_vm.toast))])
    ]) : _vm._e(),

    // 播放页：左视频 306×172 + 右详情 334×172（对齐市面版本的一屏双栏）
    (_vm.isPlaying) ? _c('div', { staticClass: ["player-panel"] }, [
      // ---------- 左：视频 + 控制条 ----------
      _c('div', { staticClass: ["play-left"] }, [
      _c('div', { staticClass: ["player-canvas-box"], on: { "click": _vm.onPlayerAreaClick } }, [
        _c('canvas', {
          ref: "aCanvas",
          attrs: { "id": "aCanvas", "canvas-id": "aCanvas", "width": "160", "height": "90" },
          style: {
            position: 'absolute',
            left: '0px',
            top: '0px',
            width: '160px',
            height: '90px'
          }
        }),
        _c('canvas', {
          ref: "vCanvas",
          attrs: {
            "id": "vCanvas",
            "canvas-id": "vCanvas",
            "width": '' + _vm.playSize.w,
            "height": '' + _vm.playSize.h
          },
          staticClass: ["player-canvas"],
          style: {
            width: _vm.playSize.w + 'px',
            height: _vm.playSize.h + 'px',
            transform: 'scale(' + (172 / (_vm.playSize.h || 180)) + ')',
            transformOrigin: 'center center'
          }
        }),
        // 加载 / 跳转 / 失败遮罩（高 148，避开底部控制条，保证控制条可点）
        (_vm.playerState === 'loading' || _vm.playerState === 'seeking' || _vm.playerState === 'error')
          ? _c('div', { staticClass: ["pl-mask"] }, [
            _c('text', { staticClass: ["pl-spin"] }, [_vm._v(_vm.spinChar())]),
            _c('text', { staticClass: ["pl-msg"] }, [_vm._v(
              _vm.playerState === 'error' ? _vm.playerErr
                : (_vm.playerState === 'seeking' ? ('跳转中 ' + _vm.fmtTime(_vm.curPos))
                  : ('加载中 ' + (_vm.streamPct >= 0 ? (_vm.streamPct + '%') : '')))
            )]),
            (_vm.streamPct >= 0 && _vm.playerState === 'loading')
              ? _c('div', { staticClass: ["pl-bar"] }, [
                _c('div', { staticClass: ["pl-bar-fill"], style: { width: _vm.streamPct + '%' } })
              ])
              : _c('div', { staticClass: ["pl-bar"] }, [
                _c('div', { staticClass: ["pl-bar-sweep"], style: { width: '34%', marginLeft: _vm.sweepPct + '%' } })
              ]),
            (_vm.playerState === 'error') ? _c('div', { staticClass: ["pl-err-btns"] }, [
              _c('div', { staticClass: ["pl-err-btn"], on: { "click": function ($event) { $event.stopPropagation(); _vm.retryNow(); } } }, [
                _c('text', { staticClass: ["pl-err-btn-text"] }, [_vm._v("重试")])
              ]),
              _c('div', { staticClass: ["pl-err-btn"], on: { "click": function ($event) { $event.stopPropagation(); _vm.stop(); } } }, [
                _c('text', { staticClass: ["pl-err-btn-text"] }, [_vm._v("返回")])
              ])
            ]) : _vm._e()
          ]) : _vm._e(),
        // 首帧封面暂停：中央大播放键（仅初始封面显示；中途暂停不显示）
        (_vm.playerState === 'ready-paused' && _vm.coverHold)
          ? _c('div', { staticClass: ["pl-bigplay"], on: { "click": _vm._onBigPlay } }, [
            _c('text', { staticClass: ["pl-bigplay-icon"] }, [_vm._v("▶")])
          ]) : _vm._e(),
        // 播放中缓冲药丸（不遮挡触控）
        (_vm.buffering && _vm.playerState === 'playing')
          ? _c('div', { staticClass: ["pl-pill"] }, [
            _c('text', { staticClass: ["pl-pill-text"] }, [_vm._v("缓冲 " + (_vm.streamPct >= 0 ? (_vm.streamPct + '%') : ''))])
          ]) : _vm._e()
      ]),
      (!_vm.audioMode && (_vm.ctrlVisible || _vm.isPaused)) ? _c('div', { staticClass: ["ctrl-bar"], on: { "click": function ($event) { $event.stopPropagation(); _vm._showCtrlBar(); } } }, [
        _c('div', { staticClass: ["ctrl-btn"], on: { "click": _vm.togglePause } }, [
          _c('text', { staticClass: ["ctrl-btn-text"] }, [_vm._v(_vm.isPaused ? "▶" : "❚❚")])
        ]),
        _c('div', { staticClass: ["ctrl-btn", "ctrl-btn-sm"], on: { "click": function () { _vm.seekRelative(-10); } } }, [
          _c('text', { staticClass: ["ctrl-btn-text"] }, [_vm._v("-10")])
        ]),
        _c('div', {
          staticClass: ["ctrl-track"],
          on: {
            "click": function ($event) { _vm.onProgressClick($event); }
          }
        }, [
          _c('div', { staticClass: ["ctrl-buf"], style: { width: (_vm.streamPct >= 0 ? _vm.streamPct : 0) + '%' } }),
          _c('div', { staticClass: ["ctrl-fill"], style: { width: Math.round((_vm.progress || 0) * 100) + '%' } })
        ]),
        _c('div', { staticClass: ["ctrl-btn", "ctrl-btn-sm"], on: { "click": function () { _vm.seekRelative(10); } } }, [
          _c('text', { staticClass: ["ctrl-btn-text"] }, [_vm._v("+10")])
        ]),
        _c('text', { staticClass: ["ctrl-time"] }, [_vm._v(_vm.fmtTime(_vm.curPos) + "/" + _vm.fmtTime(_vm.vDuration))])
      ]) : _vm._e(),
      ]),
      // ---------- 右：详情面板（详情/分P/评论/推荐 + 操作行） ----------
      _c('div', { staticClass: ["side-panel"] }, [
        _c('div', { staticClass: ["side-head"] }, [
          _c('div', { staticClass: ["side-back"], on: { "click": _vm.stop } }, [
            _c('text', { staticClass: ["side-back-text"] }, [_vm._v("‹")])
          ]),
          _c('div', { staticClass: ["side-tabs"] }, [
            _c('div', { staticClass: ["side-tab"], class: [_vm.detailTab === 'info' ? 'side-tab-active' : ''], on: { "click": function () { _vm.setDetailTab('info'); } } }, [
              _c('text', { staticClass: ["side-tab-text"] }, [_vm._v("详情")])
            ]),
            (_vm.partsList.length > 1) ? _c('div', { staticClass: ["side-tab"], class: [_vm.detailTab === 'parts' ? 'side-tab-active' : ''], on: { "click": function () { _vm.setDetailTab('parts'); } } }, [
              _c('text', { staticClass: ["side-tab-text"] }, [_vm._v("分P")])
            ]) : _vm._e(),
            _c('div', { staticClass: ["side-tab"], class: [_vm.detailTab === 'comment' ? 'side-tab-active' : ''], on: { "click": function () { _vm.setDetailTab('comment'); } } }, [
              _c('text', { staticClass: ["side-tab-text"] }, [_vm._v("评论")])
            ]),
            _c('div', { staticClass: ["side-tab"], class: [_vm.detailTab === 'related' ? 'side-tab-active' : ''], on: { "click": function () { _vm.setDetailTab('related'); } } }, [
              _c('text', { staticClass: ["side-tab-text"] }, [_vm._v("推荐")])
            ])
          ])
        ]),
        // 详情标签
        (_vm.detailTab === 'info') ? _c('div', { staticClass: ["side-body"] }, [
          _c('text', { staticClass: ["side-title"] }, [_vm._v((_vm.currentPartPage > 1 ? ("P" + _vm.currentPartPage + " · ") : "") + _vm._s(_vm.currentPartTitle || _vm.currentTitle))]),
          _c('text', { staticClass: ["side-sub"] }, [_vm._v("UP " + _vm._s((_vm.detailData() || {}).owner || '') + " · " + _vm._s(_vm.formatCount((_vm.detailData() || {}).view)) + " 播放")]),
          (!_vm.moreOpen) ? _c('text', { staticClass: ["side-desc"] }, [_vm._v(_vm.sideDesc())]) : _vm._e(),
          _c('div', { staticClass: ["act-row"] }, [
            _c('div', { staticClass: ["act-btn"], class: [_vm.likeState ? 'act-btn-on' : ''], on: { "click": _vm.doLike } }, [
              _c('text', { staticClass: ["act-btn-text"] }, [_vm._v("赞" + (_vm.likeCount ? (" " + _vm.formatCount(_vm.likeCount)) : ""))])
            ]),
            _c('div', { staticClass: ["act-btn"], class: [_vm.coinState ? 'act-btn-on' : ''], on: { "click": _vm.doCoin } }, [
              _c('text', { staticClass: ["act-btn-text"] }, [_vm._v(_vm.coinState ? "已投币" : "币")])
            ]),
            _c('div', { staticClass: ["act-btn"], class: [_vm.favState ? 'act-btn-on' : ''], on: { "click": _vm.doFav } }, [
              _c('text', { staticClass: ["act-btn-text"] }, [_vm._v(_vm.favState ? "已收藏" : "藏")])
            ]),
            _c('div', { staticClass: ["act-btn"], on: { "click": _vm.onDetailDownloadClick } }, [
              _c('text', { staticClass: ["act-btn-text"] }, [_vm._v("下载")])
            ]),
            _c('div', { staticClass: ["act-btn"], on: { "click": _vm.toggleMore } }, [
              _c('text', { staticClass: ["act-btn-text"] }, [_vm._v("更多")])
            ])
          ]),
          (_vm.moreOpen) ? _c('div', { staticClass: ["more-row"] }, [
            _c('div', { staticClass: ["more-btn"], on: { "click": _vm.doToview } }, [_c('text', { staticClass: ["more-btn-text"] }, [_vm._v("稍后再看")])]),
            _c('div', { staticClass: ["more-btn"], on: { "click": _vm.doTriple } }, [_c('text', { staticClass: ["more-btn-text"] }, [_vm._v("一键三连")])])
          ]) : _vm._e()
        ]) : _vm._e(),
        // 分P标签
        (_vm.detailTab === 'parts') ? _c('div', { staticClass: ["side-body"] }, [
          (_vm.partsList.length > 0) ? _c('scroller', { staticClass: ["side-scroller"], attrs: { "scrollDirection": "vertical" } },
            _vm._l(_vm.partsList, function (pt, i) {
              return _c('div', { staticClass: ["side-row"], on: { "click": function () { _vm.playPart(pt); } } }, [
                _c('text', { staticClass: ["side-row-text"] }, [_vm._v("P" + _vm._s(pt.page) + " · " + _vm._s(pt.part))])
              ]);
            })
          ) : _c('text', { staticClass: ["side-sub"] }, [_vm._v("加载中...")])
        ]) : _vm._e(),
        // 评论标签
        (_vm.detailTab === 'comment') ? _c('div', { staticClass: ["side-body"] }, [
          _c('div', { staticClass: ["chip-row"] }, [
            _c('div', { staticClass: ["chip"], class: [_vm.commentSort === 'hot' ? 'chip-on' : ''], on: { "click": function () { _vm.setCommentSort('hot'); } } }, [_c('text', { staticClass: ["chip-text"] }, [_vm._v("最热")])]),
            _c('div', { staticClass: ["chip"], class: [_vm.commentSort === 'new' ? 'chip-on' : ''], on: { "click": function () { _vm.setCommentSort('new'); } } }, [_c('text', { staticClass: ["chip-text"] }, [_vm._v("最新")])]),
            _c('text', { staticClass: ["side-sub"], style: { marginLeft: "6px" } }, [_vm._v(_vm._s(_vm.commentCount) + " 条")]),
            _c('div', { staticClass: ["chip", "chip-nav"], on: { "click": function () { _vm.commentPrevPage(); } } }, [_c('text', { staticClass: ["chip-nav-text"] }, [_vm._v("‹")])]),
            _c('div', { staticClass: ["chip", "chip-nav"], on: { "click": function () { _vm.commentNextPage(); } } }, [_c('text', { staticClass: ["chip-nav-text"] }, [_vm._v("›")])])
          ]),
          (_vm.comments.length > 0) ? _c('scroller', { staticClass: ["side-scroller"], attrs: { "scrollDirection": "vertical" } },
            _vm._l(_vm.comments, function (cm, i) {
              return _c('div', { key: 'cm' + i, staticClass: ["cm-row"] }, [
                _c('text', { staticClass: ["cm-name"] }, [_vm._v(_vm._s(cm.uname))]),
                _c('text', { staticClass: ["cm-text"] }, [_vm._v(_vm._s(cm.message))])
              ]);
            })
          ) : _c('text', { staticClass: ["side-sub"] }, [_vm._v("暂无评论")])
        ]) : _vm._e(),
        // 推荐标签
        (_vm.detailTab === 'related') ? _c('div', { staticClass: ["side-body"] }, [
          (_vm.relatedList.length > 0) ? _c('scroller', { staticClass: ["side-scroller"], attrs: { "scrollDirection": "vertical" } },
            _vm._l(_vm.relatedList, function (rv, i) {
              return _c('div', { key: 'rv' + i, staticClass: ["rel-row"], on: { "click": function () { _vm.playRelated(rv); } } }, [
                _c('image', { staticClass: ["rel-thumb"], attrs: { "src": _vm.thumbUrl(rv.pic_local || rv.pic) } }),
                _c('div', { staticClass: ["rel-info"] }, [
                  _c('text', { staticClass: ["rel-title"] }, [_vm._v(_vm._s(rv.title))]),
                  _c('text', { staticClass: ["rel-sub"] }, [_vm._v((rv.owner ? ('UP ' + _vm._s(rv.owner)) : '') + (rv.duration ? (' · ' + _vm.fmtTime(rv.duration)) : ''))])
                ])
              ]);
            })
          ) : _c('text', { staticClass: ["side-sub"] }, [_vm._v("加载中...")])
        ]) : _vm._e()
      ])
    ]) : _vm._e(),

    // On-screen keyboard（该机型 miniapp 原生软键盘不弹出，改为自绘键盘）
    (_vm.kbVisible) ? _c('div', { staticClass: ["kb-panel"] }, [
      _c('div', { staticClass: ["kb-top"] }, [
        _c('text', { staticClass: ["kb-preview"] }, [_vm._v((_vm.searchInput || '') + '|')]),
        _c('div', { staticClass: ["kb-top-btn"], on: { "click": _vm.closeKeyboard } }, [
          _c('text', { staticClass: ["kb-top-btn-text"] }, [_vm._v("收起")])
        ]),
        _c('div', { staticClass: ["kb-top-btn", "kb-top-btn-go"], on: { "click": _vm.kbSearch } }, [
          _c('text', { staticClass: ["kb-top-btn-text"] }, [_vm._v("搜索")])
        ])
      ]),
      _vm._l(_vm.kbRows, function (row, ri) {
        return _c('div', { key: 'kbrow' + ri, staticClass: ["kb-row"] }, _vm._l(row, function (k, ki) {
          return _c('div', {
            key: 'kb' + ri + '_' + ki,
            staticClass: ["kb-key"],
            on: { "click": function () { _vm.kbType(k); } }
          }, [
            _c('text', { staticClass: ["kb-key-text"] }, [_vm._v(k)])
          ]);
        }));
      })
    ]) : _vm._e()
  ]);
};

var staticRenderFns = [];
render._withStripped = true;

const __file = 'src/pages/index/index.vue';
const _scopeId = 'data-v-9002000869905604';

const _exports = script;
_exports.render = render;
_exports.staticRenderFns = staticRenderFns;
_exports._compiled = true;
_exports._scopeId = _scopeId;
_exports.themes = {};
_exports.style = Object.assign({}, style_0['_']);
_exports.__file = __file;

var _index = _exports;

App$1.meta = {
  "pages": {
    "index": "pages/index/index.vue"
  },
  "options": {
    "style": {
      "lessPaths": [
        "styles"
      ]
    }
  }
};
App$1.meta.name = '笔上哔哩';
App$1.meta.version = '2.4.1';
App$1.meta.isSingleJsBundle = false;
$falcon.__AppClazz = App$1;
$falcon.__loadModuleDefault = async function (fileName) {
  if (App$1.__pages && App$1.__pages[fileName]) {
    return App$1.__pages[fileName];
  } else {
    try {
      const pagePath = './' + fileName + '.js';
      let mod = await import(pagePath);
      return mod.default;
    } catch(e) {
      console.log(e.message, e.stack);
    }
  }
};
App$1.__pages = {};
App$1.__pages['index'] = _index;
