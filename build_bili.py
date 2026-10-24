#!/usr/bin/env python3
import os
import json
import hashlib
import zipfile
import shutil
import subprocess

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PKG_DIR = os.path.join(BASE_DIR, "bili_pkg")
OUTPUT_AMR = os.path.join(BASE_DIR, "9002000869905604.amr")


def build_daemon():
    """存在 Go 工具链时自动重新编译守护进程，避免打进包的是旧二进制。"""
    go = shutil.which("go")
    if not go:
        print("[Warn] 未找到 go，使用现有 bili_src/bili-daemon")
        return
    src_dir = os.path.join(BASE_DIR, "bili_src")
    out = os.path.join(src_dir, "bili-daemon")
    env = dict(os.environ)
    env.update({"GOOS": "linux", "GOARCH": "arm", "GOARM": "7", "CGO_ENABLED": "0"})
    cmd = [go, "build", "-trimpath", "-ldflags", "-s -w -buildid=", "-o", out, "main.go"]
    subprocess.run(cmd, cwd=src_dir, env=env, check=True)
    print("[Build] bili-daemon = %d bytes" % os.path.getsize(out))


build_daemon()

# 1. Clean & prepare directory
os.makedirs(os.path.join(PKG_DIR, "libs", "arm"), exist_ok=True)

# 2. Copy compiled binary & libraries
src_daemon = os.path.join(BASE_DIR, "bili_src", "bili-daemon")
dst_daemon = os.path.join(PKG_DIR, "libs", "arm", "bili-daemon")
shutil.copy2(src_daemon, dst_daemon)

src_nekolib = os.path.join(BASE_DIR, "libjsapi_nekolib.so")
dst_nekolib = os.path.join(PKG_DIR, "libs", "arm", "libjsapi_nekolib.so")
shutil.copy2(src_nekolib, dst_nekolib)

src_softvideo = os.path.join(BASE_DIR, "libjsapi_softvideo.so")
dst_softvideo = os.path.join(PKG_DIR, "libs", "arm", "libjsapi_softvideo.so")
shutil.copy2(src_softvideo, dst_softvideo)

src_rgav = os.path.join(BASE_DIR, "libjsapi_rgavideo.so")
if os.path.exists(src_rgav):
    shutil.copy2(src_rgav, os.path.join(PKG_DIR, "libs", "arm", "libjsapi_rgavideo.so"))

src_icon = os.path.join(BASE_DIR, "app_icon.png")
dst_icon = os.path.join(PKG_DIR, "app_icon.png")
shutil.copy2(src_icon, dst_icon)

# 3. Create app.js
app_js_content = r'''import http from 'http';
import nekolib from 'nekolib';
import softvplayer from 'softvplayer';

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
      // Player
      playSize: { w: 640, h: 360 },
      srcSize: { w: 640, h: 360 },
      cropMode: false,
      vDuration: 0,
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
    this.bootstrapDaemon();
    this.testSoftVideo();
    this.syncDaemonState();
    this.loadNativeVideo();
  },
  onShow() {
    console.warn('[Lifecycle] vm onShow');
  },
  onHide() {
    // 系统手势回到桌面时页面进入后台：必须立即停播放，否则音频会继续输出并残留到下一次播放。
    console.warn('[Lifecycle] vm onHide, stop playback');
    try { this.stop(); } catch (e) {}
  },
  onUnload() {
    console.warn('[Lifecycle] vm onUnload, stop playback');
    try { this.stop(); } catch (e) {}
  },
  methods: {
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
              const v = typeof res.body === 'string' ? JSON.parse(res.body || '{}') : res.body;
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
      }
    },
    async fetchUserInfo() {
      try {
        const res = await http.request({
          url: 'http://127.0.0.1:18080/api/user/info',
          method: 'GET',
          timeout: 4000
        });
        const data = typeof res.body === 'string' ? JSON.parse(res.body || '{}') : res.body;
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
        const res = await http.request({
          url: 'http://127.0.0.1:18080/api/feed',
          method: 'GET',
          timeout: 12000
        });
        const list = typeof res.body === 'string' ? JSON.parse(res.body || '[]') : res.body;
        if (Array.isArray(list) && list.length > 0) {
          this.videos = list;
          this.statusText = '推荐就绪 (' + list.length + '条)';
          ok = true;
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
        const res = await http.request({
          url: 'http://127.0.0.1:18080/api/search?keyword=' + encodeURIComponent(kw),
          method: 'GET',
          timeout: 8000
        });
        const list = typeof res.body === 'string' ? JSON.parse(res.body || '[]') : res.body;
        if (Array.isArray(list) && list.length > 0) {
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
    openKeyboard() {
      this.kbVisible = true;
      console.warn('[Kb] open');
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
    formatCount(n) {
      const v = Number(n) || 0;
      if (v >= 100000000) return (v / 100000000).toFixed(1) + '亿';
      if (v >= 10000) return (v / 10000).toFixed(1) + '万';
      return String(v);
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
      this.statusText = '加载视频详情...';
      console.warn('[Detail] open ' + item.bvid);
      try {
        const res = await http.request({
          url: 'http://127.0.0.1:18080/api/detail?bvid=' + item.bvid,
          method: 'GET',
          timeout: 6000
        });
        const data = typeof res.body === 'string' ? JSON.parse(res.body || '{}') : res.body;
        if (!data || !data.title) throw new Error('empty detail response');
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
      this.srcSize = { w: Number(dim.width) || 640, h: Number(dim.height) || 360 };
      this.playSize = dec;
      this.vDuration = 0;
      this.statusText = '准备播放...';
      this.isPlaying = true;
      this.isStopping = false;
      this._frames = 0;
      this._drawMs = 0;
      this._perfAt = Date.now();
      this._lastCb = 0;
      this._maxGap = 0;
      this._audioRetry = 0;
      this._lastNativeRead = 0;
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
        this._startNativeAudio(gen, item);
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
        // 降渲染负载：24fps 上限，同时减少 readFrame 的 921KB 内存拷贝次数。
        if (now - (this._lastNativeRead || 0) < 41) return;
        this._lastNativeRead = now;
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
            console.warn('[Perf] native draws/s=' + fps + ' avg=' + avg + 'ms maxgap=' + (this._maxGap || 0) + ' out=' + this.playSize.w + 'x' + this.playSize.h);
            this._frames = 0;
            this._drawMs = 0;
            this._maxGap = 0;
            this._perfAt = now;
          }
        }
        const info = this.rgav.info();
        if (info) {
          if (info.duration > 0 && Math.abs(info.duration - this.vDuration) > 1) this.vDuration = info.duration;
          if (info.finished) {
            console.warn('[Rga] finished');
            this.stop();
          }
        }
      } catch (e) {
        console.warn('[Rga] tick error: ' + e);
      }
    },
    _startNativeAudio(gen, item) {
      // 先彻底释放上一路音频：softvideo 的 stop 会 closeAudioDevice，需要时间让 ALSA 回收。
      // 连续起播时如果马上新建播放器，会出现两路音频抢设备 → 爆音/吱吱声。
      this._stopAudioOnly();
      const elapsed = this._audioStoppedAt ? (Date.now() - this._audioStoppedAt) : 1e9;
      const wait = Math.max(0, 500 - elapsed);
      this.$page.setTimeout(() => {
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
          ap.start('http://127.0.0.1:18080/api/audio?bvid=' + item.bvid + '&variant=remux');
          console.warn('[Rga] audio started, pause=' + (typeof ap.pause));
        } catch (e) {
          console.warn('[Rga] audio init error: ' + e);
        }
      }, wait);
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
      try {
        if (this._vidTimer) {
          this.$page.clearInterval(this._vidTimer);
          this._vidTimer = null;
        }
      } catch (e) {}
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
        const data = typeof res.body === 'string' ? JSON.parse(res.body || '{}') : res.body;
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
          const st = typeof res.body === 'string' ? JSON.parse(res.body || '{}') : res.body;
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
      // 先让 daemon 取消音频/视频流：解码线程才能尽快退出，否则 stop() 会等网络读超时，声音拖尾约 1s。
      try {
        http.request({
          url: 'http://127.0.0.1:18080/api/stop',
          method: 'GET',
          timeout: 500
        }).catch(() => {});
      } catch (e) {}
      this._stopNative();
      const gen = this.playGen || 0;
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
    "height": "25px",
    "borderRadius": "4px",
    "justifyContent": "center",
    "alignItems": "center",
    "marginBottom": "4px",
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
  "btn-stop": {
    "backgroundColor": "#22252c",
    "borderRadius": "4px",
    "height": "24px",
    "justifyContent": "center",
    "alignItems": "center"
  },
  "btn-stop-text": {
    "color": "#ff5555",
    "fontSize": "10px"
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
      ]),
      _c('div', {
        staticClass: ["btn-stop"],
        on: { "click": _vm.stop }
      }, [
        _c('text', { staticClass: ["btn-stop-text"] }, [_vm._v("停止播放")])
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
            _c('text', { staticClass: ["btn-change-text"] }, [_vm._v("换一换 🔄")])
          ])
        ]) : (_vm.currentTab === 'search') ? _c('div', { staticClass: ["banner", "search-banner"] }, [
          _c('div', { staticClass: ["search-input"], on: { "click": _vm.openKeyboard } }, [
            _c('text', {
              staticClass: ["search-input-text"],
              class: [_vm.searchInput ? '' : 'search-input-placeholder']
            }, [_vm._v(_vm.searchInput || '点此输入关键词')])
          ]),
          _c('text', { staticClass: ["search-count"] }, [_vm._v(_vm._s(_vm.searchResults.length) + " 条")]),
          _c('div', { staticClass: ["btn-search"], on: { "click": _vm.submitSearch } }, [
            _c('text', { staticClass: ["btn-search-text"] }, [_vm._v("搜索")])
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
          ])
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
              _c('text', { staticClass: ["detail-btn-text"] }, [_vm._v("▶ 看视频")])
            ]),
            _c('div', { staticClass: ["detail-btn", "detail-btn-audio"], on: { "click": _vm.startAudio } }, [
              _c('text', { staticClass: ["detail-btn-text"] }, [_vm._v("🎧 听视频")])
            ]),
            _c('div', {
              staticClass: ["detail-btn", "detail-btn-dl"],
              on: { "click": function () { _vm.showToast('下载功能占位，暂未开放'); } }
            }, [
              _c('text', { staticClass: ["detail-btn-text", "detail-btn-text-dl"] }, [_vm._v("⬇ 下载")])
            ])
          ])
        ])
      ]),
      (_vm.toast) ? _c('div', { staticClass: ["toast-box"] }, [
        _c('text', { staticClass: ["toast-text"] }, [_vm._v(_vm._s(_vm.toast))])
      ]) : _vm._e()
    ]) : _vm._e(),

    // Fullscreen Player Overlay (active when isPlaying is true)
    (_vm.isPlaying) ? _c('div', { staticClass: ["player-panel"] }, [
      _c('div', { staticClass: ["player-canvas-box"] }, [
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
      (_vm.audioMode) ? _c('div', { staticClass: ["audio-ui"] }, [
        _c('image', { staticClass: ["audio-cover"], attrs: { "src": _vm.detailSrc() } }),
        _c('div', { staticClass: ["audio-info"] }, [
          _c('text', { staticClass: ["audio-tag"] }, [_vm._v("高音质 · 音频模式")]),
          _c('text', { staticClass: ["audio-title"] }, [_vm._v(_vm._s(_vm.currentTitle))]),
          _c('text', { staticClass: ["audio-tip"] }, [_vm._v("仅播放该视频音频，无视频画面")])
        ])
      ]) : _vm._e(),
      _c('div', { staticClass: ["player-header"] }, [
        _c('text', { staticClass: ["banner-text"], style: { maxWidth: '420px' } }, [_vm._v((_vm.audioMode ? "🎧 " : "▶ ") + _vm._s(_vm.currentTitle))]),
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
App$1.meta.version = '2.2.1';
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
''';

with open(os.path.join(PKG_DIR, "app.js"), "w", encoding="utf-8") as f:
    f.write(app_js_content)

# 4. Manifest template
manifest = {
    "appName": "笔上哔哩",
    "version": "2.2.1",
    "appid": "9002000869905604",
    "icon": "app_icon.png",
    "quickjs": {
        "version": "20200705",
        "bigNum": False
    },
    "props": {
        "addDesktop": {
            "y09_platform": True
        },
        "supportUnInstall": True,
        "supportCleanUp": True
    },
    "cert": {}
}

# 5. Calculate cert (size & md5) for all files except manifest.json
def get_file_info(filepath):
    with open(filepath, 'rb') as f:
        data = f.read()
        return len(data), hashlib.md5(data).hexdigest()

for root, dirs, files in os.walk(PKG_DIR):
    for file in files:
        if file == "manifest.json":
            continue
        full_path = os.path.join(root, file)
        rel_path = os.path.relpath(full_path, PKG_DIR).replace("\\", "/")
        size, md5_val = get_file_info(full_path)
        manifest["cert"][rel_path] = {
            "size": size,
            "md5": md5_val
        }

manifest_path = os.path.join(PKG_DIR, "manifest.json")
with open(manifest_path, 'w', encoding='utf-8') as f:
    json.dump(manifest, f, indent=2, ensure_ascii=False)

# 6. Create ZIP (AMR)
with zipfile.ZipFile(OUTPUT_AMR, 'w', zipfile.ZIP_DEFLATED) as z:
    for root, dirs, files in os.walk(PKG_DIR):
        for file in files:
            full_path = os.path.join(root, file)
            rel_path = os.path.relpath(full_path, PKG_DIR).replace('\\', '/')
            zinfo = zipfile.ZipInfo(rel_path)
            zinfo.compress_type = zipfile.ZIP_DEFLATED
            if file == "bili-daemon" or file.endswith(".sh") or file.endswith(".so"):
                zinfo.external_attr = (0o755 << 16) | 0o100000
            else:
                zinfo.external_attr = (0o644 << 16) | 0o100000
            with open(full_path, 'rb') as f_in:
                z.writestr(zinfo, f_in.read())

print(f"[Build Success] AMR Archive created at: {OUTPUT_AMR} ({os.path.getsize(OUTPUT_AMR)} bytes)")
