# 笔上哔哩（BiliPen）全面审计与改进方案

> 审计对象：`E:\dw\youdaokaifa-a7`（作品「笔上哔哩」，网易有道词典笔 A7 第三方 B 站客户端）
> 方法：源码逐行审计 + ARM 反汇编（libjsapi_softvideo.so / libfalcon.so）+ 官方播放器 QuickJS 字节码逆向 + **真机验证**
> 状态：**2026-10-24 已完成 v2.0.0 修复与真机回归，v2.1.0 补齐详情页 / 听视频 / 搜索键盘 / 预取缓存，v2.2.0 以自研 native 解码模块替换视频链路（看视频约 30fps）**；缺陷处理状态见 §0.1，验证记录见 §7（前端）、§8（daemon）、§9（v2.1.0 实测补充）与 §10（v2.2.0 native 播放引擎）

---

## 0. 结论摘要

1. **本次「更多 bug」的头号嫌疑是 `onInfo` 回调参数顺序写错**：软解库实际发射 `(width, height, duration)`，前端按 `(duration, width, height)` 解构（[app.js:371](bili_pkg/app.js#L371)）。首次 `onInfo` 触发后 `vHeight` 变成视频时长（毫秒），`scale(172/vHeight)≈0`，画面会瞬间缩没；同时 `getImageData(360, 时长)` 触发巨量分配（被 catch 吞掉）。这与「画面异常、状态不可信」高度吻合。
2. **横向条纹不是单一 bug**，当前代码同时存在 4 个可疑源（参数错乱、非整数缩放重采样、单缓冲读写竞争、canvas 位图宽度可能仍是默认 300），必须真机做 10 分钟定位实验后定向修复，不能继续盲改。
3. **「改了没变化」的元凶在部署链**：每次启动同时拉起 `a/`、`b/` 两个 `bili-daemon`，旧进程常驻不退出、无单实例锁；新前端可能连到旧后端。
4. **架构方向没错**（Falcon + 官方软解 + 本地 Go 代理），短期内应以「修正确性 + 加可观测性」为主；方案 B（纯 C 扩展）和「复用官方 CVPlayer/videoproxy」是两个值得评估的长期替代路线。

### 0.1 缺陷处理状态（2026-10-24，v2.0.0 → v2.1.0）

| 原编号 / 缺陷 | 状态 | 处理与证据 |
|---|---|---|
| P0-1 `onInfo` 参数顺序错 | 已修复 | 真机日志证实 `(width,height,duration)`；修正并夹紧尺寸（§7.1） |
| P0-2 缓冲尺寸与 canvas 位图失配 / 条纹 | 已修复 | 起播前 `setVideoInfo(640,360)` 对齐尺寸；截图无条纹（§7.2；「是否改变原生输出」见 §9.1 实测修正） |
| P0-3 播放/停止定时器竞态 | 已修复 | `playGen` 代次锁 + 定时器取消 + 延迟卸载代次校验（§7.5） |
| P0-4 daemon 双实例 / 版本错配 | 已修复 | `killall` + 单槽启动 + `/api/ping` 版本校验（§7.4、§8.1） |
| P0-5 `/api/stream` 120s 截断长视频 | 已修复 | 上下文 + 45s 空闲看门狗；160s 长视频实测不断（§8.1） |
| P0-6 canvas 物理位图宽度默认 300 隐患 | 已核对 | attrs 显式 640×360 生效（日志 `Initial buffer set: 640x360`） |
| P1-8 `.on(null)` 解绑抛异常导致线程泄漏 | 已修复 | 改为 `sig.off(token)`；teardown 日志完整（§7.3） |
| P1 扫码登录 Cookie / 明文 0644 / -101 误清 | 部分修复 | 代码已加固；**成功路径待真实扫码验证**（§8.1、§8.3） |
| P1 封面并发与缓存半截 | 已修复 | 并发≤3 + tmp→rename（§8.1） |
| P1 长视频断流、playurl 重复解析 | 已修复 | 缓存 + Range/206 + backup 回退（§8.1） |
| P1 音量线程写不存在控件 | 已修复并更正机制 | HAL 读 vctl 实现音量；daemon 只读展示（§8.2） |
| P1 本地 18080 无鉴权 | 暂不实现 | 项目决定跳过（§8.3） |
| P1 `/api/status` 语义虚假（ffmpeg 死代码） | 已修复 | 改为真实会话语义（§8.1） |
| P2 前端状态机/幽灵层/重复点击等 | 部分修复 | pollStatus 已移除、代次锁已加；其余见 §2.2 未处理项 |
| 打包：daemon 未 strip / 包体大 / 版本号 | 已修复 | 自动编译 strip；4.69MB→2.56MB；版本 2.0.0（§8.1） |

**v2.1.0 本轮追加：**

| 原编号 / 缺陷 | 状态 | 处理与证据 |
|---|---|---|
| 视频详情页（卡片→全屏详情→看/听/下载） | 已新增并真机验证 | 640×172、左上「← 返回」、三按钮；下载为占位（仅提示）；打开即触发整段预取（§9.5） |
| 搜索页热点 chips → 自绘屏幕键盘 | 已新增并真机验证 | 4 行键盘 + 顶部实时预览；原生软键盘在该机型不弹（§9.5、平台手册第 10 章）；**仅英文/数字** |
| 覆盖层点击穿透（详情页/播放层/键盘） | 已修复 | 覆盖层显示时不再渲染底层首页，点击不会落到未渲染卡片（§9.5） |
| 听视频：DASH 音轨 → ffmpeg remux | 已新增并真机验证 | 纯音频 m4s 报 `streamDecoder init failed`；remux 4 个样本全部成功（§9.3） |
| 非 16:9 视频起播中止 | 已修复 | `onInfo` 报出实际解码尺寸（640×320、480×360）时按该尺寸自动重开一次（§9.5） |
| 整段预取 / 本地缓存 | 已新增并真机验证 | 600MB、7 天过期、启动 LRU；`/api/stream` 缓存优先 + Range/206 + 回退实时代理；预取限速 512KB/s（§9.5） |

**v2.2.0 本轮追加（当前版本 2.2.0）：**

| 变更 / 缺陷 | 状态 | 处理与证据 |
|---|---|---|
| 播放卡顿（10–12fps，CPU 95–98%） | 已定位并修复 | 线程级采样：`video_decoder` 72–79%、JS 主线程 17–21%、`YAudioModule` ~1%；同机 ffmpeg 对照低效约 5 倍（§10.1） |
| 自研 native 视频解码模块 `libjsapi_rgavideo.so`（13,820 字节） | 已新增并真机验证 | FFmpeg 4.4.1 软解 + `sws_scale` YUV420→RGBA + 双缓冲 + PTS 节奏 + 丢帧；`registerCModuleLoader("rgavideo")`，JS 每 16ms `readFrame()` 取帧（§10.2、§10.3） |
| 看视频音频 | 已新增并行方案并验证 | 并行 `SoftVPlayer` 播 `/api/audio?variant=remux`；失败自动重试两次；用户确认音频正常（§10.5） |
| native 模块异常回退 | 已实现 | `import('rgavideo')` 失败或初始化异常自动回退 softvideo 视频链路（§10.6） |
| RGA 硬件色彩转换 | 未接入 | 当前 YUV→RGBA 走 CPU `sws_scale`；RGA 需 dma-buf/连续物理内存，后续替换转换步骤（§10.6） |
| 版本 / 产物 | 已更新 | `/api/ping` = `{"version":"2.2.0"}`；AMR 2,633,188 字节（约 2.63MB）；daemon 6,094,983 字节（约 6.03MB）（§10.4） |

---

## 1. 项目全貌

### 1.1 定位与硬约束

| 项 | 事实 |
|---|---|
| 设备 | 网易有道词典笔 A7（SKU `OVERHEAD_Y09_SKU_CHN_PRO`，AppID `9002000869905604`） |
| SoC | Rockchip RV1106，单核 Cortex-A7，ARMv7 + NEON + VFPv4，**hard-float + uClibc-ng 32 位** |
| 内存 | 物理 128MB，可用约 92.7MB；QuickJS 堆仅 1–3MB；每个 DOM 节点约 912B |
| 屏幕 | 逻辑 640×172（3.72:1 带状），物理 fb0 为 172×640 RGB565，`direction:270` 由 RGA 旋转输出，fps 上限 45 |
| 前端 | 网易 Falcon = 定制 Vue2 + QuickJS `20200705`；逻辑视口由 `setViewPort(640)` 定义 |
| 包格式 | `.amr` = ZIP + `manifest.json` 逐文件 `size/md5` 强校验 + A/B 双槽安装 |
| 扩展 | 应用内 `libs/arm/libjsapi_*.so` 被宿主 `dlopen`，导出 `custom_init_jsapis` 注册 JS 模块 |
| 原生能力 | `softvplayer`（FFmpeg 软解 + YAudioModule 音频）、`nekolib`（`shell.exec`）、RGA、TinyALSA |

### 1.2 架构与数据流

```
Falcon 前端 bili_pkg/app.js (Vue2, 640×172)
 ├─ http ─────────► bili-daemon (Go, 127.0.0.1:18080)
 │                   ├─ /api/feed /trending /search     B站 Web API
 │                   ├─ /api/login/(qr|poll|logout)     扫码登录 → /userdisk/bili_cookie.txt
 │                   ├─ /api/stream?bvid=...            B站 360P MP4 的 Range 透传代理
 │                   ├─ /api/play|stop|status           播放会话登记（v2 已与会话语义对齐）
 │                   └─ VolumeReader (只读)              SysV shm 0x7663746c（音量由 HAL 读取生效）
 └─ softvplayer ──► libjsapi_softvideo.so（进程内软解）
                     └─ 解码 640×360 RGBA → 写入 JS ImageData.buffer
                        → onDrawFrame 回调 → ctx.putImageData → Falcon 合成 → RGA → fb0
```

### 1.3 代码地图

| 路径 | 行数/大小 | 角色 |
|---|---|---|
| [bili_pkg/app.js](bili_pkg/app.js) | 1042 行 | 前端全部逻辑（**由 build_bili.py 生成，直接改会被覆盖**） |
| [bili_src/main.go](bili_src/main.go) | 981 行 | Go 守护进程：12 个路由 + 封面缓存 + 音量线程 |
| [build_bili.py](build_bili.py) | 1220 行 | 构建/打包流水线：内嵌 app.js 字符串 → 拷 libs → 算 cert → 打 zip |
| [bili_pkg/manifest.json](bili_pkg/manifest.json) | cert + 版本 | AppID/quickjs 版本/cert |
| [libjsapi_softvideo.so](libjsapi_softvideo.so) | 188KB | 官方原厂软解（MD5 `8bde…f2fb0`，**不要改**；v2.2.0 起主要承担音频与回退） |
| [libjsapi_nekolib.so](libjsapi_nekolib.so) | 17KB | 自研 C 扩展，提供 `shell.exec` 拉起 daemon |
| [native/rgavideo.c](native/rgavideo.c) | 320 行 | v2.2.0 自研视频解码模块源码：FFmpeg 软解 + `sws_scale` + 双缓冲 + PTS/丢帧（§10.2） |
| [libjsapi_rgavideo.so](libjsapi_rgavideo.so) | 13,820 字节 | 上述源码的 ARM EABI5 交叉编译产物，随包打入 `libs/arm/`（§10.3） |
| [libfalcon.so](libfalcon.so) / [libquickjs.so](libquickjs.so) | 8.5M / 853K | 逆向用副本，不参与打包 |
| [scratch/](scratch/) | 逆向脚本与官方字节码 | 逆向取证脚本与官方字节码（`official_index.js.bin` = 官方播放器字节码） |
| [README.md](README.md) | 当前版本说明（v2.2.0 现状、API 契约、部署与排障） |
| [网易有道A7…手册.md](网易有道A7词典笔软硬件全栈与Miniapp_AMR开发技术手册.md) / [笔上哔哩_开发技术手册.md](笔上哔哩_开发技术手册.md) | 992 / 756 行 | 平台逆向手册；方案 B（C 扩展）设计稿 |

### 1.4 构建与部署链

```
go build (ARMv7, -s -w) ─► bili_src/bili-daemon ─────────────────┐
libjsapi_{nekolib,softvideo}.so ────────────────────────────────┤ copy → bili_pkg/libs/arm/
arm-rockchip830-…-gcc（WSL2）─► libjsapi_rgavideo.so（13,820B）─┤
app_icon.png ───────────────────────────────────────────────────┘
build_bili.py：生成 bili_pkg/app.js → 遍历算 cert(size+md5) → zip(1980 时间戳, 0731 权限) → 9002000869905604.amr
部署：adb push → miniapp_cli install → chmod +x → 建 covers 软链 → miniapp_cli start
运行：PMS 按 A/B 槽解压到 /userdisk/secondary/miniapp/data/mini_app/pkg/9002000869905604/{a|b}/
```

### 1.5 运行时真实行为（按代码还原）

- **启动**：`onLoad → mounted → bootstrapDaemon()` 用 `nekolib.shell.exec` 依次 `chmod` 并**同时后台启动 a/ 和 b/ 两个 daemon**；固定等 1000ms 后并发拉 user/trending/feed/QR（[app.js:132-154](bili_pkg/app.js#L132-L154)）。
- **播放**：点卡片 → `isPlaying=true`（立即挂载播放层）→ 调 `/api/play` 登记 → **200ms 后**取 `$refs.vCanvas`、建 ctx、`new SoftVPlayer()`、预分配 `getImageData(640,360)`、`setImageDataBuffer` → `softvPlayer.start('http://127.0.0.1:18080/api/stream?bvid=...')` → 每帧 `putImageData`（[app.js:307-429](bili_pkg/app.js#L307-L429)）。
- **播放（v2.2.0 起）**：先 `import('rgavideo')`，`setBuffer(imageData.data.buffer, 640, 360)` → `start('/api/stream?...')`，前端 16ms 定时器 `readFrame()` 取到帧才 `putImageData`；同时并行起一个 `SoftVPlayer` 播 `/api/audio?bvid=...&variant=remux` 出声（§10.2、§10.5）。`import` 或初始化失败 → 自动回退上面的 softvideo 视频链路（§10.6）。
- **停止**：解绑 4 个回调 → `vPlayer.stop()` → `/api/stop` → **300ms 后**才 `vPlayer=null; isPlaying=false`（[app.js:430-461](bili_pkg/app.js#L430-L461)）。
- **登录**：二维码 PNG 由 daemon 生成；前端每 2s 轮询；成功后 daemon 把 cookie 写 `/userdisk/bili_cookie.txt`。
- **音量**：daemon 每 50ms 读 SysV 共享内存 `0x7663746c` 的 `+4`（spk_vol 0-100），映射 0-255 写 `tinymix` 控件 25；启动时把控件 23 锁 16（[main.go:690-754](bili_src/main.go#L690-L754)）。

---

## 2. 缺陷清单

### 2.1 P0 — 直接导致「画面异常 / 更多 bug」

**P0-1 `onInfo` 参数顺序错误（本次回归头号嫌疑）**
- 证据：前端 [app.js:371](bili_pkg/app.js#L371) `onInfo.on((duration, width, height) => ...)`。
  反汇编 `libjsapi_softvideo.so`：
  - `start()` 在 `0x11f7c→0x11f84` 解析出字符串 `onInfo`，随后 `0x11f8c: mov r3,#0x2d8` 绑定到信号对象 `+0x2d8`；
  - `init()` 在 `0x13fd8-0x13ff4` 向 `+0x2d8` 发射 3 个 int：`[codec_ctx+0x5c]`、`[codec_ctx+0x60]`、`[this+0x74]`，即 **(width, height, duration)**。
- 后果：第一次 onInfo 后 `vWidth=360`、`vHeight=时长(ms)`；`scale(172/vHeight)≈0.0013` → 画布缩到看不见；`getImageData(0,0,360,130000)` 巨分配被 catch 吞掉，状态却已不可逆。
- 修复：改为 `(width, height, duration)`，并对 `0<w≤640、0<h≤360` 做合法性夹紧；失败不得继续 start。

**P0-2 缓冲尺寸与 canvas 位图失配**
- 证据：[app.js:374-387](bili_pkg/app.js#L374-L387) 按 onInfo 的 `(w,h)` 重建 `ImageData` 并 `setImageDataBuffer`，但 canvas 的 `attrs.width/height` 恒为 640×360（[app.js:967-972](bili_pkg/app.js#L967-L972)）。
- 后果：`putImageData` 源宽 ≠ 目标位图宽时逐行错位 → 斜向/横向条纹；`setImageDataBuffer` 换 buffer 时旧 buffer 被 GC，而 native 线程仍写旧指针 → UAF/半帧撕裂。
- 修复：attrs 与 CSS 尺寸全部绑定 `vWidth/vHeight`；换 buffer 必须 stop→等待→换→restart；native 侧写入长度做断言。

**P0-3 播放/停止定时器竞态（退出后仍在播）**
- 证据：play 的 200ms 定时器不存 token、不检查 `isStopping`（[app.js:327](bili_pkg/app.js#L327)）；stop 的 300ms 无条件 `vPlayer=null; isPlaying=false`（[app.js:453-460](bili_pkg/app.js#L453-L460)）。
- 后果：播放后 <200ms 退出 → 退出后又创建 player 并起流（野解码线程/继续出声）；300ms 内重播 → 被旧 teardown 杀掉 → 黑屏。
- 修复：引入代次号 `playGeneration`，所有回调/定时器校验代次；play/stop/onHide/onUnload 全路径取消定时器。

**P0-4 daemon 双实例与版本错配**
- 证据：[app.js:140-143](bili_pkg/app.js#L140-L143) 同时后台启动 `a/`、`b/` 两份 `bili-daemon`；[main.go:149-156](bili_src/main.go#L149-L156) 后启动者 bind 失败直接 `log.Fatalf`；无 pidfile/无 kill/无单实例锁。
- 后果：先绑 18080 者存活；A/B 槽交替安装后，**新前端连旧后端**；重装/卸载后旧进程残留占端口。
- 修复：只启 `packages.json` 的 active 槽；启动前 `pkill -f libs/bili-daemon`；flock/pidfile；加 `/api/shutdown` 并在 onDestroy 调用。

**P0-5 `/api/stream` 120s 超时截断**
- 证据：[main.go:635](bili_src/main.go#L635) `http.Client{Timeout:120s}` 覆盖 body 读取，[main.go:647](bili_src/main.go#L647) `io.Copy` 在 120s 报错。
- 后果：任何 >2 分钟视频必断流（软解报错/卡帧），而客户端只当网络错误。
- 修复：用 `r.Context()` + Transport 连接级超时；不要用 Client.Timeout 卡 body。

**P0-6 canvas 物理位图宽度可能仍是默认 300**
- 证据（逆向既有结论 + 库符号）：`libfalcon.so` 中 `WXCanvas` 构造把宽高初始化为 300×150，只有 `appendDefaultStyles` 读到 attrs `width/height>0` 时才覆盖；`JSCanvasContext` 提供 `createCanvasContext/getImageData/putImageData`。
- 后果：若 attrs 绑定晚于位图分配，`putImageData` 目标宽=300、源行宽=640 → 每行错位 340px 的「斜向/横向条纹」（与 README §4.1 描述一致）。
- 状态：**待真机验证 attrs 生效时序**，这决定条纹是「缩放重采样」还是「stride 错位」。

### 2.2 P1 — 稳定性 / 可观测性

| # | 问题 | 证据 | 后果 | 修复 |
|---|---|---|---|---|
| 1 | 缩放链非整数重采样 | [app.js:744-749](bili_pkg/app.js#L744-L749)、[974-979](bili_pkg/app.js#L974-L979)：640×360 位图 `transform:scale(0.4778)` | 每帧 306×172 重采样，可能产生横向 banding；画面只占中间 306px | 去掉 scale，改为 1:1 像素 + 裁剪/布局（见 §3） |
| 2 | 首帧 ref 时序 | [app.js:329-331](bili_pkg/app.js#L329-L331) 取不到 canvas 只 warn | 永久黑屏遮罩，无重试 | `$nextTick` + 重试 N 次；失败撤销 `isPlaying` |
| 3 | 静默失败 | [app.js:366-368](bili_pkg/app.js#L366-L368)、[385-387](bili_pkg/app.js#L385-L387)、[422](bili_pkg/app.js#L422) | 分配/绑定失败仍 `start()` → 黑屏花屏无提示 | 失败即 stop + 顶部错误提示 |
| 4 | 页面生命周期缺失 | [app.js:45-69](bili_pkg/app.js#L45-L69) 无 onHide/onUnload 停播 | 切页/退出后 native 线程写已销毁 canvas（崩溃面） | onHide/onUnload：解绑回调 → stop → 释放 buffer |
| 5 | 定时器泄漏 | PageRes 跟踪 `this.setTimeout`，但代码全用 `$page.setTimeout/setInterval`（[app.js:123](bili_pkg/app.js#L123)、[148](bili_pkg/app.js#L148)、[327](bili_pkg/app.js#L327)、[453](bili_pkg/app.js#L453)） | `release()` 清不掉；轮询永不停止 | 统一走 `this.setTimeout`，onUnload 调 release |
| 6 | pollStatus 幽灵层 | [app.js:462-476](bili_pkg/app.js#L462-L476) 见 `playing` 就置 `isPlaying=true`；而 daemon `Playing` 恒 false（[main.go:170](bili_src/main.go#L170) `ffmpegCmd` 从不赋值） | 潜伏：一旦 status 为真会出现无 player 的播放层 | 删除轮询或仅做连通检测 |
| 7 | 重复点击 | 父 `div` 与子 `text` 同绑 click（[app.js:798-827](bili_pkg/app.js#L798-L827)） | 单次触摸触发两次 `switchTab`（README §4.3 同类缺陷回归） | 只保留外层监听 |
| 8 | 状态文案不渲染 | `statusText` 只赋值（[app.js:95](bili_pkg/app.js#L95) 等），模板未使用 | 加载/失败/退出提示全部不可见 | banner 绑定 `statusText` |
| 9 | OOM 风险 | 640×360 RGBA=921,600B ≈ QuickJS 堆 1/3；另有 canvas 位图、RGB24 帧、封面缓存无上限 | 播放/切视频触发 GC 抖动甚至 OOM | 单 buffer 复用、stop 释放、封面限流 |
| 10 | 每次 stream 重解 playurl | [main.go:614](bili_src/main.go#L614) 每次 Range/seek 先查 view 再查 playurl | 起播 2 次额外 API，易触发风控、seek 卡 | 缓存 cid/playurl 10min，支持 backup_url |
| 11 | Range/206 语义不完整 | [main.go:631-647](bili_src/main.go#L631-L647) 只透传请求 Range | CDN 忽略 Range 时回 200 全量 → seek 卡/串帧；4xx/HTML 错误页被当视频转发 | 校验 206/Content-Range，失败回退 |
| 12 | 扫码登录可能写空 Cookie（**待真机验证**） | [main.go:303-309](bili_src/main.go#L303-L309) 只用 `resp.Cookies()`，忽略 `data.url` 里的 query 参数与 `refresh_token` | 登录成功但请求仍未登录；`saveCookie("")` 覆盖旧值 | 解析 `data.url` query + 原子写 0600 |
| 13 | 无 CookieJar / buvid | 请求只塞 Cookie 从不存 Set-Cookie | B 站视作新设备，搜索/playurl 间歇 -412 | `cookiejar` + buvid 初始化 |
| 14 | playurl 参数脆弱 | [main.go:572](bili_src/main.go#L572) `qn=16&type=mp4&platform=html5`，无 WBI/fnval | 未登录/风控时 `durl` 为空 → 播放失败 | 失败重试 + backup + WBI |
| 15 | handlePlay 语义虚假 | [main.go:650-669](bili_src/main.go#L650-L669) 只登记 bvid；`ffmpegCmd` 死代码（[main.go:50](bili_src/main.go#L50)、[681-687](bili_src/main.go#L681-L687)） | `/api/status` 与实际不符；`/api/stop` 停不了真实播放 | 删除死字段，或改为前端上报会话 |
| 16 | 音量线程失败逻辑 | [main.go:721-741](bili_src/main.go#L721-L741) shm 失败每 50ms 重试+日志；回退值 50 会写 `tinymix 25=127` | 强行锁 50% 且永不跟随系统；日志刷屏 | 失败一次即退避；无有效数据不写硬件 |
| 17 | tinymix 硬编码 | [main.go:691](bili_src/main.go#L691)、[750](bili_src/main.go#L750) 控件号 23/25、非绝对路径 | 控件枚举变化会写错增益；PATH 不全静默失败；退出不还原 | 按控件名解析、绝对路径、退出还原 |
| 18 | 无鉴权 | [main.go:133-147](bili_src/main.go#L133-L147) 全部 GET 无 token | 同机应用可读用户信息、写 Cookie、耗流量、清登录 | 随机 token（0600 文件）+ Origin 校验 |
| 19 | Cookie 明文 0644 | [main.go:29](bili_src/main.go#L29)、[74-76](bili_src/main.go#L74-L76) | 会话可被同机任意应用窃取 | 0600 + temp+rename + 私有目录 |
| 20 | shm 失败重试无上限 | 同上 | 单核 A7 上 20Hz 唤醒 + 日志 | 指数退避 |

### 2.3 P2 — 工程与体验

- 封面缓存无上限、并发 8/12 个 TLS 连接（[main.go:396-404](bili_src/main.go#L396-L404)），建议 ≤3 并发 + 本地缩略图池；`os.Create` 直写可能留下半截 JPEG（[main.go:117](bili_src/main.go#L117)），改 temp+rename。
- 无 context 取消（[main.go:539](bili_src/main.go#L539)、[572](bili_src/main.go#L572)、[621](bili_src/main.go#L621)）：客户端断开后仍耗数秒，92MB 设备上易堆积。
- `bvid`/`qrcode_key` 直接拼 URL 与文件名，未做格式校验（`^BV[0-9A-Za-z]{10}$`）。
- 播放层未盖住左导航（截图 `scratch/live_stripes_now.png` 可见左栏/黑边），命中区偏小（nav 25px、chip 20px）。
- `canvas.getContext('2d')` 兜底分支在 Falcon 中不存在（库只有 `createCanvasContext`），属误判能力。
- 封面 URL 未判空/防盗链失败静默。

### 2.4 打包与部署

| # | 问题 | 证据 | 影响 |
|---|---|---|---|
| 1 | daemon 未 strip（8.2MB，含 `.symtab/.debug_info`、源码路径），AMR 的 98.6% 是它 | [build_bili.py:16-30](build_bili.py#L16-L30)、产物 `bili-daemon` | 双槽各一份 ≈16.4MB；加载换页慢、路径泄漏；README §6.1 要求的 `-ldflags="-s -w"` 未生效 |
| 2 | app.js 是 Python 原始字符串内嵌 | [build_bili.py:33-1075](build_bili.py#L33-L1075) | 无 lint/单测/模块化；改 `bili_pkg/app.js` 会被覆盖；Windows 文本模式写 CRLF（35,421B），Linux 重建 md5 即变 |
| 3 | zip 权限位大概率无效 | [build_bili.py:1128-1133](build_bili.py#L1128-L1133) `ZipInfo` 在 Windows 下 `create_system=0` | PMS 按 Unix 语义解压时 `0755` 可能被忽略，需 app.js 兜底 chmod |
| 4 | 构建不编译、不校验 | 只 `copy2` 现成产物 | main.go 改了忘记 build 会打旧 daemon；无 ELF/架构断言 |
| 5 | 版本号硬编码 `1.0.0` | [build_bili.py:1057](build_bili.py#L1057)、[1083](build_bili.py#L1083) | 同版本重装是否被 PMS 拒绝待验证；无法追溯 |
| 6 | `os.walk` 未排序、zip 时间戳固定 1980 | [build_bili.py:1106](build_bili.py#L1106)、[1124](build_bili.py#L1124) | 构建不可复现、cert 顺序不稳定 |
| 7 | 部署链无杀旧进程/无健康断言 | [README.md:248-263](README.md#L248-L263) | 装完连旧 daemon → 「修了没变化」 |
| 8 | `PKG_DIR` 不清理 | [build_bili.py:12-13](build_bili.py#L12-L13) | 历史残留会进包并计入 cert |

---

## 3. 条纹根因：先测量，再动手（已于 2026-10-24 完成，结论见 §7.2 / §8.1）

当前有 4 个共存疑点，**不要再盲改**。建议按下面顺序做 3 组对照实验（每组 10 分钟）：

**实验 0：确认真实参数与位图宽度（最优先）**
1. 在 [app.js:371](bili_pkg/app.js#L371) 已有一行日志 `console.warn("[SoftVPlayer] onInfo duration=... width=... height=...")`，起播后读 `/userdata/applog/YD_PEN_APP.log`，即可判定顺序错配。
2. 在 `play()` 里 `console.warn("[DBG] canvas attrs", this.$refs.vCanvas && this.$refs.vCanvas.offsetWidth, this.$refs.vCanvas && this.$refs.vCanvas.offsetHeight)`，配合 `miniapp_cli capture` 截图，判断位图/布局宽度。
3. 与官方播放器（AppID `8001661999525016`）同场景截图对比。

**实验 1：去掉缩放，1:1 像素**
- 把 canvas 改为 `attrs 640×360 + position:absolute; top:-94px`、父容器 `640×172; overflow:hidden`（不缩放、不 transform）。
- 若条纹消失 → 条纹由合成阶段非整数缩放/采样造成；若仍在 → 是位图宽度/stride 问题。

**实验 2：验证 canvas 位图宽度**
- 若 Falcon 的 `JSCanvasContext` 暴露 `getCanvasWidth` 一类接口（libfalcon 中有 `JSCanvas` 符号，可再逆向确认），直接断言 ==640。
- 否则用「把 canvas attrs 临时设为 300×150，观察条纹是否变化」来反证位图宽度假设。

**实验 3：单/双缓冲**
- 若前两项排除，再在 `onDrawFrame` 中把 `putImageData` 目标换成第二块 canvas/或用 `setTimeout(0)` 延迟一帧提交，验证是否撕裂（单核设备上概率较高）。

判定表：

| 实验 1 结果 | 实验 2 结果 | 结论 |
|---|---|---|
| 条纹消失 | 无要求 | 缩放链问题 → 采用 1:1 + 裁剪方案 |
| 条纹仍在 | 位图宽=300 | stride 错位 → 修正 attrs/创建时序 |
| 条纹仍在 | 位图宽=640 | 读写竞争 → 双缓冲/线程同步 |

---

## 4. 更好的实现

### 4.1 短期（0.5–1 天，只改必要点）—— 已全部实施并验证（v2.0.0）

**前端（app.js 源在 build_bili.py 内，建议先抽成独立文件）**
1. **修 onInfo**：`on((width, height, duration) => {...})`，加合法性夹紧；不满足 640×360 时不要 `getImageData(0,0,w,h)`。
2. **canvas 尺寸单一真源**：`attrs.width = String(vWidth)`、`attrs.height = String(vHeight)`、`style.width/height` 同源；去掉写死的 640/360 与 `scale(0.4777)`。
3. **播放显示策略二选一**（产品决策）：
   - **A 完整画面（letterbox，官方同款）**：640×360 缩放到 306×172 居中，上下黑边由父容器填充；
   - **B 满宽裁剪（推荐先做，DEBUG 友好）**：不缩放，canvas 640×360 + `top:-94px`，父容器 640×172 裁剪，1:1 像素，零重采样开销。
4. **状态机**：`playerState = idle|preparing|playing|stopping|error` + `generation`；play 前若 `preparing/playing` 先 stop；所有 `setTimeout` 存 token，stop/onHide/onUnload 取消；onHide/onUnload 显式释放。
5. **失败可观测**：ref 空重试 3 次（`$nextTick` + 50ms）；`setImageDataBuffer`/`start` 异常 → 停止并显示 `statusText`（模板绑定）。
6. **去掉重复 click 监听**、删除 `pollStatus` 幽灵层逻辑。

**后端（main.go）**
1. 只启一个 daemon：去掉 a/b 双启；启动前 kill 旧进程或加 pidfile/flock；`/api/shutdown`。
2. `/api/stream`：改 `r.Context()` + 空闲超时；校验 206；缓存 cid/playurl（10min）；支持 `backup_url`。
3. 登录：解析 `data.url` query 落 cookie；`saveCookie` 原子写 + 0600；加 CookieJar/buvid。
4. 删除 `ffmpegCmd` 死代码，`/api/status` 改为返回 token 认证下的真实会话或删除。
5. 音量：shm 失败退避；无有效数据不写 tinymix；退出还原 23。

**构建/部署**
1. `build_bili.py` 内先 `go build -trimpath -ldflags "-s -w -buildid="` 并断言产物是 ARM32 ELF。
2. `newline="\n"` 写 app.js；`zinfo.create_system=3`；`os.walk` 排序；版本号自动递增。
3. 部署脚本：`install → pkill 旧 daemon → start → 轮询 /api/ping → capture 截图`，任何一步失败即报错。

### 4.2 中期（1 周，结构性改善）

- **前端工程化**：`app.js` 拆成 `src/app.js + src/pages/*.js + src/utils/http.js + src/player/*`，用 esbuild 打包后再交给 qjsc/AMR（若 qjsc 不可用则保持单文件但由构建脚本拼接）；加最小单测（状态机纯逻辑）。
- **播放器抽象**：`PlayerController` 独立模块，暴露 `prepare/start/stop/onState`，页面只订阅状态；native 回调全部走一个事件入口并带代次校验。
- **daemon 契约化**：`/api/health`（version/pid/uptime/volume）、token 鉴权、错误码规范（网络/风控/未登录/上游失败分开）、请求预算统一（前端超时 > 后端上游超时之和）。
- **可观测性**：daemon 日志落 `/userdisk/bili_daemon.log`（滚动）；前端关键路径 `console.warn` 统一前缀 `[BiliPen]`；加「诊断页」显示 daemon 状态、playurl、canvas 尺寸。
- **资源治理**：封面并发 ≤3、LRU 上限 200 张、缩略图尺寸收敛；播放 buffer 复用；播放结束显式释放。

### 4.3 长期（替代路线，按投入排序）

1. **路线 A：复用官方播放能力（性价比最高，需先验证）**
   官方播放器字节码显示它依赖 `videoproxy`（`falcon://8001661999525016/video-service`）、`CVPlayer`、`SoundPlayer`、`VideoManager`。若这些 JSAPI 模块在本应用上下文中也可 `import`，就可以把「解码/音频/音量」完全交给官方链路，我们只做 B 站数据与 UI，**从根上避开 canvas/软解/同步问题**。验证方式：写一个最小页面 `import cvplayer` / `import videoproxy` 试可用性（1 小时）。
2. **路线 B：方案 B（原生 C 扩展，[笔上哔哩_开发技术手册.md](笔上哔哩_开发技术手册.md)）**
   把 WBI 签名、feed、播放全部下沉到 C（QuickJS CModule），JS 只做 UI。优点是省 JS 堆、省一次拷贝、可自控双缓冲与线程同步；缺点是 uClibc 工具链 + 调试成本，估算 2–4 周。**只有在 Canvas 渲染问题被证明无解时才值得走。**
3. **路线 C：放弃自绘播放，改用系统/官方播放器**
   若官方播放器支持 URL 入参（`videoproxy` 或 `falcon://` 深链），直接调起官方播放器播放 `/api/stream?bvid=`，我们只做列表与登录。代价是 UI 不可定制，收益是稳定性最高。

### 4.4 路线对比

| 方案 | 工作量 | 稳定性 | 风险 | 建议 |
|---|---|---|---|---|
| 4.1 短期修复（保留现架构） | 0.5–1 天 | 中高 | 条纹根因若在 Falcon 内部仍可能残留 | **先做** |
| 4.2 中期重构 | 1 周 | 高 | 需真机反复验证 | 短期修复后立刻做 |
| A 复用官方播放链路 | 1–3 天试 | 最高 | 模块/权限未知 | **优先验证可行性** |
| B 方案 B（C 扩展） | 2–4 周 | 高 | 工具链/调试成本 | 备选 |
| C 调起官方播放器 | 1–2 天 | 高 | UI 不可控、深链稳定性未知 | 产品可接受时最优 |

---

## 5. 建议执行顺序

1. **重建基线**：`go build`（strip）→ `build_bili.py` 全量重打 → 安装 → `pkill` 旧 daemon → 验证 `/api/ping` 为**新版本号**（先解决「改了没变化」）。
2. **加日志做实验 0**：确认 onInfo 顺序、canvas 尺寸、`capture` 截图（10 分钟）。
3. **修 P0-1/2/3 + 实验 1**：一次只改一个变量，每次重装后用 `capture` 对比截图存档（`scratch/after_*.png`）。
4. **修 P0-4/5 + 部署脚本**：确保每次部署干净、可回滚。
5. **再做实验 2/3** 决定是否双缓冲；最后处理 P1 列表与工程化。

验收标准（建议写进 README）：
- 起播 3 秒内首帧可见，播放 10 分钟无图形错位/断流；
- 连续「播放→退出→播放」20 次无崩溃、无野音频；
- 冷启动到首页数据 <5s，daemon 只有一个进程；
- 音量滑块拖动 ±5 档，ALSA 值与 UI 一致且退出还原；
- 构建产物可复现（同源 md5 一致）。

---

## 6. 待验证清单（大部分已在 §7/§8 完成；剩余见 §8.3）

1. `onInfo` 实际参数顺序（读 `YD_PEN_APP.log` 的 `[SoftVPlayer] onInfo` 行）。
2. canvas 物理位图宽度是否 640（实验 2）。
3. `$page.setTimeout/setInterval` 在 Falcon 页面对象上是否真实存在（不存在会直接 TypeError）。
4. `vPlayer.onXxx.on(null)` 解绑语义是否有效。
5. 扫码登录 `resp.Cookies()` 是否为空（对比 `data.url` query）。
6. A/B 槽位启动顺序与 `packages.json` 的 active 槽是否一致。
7. `JQSignal` 3 参信号的参数语义（已用反汇编确认为 `(width,height,duration)`，真机日志复核一次即可闭环）。
8. 官方播放器在本机是否同样只显示 306×172（`capture` 对比），以确定产品预期。

---

---

## 7. 真机验证结果（2026-10-24 17:2x–17:38，设备 7FC2800009702019）

### 7.1 `onInfo` 参数顺序：已由真机日志证实

修复前的原始日志（安装包 16:29 版本，`/userdata/applog/YD_PEN_APP.log`）：

```
[SoftVPlayer] onInfo duration=640 width=360 height=133
[SoftVPlayer] onInfo duration=480 width=360 height=528
```

前端按 `(duration,width,height)` 解构 → `duration=640, width=360, height=视频时长`。与反汇编结论完全一致：**库实际发射 `(width, height, duration)`**。

后果链（已确认）：`getImageData(0,0,360,133)` 只分配 191KB，而 native 按 640×360×4=921KB 写入 → **4.8 倍堆越界**；同时 `scale(172/133)≈1.29`（放大 2.7 倍）。这正是「条纹 + 更多 bug」的直接机制。

### 7.2 条纹根因：视频宽度不总是 640（stride 不一致）

修复参数顺序后，真机 onInfo 显示 `width=576 height=360 duration=322` —— **部分视频是 576×360**。前端固定按 640×360 分配 buffer，native 按 576×4 行宽写入 640×4 stride 的 buffer → 逐行错位 64px → 斜向/横向条纹。

**修复**：在 `start()` 前调用软解库自带的 `setVideoInfo(640, 360)`（符号表 `JSSoftVideoPlayerProxy::setVideoInfo`，JS 侧实测存在），强制解码输出与 buffer 同尺寸。修复后 onInfo 恒为 `640x360`，截图确认无条纹。

### 7.3 信号解绑 API：`.on(null)` 是非法用法

修复前日志：`[SoftVPlayer] stop error: TypeError: arg 1 must be function` —— 原 `stop()` 用 `.on(null)` 解绑，第一个调用就抛异常，导致 `vPlayer.stop()` 被跳过、解码/音频线程泄漏。

真机探针结果：`off=function`，`clear=undefined`，`connect=undefined`，`.on(cb)` 返回 **number 类型 token**。正确用法是 `sig.off(token)`。

修复后停止播放的完整日志（无任何异常）：

```
[JSSoftVideoPlayerProxy] [stop] stop
[packetQueue] flushQueue~
[audio_thread] end of audio_thread~
[stop] wait decode thread exit
[streamDecoder] exit wait end
[uninit] uninit~
[closeAudioDevice]
[YAudioModule] uninit
[streamDecoder] end of decode~
```

### 7.4 daemon 单实例：设备没有 `pkill`，只有 `killall`

bootstrap 里原来的 `pkill -f 'libs/bili-daemon'` 在设备 PATH（`/bin:/sbin:/usr/bin:/usr/sbin`）下不存在，静默失败 → 旧进程常驻、新 daemon `bind: address already in use`。改为 `killall bili-daemon` + 按 mtime 只启动最新安装槽后，实测**恰好 1 个 daemon 进程**、`/api/ping` 正常、日志干净。

### 7.5 已修复并验证的项（本轮代码改动均落在 `build_bili.py` 的 app.js 源）

| # | 修复 | 验证证据 |
|---|---|---|
| 1 | `onInfo` 改为 `(width, height, duration)` + 合法性夹紧 | 日志 `onInfo width=640 height=360 duration=341` |
| 2 | `start()` 前 `setVideoInfo(640,360)`，消除 stride 错位 | 截图无条纹、画面正常推进（字幕逐帧变化） |
| 3 | 信号解绑改 `sig.off(token)`；`vPlayer.stop()` 无条件执行 | 停止后线程/音频完整 uninit，无 TypeError |
| 4 | 播放代次锁（`playGen`）+ 定时器取消 | 日志 `stale play timer #N, abort` 正常丢弃旧播放 |
| 5 | daemon 单实例 + 只启动最新槽 | `ps` 恰好 1 个进程 |
| 6 | 播放层隐藏时解绑回调、`onComplete` 防重入 | 播放→停止→再播放 多轮无崩溃 |

### 7.6 仍待处理

- 「退出播放」按钮位于屏幕顶边（y≈14–20），触摸易与系统边缘手势冲突（实测曾意外回到桌面）；建议按钮下移或把标题栏加到 32px。
- 应用重新安装/重启后偶发触摸不响应（需再次 `miniapp_cli start` 才恢复），疑与系统输入焦点有关，待定位。
- 显示策略仍为 306×172 letterbox（官方播放器同款）；若产品要求满宽 640×172 需改为 1:1 裁剪方案。
- 报告 §2.2 的 daemon 侧问题（`/api/stream` 120s 超时、扫码 Cookie、明文 Cookie、无鉴权、Range 语义等）尚未开始修。

---

## 8. daemon v2.0.0 修复与验证（2026-10-24 17:45–17:55）

### 8.1 本轮改动（`bili_src/main.go`，包版本升到 2.0.0）

| # | 问题 | 修复 | 验证 |
|---|---|---|---|
| 1 | `/api/stream` 用 `http.Client{Timeout:120s}`，>2 分钟视频必断 | 改为 `r.Context()` + 连接/响应头超时 + **45s 空闲看门狗**，正常播放不受总时长限制 | 限速 25KB/s 下载 `BV1uant6mEv9`：`http=200 size=4,096,560 time=160.0s`（旧版 120s 必断） |
| 2 | Range/206 语义不完整、上游错误页当视频转发 | 透传 Range；只接受上游 200/206，失败自动回退 `backup_url`；只透传必要响应头；`text/html` 拒绝 | `HTTP/1.1 206 Partial Content`，`Content-Range: bytes 0-2047/33643532`，`Content-Length: 2048` |
| 3 | 每次 seek/起播都重查 view+playurl（易触发风控） | `resolvePlayURL` + 10 分钟缓存 + bvid 正则校验 | 重复请求无重复 `resolved playurl` 日志；非法 bvid 返回 400 |
| 4 | 扫码登录只读 `resp.Cookies()`，可能写空 Cookie | 同时解析 `data.url` query 凭证；空凭证不落盘并返回错误；保存 `refresh_token` | QR 生成/失效码（86038）返回正确；成功路径待真实扫码验证 |
| 5 | Cookie 明文 0644、非原子写 | `0600` + `tmp` 文件 rename 原子写；仅明确 `-101` 时清除 | 代码级；旧文件已 chmod 600 |
| 6 | `/api/status` 的 `Playing` 恒 false（`ffmpegCmd` 死代码） | 删除 ffmpeg 死代码，改为真实会话语义；`/api/telemetry` 风格字段 | `/api/play` → `status.playing=true`；`/api/stop` → false |
| 7 | 音量线程写不存在的 ALSA 控件 25，且失败后强锁 50% | 启动时探测控件（存在才写，否则仅读 vctl 并提示一次）；读 `vctl+4` 为真实音量 | 日志 `no writable master volume control, rely on HAL vctl (read-only)`；`/api/status` volume=50 与 `vctl offset4=50` 一致 |
| 8 | 封面 8~12 并发 TLS、可能缓存半截 JPEG | 并发上限 3 + 临时文件 rename + Content-Type 校验 | 推荐流封面正常加载 |
| 9 | 8.2MB 未 strip 二进制 | `-trimpath -ldflags "-s -w -buildid="` 交叉编译（构建脚本自动执行） | daemon 5.9MB；AMR 4.69MB → **2.56MB（-45%）** |
| 10 | `/api/ping` 无版本信息，无法判断新旧 daemon | 返回 `version/pid/uptime`；前端启动时打印版本 | `{"pid":328,"status":"ok","uptime":"3m17s","version":"2.0.0"}`；前端日志 `[BiliPen] daemon version: 2.0.0` |
| 11 | 前端 `pollStatus` 会把 daemon 状态强设为播放层（幽灵层） | 删除轮询；启动时 `/api/stop` 清理残留会话 + 校验版本 | 启动日志 `playback session stop`，无幽灵播放层 |

### 8.2 音量控制的真实机制（重要更正）

- 旧包对 ALSA 控件 25 的写入在真机上**一直失败**（该机型 card0 只有 0–24 号控件，无 25 号、无 Master Playback Volume），但旧包音量控制确实正常。
- 原因：`libydhal_audio.so` 内部直接读取 `vctl` 共享内存（`0x7663746c`）来应用系统音量；共享内存实测布局 `offset 0=110, offset 4=50, offset 8..20=80`，其中 `offset 4` 即扬声器音量（0–100）。
- 因此 daemon 不再强写不存在的控件，改为「探测存在才写、否则只读」，既保持旧包行为又不产生误导日志。

### 8.3 仍需处理

- 扫码登录成功路径（`data.url` 提取凭证 → 0600 落盘）需要一次真实扫码验证。
- 本地 18080 仍无鉴权（同机应用可调用）；建议下一步加随机 token（daemon 启动时由前端注入 env，请求带 token）。
- 设备侧 UI 偶发「触摸无响应 / 画面冻结」，与本次 daemon 改动无关（system/falcon 层面），需单独排查。
- `/api/stream` 未做本地 Range 缓存；高频 seek 时仍会重复拉流。

---

## 9. v2.1.0 实测补充（2026-10-24）

> 本章记录 v2.1.0（详情页 / 听视频 / 搜索键盘 / 预取缓存）在 A7 真机（7FC2800009702019）上的实测结论；§0.1 已追加本轮条目，与 §7/§8 重复的背景不再展开。

### 9.1 `setVideoInfo` 不控制软解输出尺寸（更正 §7.2 的表述）

- **探针 build**：调用 `setVideoInfo(320,180)`，缓冲区仍按 640×360 分配（`640×360×4 = 921,600` 字节）。
- **实测**：播放后对该缓冲区分四段采样，每段非零字节计数为 `14400, 14400, 14400, 13652` —— 四段全部被写满，说明原生仍按整帧 640×360 写入。
- **风险**：若真按 320×180 分配 buffer（`230,400` 字节）会直接写越界。
- **结论**：§7.2 中「强制解码输出与 buffer 同尺寸」应理解为「对齐 JS 侧尺寸声明」，**不是**改变原生分辨率；显示分辨率固定 640×360，不能用降低输出尺寸来省每帧开销。

### 9.2 卡顿定位：`cb/s` 数据与 ffmpeg 对照

| 指标 | 实测值 | 说明 |
|---|---|---|
| `cb/s` / `draws/s` | 6–12，两者相等 | 每秒回调数 = 每秒绘制数，JS 没有丢帧 |
| `maxgap` | 100–215ms | 帧间隔抖动 |
| miniapp 进程 CPU（播放中） | **76–83% 单核** | daemon 每 2s 采样 `playback cpu`；约 80ms/帧 |
| ffmpeg 纯软解 640×360 High@30fps | 115fps | utime 4.45s/20s ≈ 22% 单核 |
| ffmpeg 解码 + `-vf format=rgba` | 94fps | utime 6.27s/20s ≈ 31% 单核 |
| `putImageData` | 每帧 8–14ms | JS 侧单帧拷贝开销（约 10–14% 单核） |

结论：瓶颈在原生播放器的解码→渲染链路 / 单核调度，不在 JS 丢帧；播放时进程已占 76–83% 单核而仍只有 10–12fps，说明每帧约 80ms 的 CPU 主要花在原生解码/合成（`putImageData` 仅占其中 ≤14%）。听视频（不渲染视频）时音频流畅，加入视频渲染后音频也会一卡一卡。

### 9.3 音频：`raw` 失败、`remux` 成功

- `variant=raw`（纯音频 m4s）交给原生软解失败，日志 `streamDecoder init failed` —— **原生播放器必须有视频轨**。
- `variant=remux`：daemon 调 `/usr/bin/ffmpeg` 重封装，音频 `-c:a copy` + 160×90@1fps `mpeg4` 黑帧视频轨，输出分片 MP4 推流。
- 4 个样本视频（101s / 159s / 192s / 1075s）全部 remux 成功；`ffprobe` 显示 audio=aac、video=mpeg4，时长与源一致。
- 音轨选择：DASH 音频 `30280/30232/30216` 取 `bandwidth` 最大；实测样本 30280 ≈ 162–196kbps。

### 9.4 回调内同步 `stop()` 死锁

- 现象：在 `onError` / `onInfo` / `onComplete` 回调里同步调用 `player.stop()`，会与解码线程互锁，导致 JS 线程卡死（画面停住、后续事件不再派发）。
- 修复：改为 `setTimeout(0)` / `setTimeout(300)` 延后执行，原生回调里只做状态标记，不直接 stop。

### 9.5 本轮其他实测

- **非 16:9 视频**：`onInfo` 报出实际解码尺寸（如 640×320、480×360）时，按该尺寸自动重开一次（stop → 重建 buffer → `setVideoInfo` → start），不再中止。
- **覆盖层穿透**：详情页/播放层/键盘显示时不再渲染底层首页，点击不再落到未渲染的卡片上（历史遗留 bug 已修）。
- **预取 / 缓存**：详情页打开即整段预取到 `/userdisk/bili_cache`（上限 600MB、7 天过期、启动 LRU 清理）；`/api/stream` 缓存优先（Range/206），失败回退实时代理；播放期间限速 512KB/s。
- **日志路径**：miniapp 原生日志 `/userdata/applog/DictPen_*.log`（syslog 汇总）；daemon 日志 `/userdisk/bili_daemon.log`（每次启动被覆盖）。
- **ffmpeg 硬解**：设备 `/usr/bin/ffmpeg 4.4.1` 带 `h264_v4l2m2m`，实测 `Could not find a valid device`，硬解不可用。
- **版本 / 产物**：`/api/ping` 返回 `{"version":"2.1.0"}`；AMR 2,625,089 字节（约 2.62MB）；daemon 6,094,983 字节（约 6.03MB）。
- **§8.3 遗留项闭环**：「`/api/stream` 未做本地 Range 缓存」已由本轮预取 / 本地缓存解决。

### 9.6 新增 / 变更 API（v2.1.0）

| 接口 | 说明 |
|---|---|
| `GET /api/detail?bvid=BV...` | 详情 JSON：`bvid,title,owner,pic,pic_local,duration,desc,view,like,danmaku,cid,dimension:{width,height}`；打开同时后台预取。非法 bvid→400，解析失败→502 |
| `GET /api/audio?bvid=BV...&variant=remux\|raw` | 流式 MP4（`remux`，带 160×90 视频轨）或音频 m4s（`raw`，实测原生不支持）；非法 bvid→400 |
| `GET /api/metrics` | `version,uptime,load1,mem_available_kb,spools:[{bvid,have,total,done}],counters:{stream_bytes,audio_bytes,cache_fallbacks,stream_stalls,cache_hits}` |
| `GET /api/play?...&mode=video\|audio` | 新增 `mode` 参数，区分看视频 / 听视频 |
| `GET /api/status` | 返回增加 `mode` 字段 |
| `GET /api/stream?bvid=` | 语义变更：缓存优先（本地文件 + Range/206 透传），失败回退实时代理 |

### 9.7 本章证据索引

| 事实类别 | 证据来源（2026-10-24 真机） |
|---|---|
| 软解输出尺寸 | 320×180 探针 build + 921,600 字节缓冲区四段非零采样（14400/14400/14400/13652） |
| 卡顿 | `[Perf]` 日志（`cb/s`、`draws/s`、`avg`、`maxgap`）与 ffmpeg 纯软解帧率 / utime 对照 |
| 音频 | `streamDecoder init failed` 日志；`ffprobe`（audio=aac、video=mpeg4，101s/159s/192s/1075s） |
| 播放稳定性 | 回调内 stop 死锁复现；改 `setTimeout` 后长播无 JS 卡死 |
| 缓存 / 部署 | `/api/ping`、`/api/metrics`、`/userdisk/bili_cache` 文件与 Range/206 请求 |

---

## 10. v2.2.0：自研 native 播放引擎

> 本章记录 v2.2.0 的核心变更：在保留官方 `libjsapi_softvideo.so` 的同时，新增自研 native 模块 `libjsapi_rgavideo.so`，由它直接调用设备自带 FFmpeg 4.4.1 解码视频并输出 RGBA，JS 侧定时轮询取帧后 `putImageData`。§9 的 softvideo 契约、`/api/audio` remux 与预取缓存继续有效，本章只写增量。当前版本 **2.2.0**。

### 10.1 根因：卡顿在 native 解码/转换，不在 JS

daemon 的 `playback cpu` 线程级采样（旧链路，播放 640×360 视频）：

| 采样项 | 单核占用 | 说明 |
|---|---|---|
| 总占用 | **95–98%** | 线程级采样（与 §9.2 的进程级 76–83% 为不同轮次） |
| `video_decoder` | **72–79%** | softvideo 解码 + YUV→RGBA + 回调，绝对大头 |
| JS 主线程 | 17–21% | `putImageData` 与 Falcon 合成 |
| `YAudioModule` | ~1% | 音频不是瓶颈 |
| 实际输出 | **10–12fps** | 与 95–98% 的 CPU 占用严重不匹配 |

同机同文件用设备自带 ffmpeg 对照：

| 方式 | 帧率 | 单核占用 | 单帧耗时 |
|---|---|---|---|
| `ffmpeg` 纯解码 640×360 High@30fps | **115fps** | ~30% | ~10ms |
| `ffmpeg` 解码 + `-vf format=rgba` | **94fps** | ~42% | ~14ms |
| softvideo 旧链路 | 10–12fps | 95–98% | ~80–100ms |

结论：**softvideo 比同机 ffmpeg 低效约 5 倍**，瓶颈在其解码→RGBA→回调链路本身；JS 侧没有丢帧（§9.2 的 `cb/s`=`draws/s`），音频线程只占 ~1%。因此 v2.2.0 的选择是「把解码与转换换成 ffmpeg，JS 只负责取帧提交」，而不是继续调 JS 或 canvas。

### 10.2 模块架构与 JSAPI 契约

**注册链路**（与官方 `libjsapi_nekolib.so` 同一模式）：

```
Falcon dlopen libs/arm/libjsapi_rgavideo.so
  └─ dlsym("custom_init_jsapis") → custom_init_jsapis()
       └─ registerCModuleLoader("rgavideo", rgav_loader)
            └─ JS_NewCModule(ctx, "rgavideo", js_module_init)
                 └─ JS_SetModuleExport(ctx, m, "default", obj)
JS 侧：const rgav = await import('rgavideo')
```

- 模块只导出 `custom_init_jsapis`；`registerCModuleLoader`、`JS_NewCModule`、`JS_NewCFunction2`、`JS_GetArrayBuffer` 等均为**未定义符号（UND）**，由宿主运行时解析，不显式链接 `libfalcon.so` / `libquickjs.so`。官方 `libjsapi_nekolib.so` 的 UND 符号表同样是这些符号，可作对照。
- `js_module_init` 把 8 个 C 函数挂到 `default` 导出对象上，因此 JS 侧拿到的是对象（`rgav.start(...)`），不是具名导出。

**解码线程与双缓冲**：

```
解码线程（C）                                   JS 定时器（16ms）
 avformat_open_input(url)                        readFrame()
 → av_read_frame → avcodec_send/receive            ├─ 有新帧：memcpy 到 JS buffer，返回 1
 → PTS 节奏：按帧时间戳 nanosleep                   └─ 无新帧：返回 0，跳过本 tick
 → 消费不及：最多等 40ms，超时丢帧保节奏           取到帧才 ctx.putImageData(imageData, 0, 0)
 → sws_scale(YUV420P → RGBA) 写入 back buffer
 → have_frame=1（互斥锁保护）
```

**JS 接口**：

| 接口 | 语义 |
|---|---|
| `setBuffer(arrayBuffer, w, h)` | 绑定 RGBA 目标缓冲（= `ctx.getImageData(...).data.buffer`），并校验 `w*h*4 ≤ buffer`；尺寸同时作为输出尺寸 |
| `start(url)` | 打开 `/api/stream` 地址，分配 back buffer、启动解码线程（`thread_count=1`） |
| `readFrame()` | 有新帧则 `memcpy` 进 JS 缓冲并返回 `1`，否则返回 `0` |
| `stop()` | 置停止标志、`pthread_join`、释放缓冲与 URL |
| `info()` | `{width, height, duration, position, finished}`（width/height 为解码源尺寸） |
| `error()` | 最近一次错误字符串（如 `open_input=-…`、`no_video=…`、`eof`） |
| `duration()` / `position()` | 总时长 / 当前播放位置（秒） |

- **不处理音频**：模块内没有音频线程，也没有 ALSA 调用；音频由并行 `SoftVPlayer` 负责（§10.5）。
- 与 softvideo 的关键差异：不再跨线程回调 QuickJS，所有 JS 调用都发生在 JS 线程；native 只写自己的 back buffer，`readFrame()` 里一次性拷走，避免 §9.4 的回调内 `stop()` 死锁类问题。

### 10.3 构建方式（WSL2 + Rockchip 工具链 + 设备 libav）

- **源码 / 产物**：`native/rgavideo.c`（320 行）→ `libjsapi_rgavideo.so` = **13,820 字节**，ARM EABI5 共享库，随 AMR 打入 `libs/arm/`。
- **工具链**：用户提供的 `arm-rockchip830-linux-uclibcgnueabihf-gcc` **8.3.0**，在 **WSL2 Ubuntu 24.04** 内编译。本文 §2.3 记录的默认工具链是 `arm-rockchip1050-…`（GCC 10.5.0）；两者目标 ABI 一致（32 位 ARMv7 hard-float + uClibc-ng），本模块产物已真机加载运行。
- **链接设备自带 FFmpeg 4.4.1**：从设备 `/usr/lib` 拉取 `libavformat.so.58`、`libavcodec.so.58`、`libswscale.so.5`、`libavutil.so.56` 用于**链接**；**不随包携带**，运行期仍由设备 `/usr/lib` 解析（因此包体只增加 13.8KB）。
- 实际编译命令（`scratch/wsl_build_rgavideo.sh`）：

```bash
arm-rockchip830-linux-uclibcgnueabihf-gcc -shared -fPIC -O2 -fvisibility=hidden \
  -I"$BUILD" -I"$BUILD/ffmpeg-4.4.1" \
  -o libjsapi_rgavideo.so native/rgavideo.c \
  -L"$BUILD/devlibs" -lavformat -lavcodec -lswscale -lavutil -lm -lpthread -ldl \
  -Wl,--allow-shlib-undefined -Wl,-s
```

- `--allow-shlib-undefined` 是能链接成功的关键：设备库的间接依赖（如 `libswresample`）不在链接目录里，交给运行期解析；`-fvisibility=hidden` 只导出 `custom_init_jsapis`，避免符号污染。

### 10.4 实测对比

| 指标 | 旧 softvideo 链路（v2.1.0） | 新 native 链路（v2.2.0） |
|---|---|---|
| 输出帧率 | 10–12fps | `[Perf] native draws/s=25–34`（约 **30fps**） |
| 单帧 JS 开销 | `putImageData` 8–14ms | 14–17ms（`readFrame` memcpy + `putImageData`） |
| 帧间隔 `maxgap` | 100–215ms | 58–80ms（偶发 150–394ms） |
| 整机 CPU | 95–98% | 55–82% |
| `video_decoder` | 72–79% | **~3%**（只剩音频 remux 的 160×90 视频轨） |

- 用户真机确认：画面流畅度大幅提升、音频正常。
- 版本与产物：`/api/ping` 返回 `{"version":"2.2.0"}`；`9002000869905604.amr` = **2,633,188 字节（约 2.63MB）**；daemon = **6,094,983 字节（约 6.03MB）**；native 模块 13,820 字节。
- 读法提醒：`draws/s` 是 JS 真正提交的帧数，`maxgap` 是相邻提交间隔；`maxgap` 偶发 150–394ms 说明单核上仍会被调度/网络抖动打断，但平均帧率已从 10–12fps 提到约 30fps。

### 10.5 音频并行与重试

- native 模块**不重写音频**：看视频时并行启动一个 `SoftVPlayer`，播放 `/api/audio?variant=remux`（§9.3：DASH 最高音轨 + ffmpeg 重封装出 160×90@1fps 黑帧视频轨）。
- 失败自动重试两次：首字节到达前软解可能报 `streamDecoder init failed`，重试即恢复；用户已确认真机音频正常。
- 为什么不把音频也放进 native：设备音频链路涉及 `YAudioModule`/HAL 与 `vctl` 音量（§8.2），复用官方软解可保持系统音量联动，改动面最小。
- 代价：多一个 softvideo 实例，但其 `video_decoder` 只处理 160×90@1fps 的黑帧轨，实测降到 ~3% 单核（§10.4）。

### 10.6 回退与 RGA 后续

**安全回退**：起播时先 `import('rgavideo')`；若模块不存在、`setBuffer`/`start` 抛异常或初始化失败，记录日志并自动回退到原 softvideo 视频链路（v2.1.0 行为），保证不会黑屏。回退是运行期判断，不需要换包。

**RGA 尚未接入（明确边界）**：

- 当前 YUV420→RGBA 用 ffmpeg `sws_scale`，**跑在 CPU 上**；模块名虽为 `rgavideo`，本轮没有调用 RGA。
- 设备具备条件：`/dev/rga` 存在，`/usr/lib/librga.so` 导出 `c_RkRgaInit`、`c_RkRgaBlit`、`c_RkRgaGetBufferFd`、`RkRgaGetBufferFd` 等。
- 未接入的原因：RGA 需要 **dma-buf / 连续物理内存**，而当前帧来自 ffmpeg 的普通 `malloc` 缓冲；直接把虚拟地址交给 RGA 不成立。
- 后续路径：在 native 模块内把 back buffer 改为 dma-buf（或 RGA `importbuffer_*` 支持的分配），解码后仅做 `c_RkRgaBlit` 色彩转换，替换 `sws_scale` 这一步即可，JS 契约不变。
- 另一个容易混淆的点：**miniapp 运行时本身不加载 `librga.so`、不打开 `/dev/rga`**，其画布合成是纯 CPU 软件光栅化；文档中「RGA 旋转」指的是 fb/内核显示层把 640×172 画布旋转 270° 写 `/dev/fb0`（§1.1），与本模块的 YUV 转换是两件事。

---

*文档生成：2026-10-24；§7 为前端真机验证，§8 为 daemon v2.0.0 验证，§9 为 v2.1.0 实测补充，§10 为 v2.2.0 native 播放引擎。*
