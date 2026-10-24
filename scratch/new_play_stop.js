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
      const out = opts.out || (this.audioMode ? { w: 160, h: 90 } : this.fitOutput(src.w, src.h));
      this.playSize = out;
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
          if (iw !== this.srcSize.w || ih !== this.srcSize.h) {
            console.warn("[SoftVPlayer] source size mismatch: " + iw + "x" + ih + " vs " + this.srcSize.w + "x" + this.srcSize.h);
            this._retryWithSize(iw, ih);
          }
        });

        bindSignal('onDrawFrame', () => {
          if (gen !== this.playGen || this.isStopping) return;
          this._signalSeen = true;
          if (!this.imageData || !ctx || typeof ctx.putImageData !== 'function') return;
          const now = Date.now();
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
            console.warn("[Perf] draws/s=" + fps + " avg=" + avg + "ms out=" + this.playSize.w + "x" + this.playSize.h);
            this._frames = 0;
            this._drawMs = 0;
            this._perfAt = now;
          }
        });

        bindSignal('onComplete', () => {
          if (gen !== this.playGen) return;
          console.warn("[SoftVPlayer] Video complete");
          if (!this.isStopping) this.stop();
        });

        bindSignal('onError', (code) => {
          if (gen !== this.playGen) return;
          console.warn("[SoftVPlayer] Error:", code);
          this._audioFailed = true;
          if (this.audioMode && !this._remuxTried) {
            this._startAudioRemux(item);
            return;
          }
          this.statusText = '播放出错: ' + code;
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
      this.stop();
      this.$page.setTimeout(() => {
        const next = Object.assign({}, opts, { src: { w: w, h: h }, out: { w: w, h: h }, sizeRetried: true });
        this.play(item, next);
      }, 400);
    },

    async stop() {
      if (this.isStopping) return;
      this.isStopping = true;
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
      try {
        http.request({
          url: 'http://127.0.0.1:18080/api/stop',
          method: 'GET',
          timeout: 500
        }).catch(() => {});
      } catch (e) {}

      this.$page.setTimeout(() => {
        if (gen !== (this.playGen || 0)) {
          console.warn("[SoftVPlayer] teardown skipped: newer play started (#" + gen + " -> #" + this.playGen + ")");
          return;
        }
        this.vPlayer = null;
        this.imageData = null;
        this.isPlaying = false;
        this.audioMode = false;
        this.currentTitle = '';
        this.currentBvid = '';
        this.isStopping = false;
        this.statusText = '播放已退出';
      }, 300);
    }