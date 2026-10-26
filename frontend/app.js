import http from 'http';
import nekolib from 'nekolib';
import softvplayer from 'softvplayer';

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
      currentTab: 'feed', // 'feed' | 'search' | 'login'
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
      cropMode: false,
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
        this.refreshQr();
      }, 1000);
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
    switchTab(tab) {
      if (this.isPlaying) {
        this.stop();
      }
      this.currentView = 'home';
      this.detail = null;
      this.currentTab = tab;
      if (tab === 'login') {
        if (!this.isLoggedIn) {
          this.refreshQr();
        } else {
          this.fetchUserInfo();
        }
      } else if (tab === 'history') {
        this.fetchHistory();
      } else if (tab === 'download') {
        this.fetchDownloads();
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
        if (data && data.logged_in) {
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
      if (this.loadingFeed) return;
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
      if (ok) return;
      if (attempt < 4) {
        // 装机后 app 可能先于 daemon 启动，这里自动重试几次，避免首页永久空白。
        this.$page.setTimeout(() => this.fetchFeed(attempt + 1), 1200);
      } else {
        this.statusText = '推荐加载失败，点击换一换';
      }
    },
    async doSearch(kw) {
      if (!kw || this.loadingSearch) return;
      this.searchInput = kw;
      this.loadingSearch = true;
      this.statusText = '搜索: ' + kw + '...';
      try {
        const res = await this.requestWithRetry({
          url: 'http://127.0.0.1:18080/api/search?keyword=' + encodeURIComponent(kw),
          method: 'GET',
          timeout: 10000
        });
        const data = safeJson(res.body, []);
        const list = Array.isArray(data) ? data : [];
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
      if (!kw || this.loadingSearch) return;
      this.doSearch(kw);
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
    togglePause() {
      if (!this.isPlaying || this.isStopping) return;
      this.isPaused = !this.isPaused;
      if (this.isPaused) {
        // 暂停：视频解码线程原地等待 + 音频设备暂停，两边内容时间都不再推进。
        try { if (this.rgav && typeof this.rgav.pause === 'function') this.rgav.pause(); } catch (e) {}
        try { if (this.audioPlayer && typeof this.audioPlayer.pause === 'function') this.audioPlayer.pause(); } catch (e) {}
        try { if (this.vPlayer && typeof this.vPlayer.pause === 'function') this.vPlayer.pause(); } catch (e) {}
        this.statusText = '已暂停';
        console.warn('[Player] paused');
      } else {
        try { if (this.rgav && typeof this.rgav.unpause === 'function') this.rgav.unpause(); } catch (e) {}
        try { if (this.audioPlayer && typeof this.audioPlayer.resume === 'function') this.audioPlayer.resume(); } catch (e) {}
        try { if (this.vPlayer && typeof this.vPlayer.resume === 'function') this.vPlayer.resume(); } catch (e) {}
        this.statusText = '';
        console.warn('[Player] resumed');
      }
    },
    _updateProgress() {
      if (!this.isPlaying || this.audioMode) return;
      const now = Date.now();
      if (now - (this._progAt || 0) < 400) return;
      this._progAt = now;
      const pos = this._lastPos || 0;
      const dur = this.vDuration || 0;
      if (pos > 0 && Math.abs(pos - (this.curPos || 0)) >= 0.2) this.curPos = pos;
      if (dur > 0) this.progress = Math.min(1, Math.max(0, pos / dur));
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
      if (!item || !item.bvid) return;
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
    fitOutput(sw, sh) {
      const w = Math.max(1, Number(sw) || 640);
      const h = Math.max(1, Number(sh) || 360);
      const s = Math.min(320 / w, 180 / h, 1);
      const even = (v) => Math.max(2, Math.round(v / 2) * 2);
      return { w: even(w * s), h: even(h * s) };
    },
    toggleCrop() {
      this.cropMode = !this.cropMode;
      console.warn('[Player] cropMode=' + this.cropMode);
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
      const s = Math.min(640 / sw, 360 / sh, 1);
      const even = (v) => Math.max(2, Math.round(v / 2) * 2);
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
      this.recordHistory(item);
      this.srcSize = { w: Number(dim.width) || 640, h: Number(dim.height) || 360 };
      this.playSize = dec;
      this.vDuration = 0;
      this.statusText = '准备播放...';
      this.isPlaying = true;
      this.isStopping = false;
      this._startKeepScreen();
      this._frames = 0;
      this._drawMs = 0;
      this._perfAt = Date.now();
      this._lastCb = 0;
      this._maxGap = 0;
      this._audioRetry = 0;
      this._lastNativeRead = 0;
      this._syncDone = false;
      this._lastPos = 0;
      this._audioPos = 0;
      this._audioPosAt = 0;
      this._audioUnit = 0;
      this._lastAdjustAt = 0;
      this._resumeAt = 0;
      this._latePrimeAt = 0;
      this._latePrimeDone = false;
      this._primeCheckAt = 0;
      this._driftEwma = 0;
      this._syncSampleCount = 0;
      this.isPaused = false;
      this.curPos = 0;
      this.progress = 0;
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
        this.rgav.setBuffer(this.imageData.data.buffer, dec.w, dec.h);
        this.rgav.start('http://127.0.0.1:18080/api/stream?bvid=' + item.bvid);
        console.warn('[Rga] video started');
        // 关键：等视频首帧解码就绪（primed）后再启动音频。
        // 部分视频首帧 open+probe 要 1~2s，若音频先起播，视频内容 0 点会被推后 → 音频超前。
        this._waitPrimedThenAudio(gen, item);
        if (this._vidTimer) this.$page.clearInterval(this._vidTimer);
        this._vidTimer = this.$page.setInterval(() => {
          if (gen !== this.playGen) return;
          this._nativeTick(gen, ctx);
        }, 16);
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
        // 渲染上限 30fps（与 B 站 30fps 视频流一致）。低于内容帧率会让视频内容时间持续落后，
        // 表现为音频越来越超前；native 侧另有「落后 80ms 丢帧追帧」兜底。
        if (now - (this._lastNativeRead || 0) < 33) return;
        this._lastNativeRead = now;
        this._infoAt = this._infoAt || 0;
        const t0 = now;
        const got = this.rgav.readFrame();
        if (got) {
          ctx.putImageData(this.imageData, 0, 0);
          this._drawMs += (Date.now() - t0);
          this._frames++;
          const now = Date.now();
          if (this._lastCb) {
            const gap = now - this._lastCb;
            if (gap > (this._maxGap || 0)) this._maxGap = gap;
          }
          this._lastCb = now;
          if (now - this._perfAt >= 2000) {
            const sec = (now - this._perfAt) / 1000;
            const fps = Math.round(this._frames / sec);
            const avg = this._frames > 0 ? Math.round(this._drawMs / this._frames) : 0;
            console.warn('[Perf] native draws/s=' + fps + ' avg=' + avg + 'ms maxgap=' + (this._maxGap || 0) + ' pos=' + (this._lastPos || 0).toFixed(1) + ' apos=' + (this._audioPos || 0).toFixed(1) + ' out=' + this.playSize.w + 'x' + this.playSize.h);
            this._frames = 0;
            this._drawMs = 0;
            this._maxGap = 0;
            this._perfAt = now;
          }
        }
        // 每帧只取 position 数值（不创建 JS 对象）；info() 降到 ~0.8s 一次，
        // 减少 QuickJS 堆分配与 GC 抖动（这是主线程偶发卡顿的来源之一）。
        try {
          const pos = this.rgav.position();
          if (pos > 0) this._lastPos = pos;
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
                  this.rgav.adjust(D);
                  console.warn('[Sync] late-prime adjust D=' + D.toFixed(2));
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
            if (info.duration > 0 && Math.abs(info.duration - this.vDuration) > 1) this.vDuration = info.duration;
            if (info.finished) {
              console.warn('[Rga] finished');
              this.stop();
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
                const audioNow = this._audioPos + audioElapsed;
                const videoNow = info.position;
                const rawDrift = audioNow - videoNow; // >0 视频落后需跳帧；<0 视频超前需等待

                // 异常硬偏差保护：若偏差超过 2s（如弱网断流或起播未对齐），重置滤波并暂停盲调，避免死循环减速
                if (Math.abs(rawDrift) > 2.0) {
                  this._driftEwma = 0;
                  this._syncSampleCount = 0;
                } else {
                  // EWMA 低通滤波平滑单核调度偶发抖动
                  if (this._driftEwma === 0 || this._driftEwma === undefined) {
                    this._driftEwma = rawDrift;
                  } else {
                    this._driftEwma = this._driftEwma * 0.65 + rawDrift * 0.35;
                  }
                  this._syncSampleCount = (this._syncSampleCount || 0) + 1;

                  // 至少累积 3 次采样（约 1.5s）后再做决策，防止起播偶发瞬态误调
                  if (this._syncSampleCount >= 3) {
                    const absDrift = Math.abs(this._driftEwma);
                    // 40ms 死区过滤（人类视听感知极限约为 ±45ms，死区内完全不干预，保持画面丝滑）
                    if (absDrift > 0.045) {
                      const elapsedSinceAdjust = now - (this._lastAdjustAt || 0);
                      // 冷却时间限制（>= 1500ms），避免过于频繁校准
                      if (elapsedSinceAdjust >= 1500) {
                        let delta = this._driftEwma;
                        // 步长截断：单次最大校正 ±0.35s，避免大跳变
                        if (delta > 0.35) delta = 0.35;
                        if (delta < -0.35) delta = -0.35;

                        try {
                          this.rgav.adjust(delta);
                          console.warn('[Sync] dynamic adjust: drift=' + rawDrift.toFixed(3) + 's ewma=' + this._driftEwma.toFixed(3) + 's adj=' + delta.toFixed(3) + 's');
                          this._lastAdjustAt = now;
                          this._driftEwma = 0; // 重置滤波累计
                        } catch (e) {
                          console.warn('[Sync] adjust error: ' + e);
                        }
                      }
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
            this._syncResume(gen, 'fallback-timeout');
          }, 3000);
          return;
        }
        this.$page.setTimeout(tryStart, 100);
      };
      this.$page.setTimeout(tryStart, 80);
    },
    _startNativeAudio(gen, item) {
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
            let a = Number(p) || 0;
            const vpos = this._lastPos || 0;
            if (!this._audioUnit && a > 0) {
              // 自动识别单位：秒 or 毫秒（取与视频位置更接近的换算）。
              this._audioUnit = (Math.abs(a - vpos) <= Math.abs(a / 1000 - vpos)) ? 1 : 1000;
            }
            if (this._audioUnit === 1000) a = a / 1000;
            this._audioPos = a;
            this._audioPosAt = Date.now();

            // ★ 精准对齐起播：以首个实际音频播放位置直接放行视频，消除起播 1~2s 盲猜误差
            if (!this._syncDone && a > 0) {
              if (this._infoResumeTimer) { this.$page.clearTimeout(this._infoResumeTimer); this._infoResumeTimer = null; }
              this._syncResume(gen, 'audio-pos', a);
            }
          });
          bind('onInfo', () => {
            // 兜底保护：若 1800ms 内未收到 onPosition，通过 onInfo 兜底放行避免挂起
            if (this._infoResumeTimer) this.$page.clearTimeout(this._infoResumeTimer);
            this._infoResumeTimer = this.$page.setTimeout(() => {
              if (!this._syncDone) {
                this._syncResume(gen, 'audio-info-fallback', 0.5);
              }
            }, 1800);
          });
          ap.start('http://127.0.0.1:18080/api/audio?bvid=' + item.bvid + '&variant=remux');
          console.warn('[Rga] audio started, pause=' + (typeof ap.pause));
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
    _syncResume(gen, why, offset) {
      if (gen !== this.playGen || this._syncDone || this.isStopping) return;
      this._syncDone = true;
      try {
        if (this._syncTimer) { this.$page.clearTimeout(this._syncTimer); this._syncTimer = null; }
        if (this._infoResumeTimer) { this.$page.clearTimeout(this._infoResumeTimer); this._infoResumeTimer = null; }
        const off = Number(offset) || 0;
        this._resumeAt = Date.now();
        if (this.rgav && typeof this.rgav.resume === 'function') this.rgav.resume(off);
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
      try {
        if (this._vidTimer) {
          this.$page.clearInterval(this._vidTimer);
          this._vidTimer = null;
        }
      } catch (e) {}
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
      this._syncDone = false;
      this._driftEwma = 0;
      this._syncSampleCount = 0;
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
        if (data && data.qrcode_key && data.qr_path) {
          this.loginQrKey = data.qrcode_key;
          this.loginQrPath = data.qr_path;
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
          if (st && st.logged_in) {
            this.loginStatusText = '登录成功！';
            if (this.pollTimerToken) this.$page.clearInterval(this.pollTimerToken);
            this.fetchUserInfo();
          } else if (st && st.message) {
            this.loginStatusText = st.message;
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
        this.audioMode = false;
        this.currentTitle = '';
        this.currentBvid = '';
        this.isStopping = false;
        this.statusText = '播放已退出';
      }, 300);
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
    "width": "95px",
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
    "width": "545px",
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
  "video-card": {
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
  "player-panel": {
    "position": "absolute",
    "left": "0px",
    "top": "0px",
    "width": "640px",
    "height": "172px",
    "backgroundColor": "#000000",
    "zIndex": 99
  },
  "player-canvas-box": {
    "position": "absolute",
    "left": "0px",
    "top": "0px",
    "width": "640px",
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
    "height": "6px",
    "marginLeft": "8px",
    "backgroundColor": "rgba(255,255,255,0.25)",
    "borderRadius": "3px"
  },
  "pp-fill": {
    "height": "6px",
    "backgroundColor": "#fb7299",
    "borderRadius": "3px"
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
    "left": "150px",
    "top": "132px",
    "width": "340px",
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
      _c('div', { staticClass: ["brand-box"] }, [
        _c('div', { staticClass: ["brand-badge"] }, [
          _c('text', { staticClass: ["brand-badge-text"] }, [_vm._v("B站")])
        ]),
        _c('text', { staticClass: ["brand-title"] }, [_vm._v("笔上哔哩")])
      ]),
      _c('div', { staticClass: ["nav-list"] }, [
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
      // Top Banner
        (_vm.currentTab === 'feed') ? _c('div', { staticClass: ["banner"] }, [
          _c('text', { staticClass: ["banner-text"] }, [_vm._v(_vm.statusText ? ("推荐 · " + _vm.statusText) : "热门推荐 · 点击卡片查看详情")]),
          _c('div', {
            staticClass: ["btn-change"],
            on: { "click": _vm.fetchFeed }
          }, [
            _c('text', { staticClass: ["btn-change-text"] }, [_vm._v("换一换")])
          ])
        ]) : (_vm.currentTab === 'search') ? _c('div', { staticClass: ["banner", "search-banner"] }, [
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
        ]) : (_vm.currentTab === 'history') ? _c('div', { staticClass: ["banner"] }, [
          _c('text', { staticClass: ["banner-text"] }, [_vm._v("观看历史 · " + _vm._s(_vm.history.length) + " 条")]),
          _c('div', { staticClass: ["btn-change"], on: { "click": _vm.clearHistory } }, [
            _c('text', { staticClass: ["btn-change-text"] }, [_vm._v("清空")])
          ])
        ]) : (_vm.currentTab === 'download') ? _c('div', { staticClass: ["banner"] }, [
          _c('text', { staticClass: ["banner-text"] }, [_vm._v("离线下载 · " + _vm._s(_vm.downloads.length) + " 部" + (_vm.downloadFreeText ? (" · 剩余空间 " + _vm.downloadFreeText) : ""))]),
          _c('div', { staticClass: ["btn-change"], on: { "click": _vm.fetchDownloads } }, [
            _c('text', { staticClass: ["btn-change-text"] }, [_vm._v("刷新")])
          ])
        ]) : _c('div', { staticClass: ["banner"] }, [
          _c('text', { staticClass: ["banner-text"] }, [_vm._v("哔哩哔哩账号中心")])
        ]),

        // Tab 1: Feed
        (_vm.currentTab === 'feed') ? _c('scroller', {
          staticClass: ["card-scroller"],
          attrs: { "scrollDirection": "horizontal" }
        }, _vm._l(_vm.videos, function (item, index) {
          return _c('div', {
            key: item.bvid,
            staticClass: ["video-card"],
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

        // Tab: History（观看历史）
        (_vm.currentTab === 'history') ? (_vm.history.length > 0 ? _c('scroller', {
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
        (_vm.currentTab === 'download') ? (_vm.downloads.length > 0 ? _c('scroller', {
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
        (_vm.currentTab === 'search') ? _c('scroller', {
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
      ]),
      (_vm.toast) ? _c('div', { staticClass: ["toast-box"] }, [
        _c('text', { staticClass: ["toast-text"] }, [_vm._v(_vm._s(_vm.toast))])
      ]) : _vm._e()
    ]) : _vm._e(),

    // Fullscreen Player Overlay (active when isPlaying is true)
    (_vm.isPlaying) ? _c('div', { staticClass: ["player-panel"] }, [
      _c('div', { staticClass: ["player-canvas-box"], on: { "click": _vm.togglePause } }, [
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
            transform: _vm.cropMode ? 'scale(1)' : ('scale(' + (172 / (_vm.playSize.h || 180)) + ')'),
            transformOrigin: 'center center'
          }
        })
      ]),
      (!_vm.audioMode) ? _c('div', { staticClass: ["player-progress"] }, [
        _c('text', { staticClass: ["pp-time"] }, [_vm._v(_vm.fmtTime(_vm.curPos) + ' / ' + _vm.fmtTime(_vm.vDuration))]),
        _c('div', { staticClass: ["pp-bar"] }, [
          _c('div', { staticClass: ["pp-fill"], style: { width: Math.round((_vm.progress || 0) * 100) + '%' } })
        ]),
        _c('div', { staticClass: ["pp-btn"], on: { "click": _vm.togglePause } }, [
          _c('text', { staticClass: ["pp-btn-text"] }, [_vm._v(_vm.isPaused ? "▶" : "❚❚")])
        ])
      ]) : _vm._e(),
      (_vm.audioMode) ? _c('div', { staticClass: ["audio-ui"] }, [
        _c('image', { staticClass: ["audio-cover"], attrs: { "src": _vm.detailSrc() } }),
        _c('div', { staticClass: ["audio-info"] }, [
          _c('text', { staticClass: ["audio-tag"] }, [_vm._v("高音质 · 音频模式")]),
          _c('text', { staticClass: ["audio-title"] }, [_vm._v(_vm._s(_vm.currentTitle))]),
          _c('text', { staticClass: ["audio-tip"] }, [_vm._v("仅播放该视频音频，无视频画面")])
        ])
      ]) : _vm._e(),
      _c('div', { staticClass: ["player-header"] }, [
        _c('text', { staticClass: ["banner-text"], style: { maxWidth: '420px' } }, [_vm._v((_vm.audioMode ? "[音频] " : "[视频] ") + _vm._s(_vm.currentTitle))]),
        _c('div', { staticClass: ["player-actions"] }, [
          _c('div', {
            staticClass: ["btn-exit"],
            style: { backgroundColor: "#282b33", marginRight: "8px" },
            on: { "click": _vm.toggleCrop }
          }, [
            _c('text', { staticClass: ["btn-exit-text"] }, [_vm._v(_vm.cropMode ? "铺满" : "适应")])
          ]),
          _c('div', {
            staticClass: ["btn-exit"],
            on: { "click": _vm.stop }
          }, [
            _c('text', { staticClass: ["btn-exit-text"] }, [_vm._v("✕ 退出播放")])
          ])
        ])
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
