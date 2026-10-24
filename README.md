# 笔上哔哩 (BiliPen) —— 网易有道词典笔 A7 哔哩哔哩轻应用

> **当前版本**：`v2.2.0`（2026-10-24）
> **目标设备**：网易有道词典笔 A7（型号 `Y09`，AppID `9002000869905604`）
> **技术路线**：Falcon（Vue2 + QuickJS）前端 + Go 守护进程 + 自研 native 视频解码模块（FFmpeg 4.4.1）+ 官方 `libjsapi_softvideo.so`（音频/回退）
> **包体**：AMR 约 2.63MB（2,633,188 字节）；daemon 6.03MB（6,094,983 字节，strip 后）；native 模块 13,820 字节

---

## 0. 当前状态（TL;DR）

**v2.2.0 新增（真机可运行）：原生视频解码引擎 —— 看视频从 10–12fps 提升到 ~30fps**

- **根因定位**：线程级 CPU 采样显示，旧链路 `video_decoder`（softvideo 解码/转换）占 **72–79% 单核**，JS 渲染仅 17–21%；同一设备 ffmpeg 解同一文件只要 30%（解码）/42%（解码+RGBA），即 softvideo 比 ffmpeg 低效约 5 倍。
- **自研 `libjsapi_rgavideo.so`**（13.8KB，用 Rockchip `arm-rockchip830-linux-uclibcgnueabihf-gcc 8.3.0` 交叉编译）：FFmpeg 4.4.1 软件解码 + `sws_scale` YUV420→RGBA + 双缓冲 + PTS 节奏与丢帧；通过 `registerCModuleLoader` 注册 QuickJS 模块 `rgavideo`，导出 `custom_init_jsapis`，接口为 `setBuffer(ab,w,h)/start(url)/readFrame()/stop()/info()/error()`，由 JS 每 16ms 轮询取帧后 `putImageData`。
- **音频不重写**：看视频时并行启动一个 `SoftVPlayer` 播放 `/api/audio?variant=remux`（DASH 最高音轨 + ffmpeg 重封装），失败自动重试两次；音频正常。
- **回退安全**：模块 `import` 失败或初始化异常时自动回退到原 softvideo 视频链路。
- **实测**：`[Perf] native draws/s=25–34`（约 30fps），单帧 14–17ms；整机 CPU 55–82%（原链路 95–98% 且仅 10–12fps）。

**v2.1.0 新增（真机可运行）：**

- 视频详情页 —— 点任意卡片先进入全屏详情页（640×172，左上「← 返回」），展示封面/标题/UP/时长/播放量，三个按钮「▶ 看视频」「🎧 听视频」「⬇ 下载」（下载为占位，点击仅提示「下载功能占位，暂未开放」）。
- 搜索页自绘屏幕键盘 —— 移除热点搜索 chips，改为 4 行屏幕键盘（原生软键盘在该机型不弹出），顶部实时预览输入内容。
- 覆盖层穿透修复 —— 详情页/播放层/键盘显示时不再渲染底层首页，点击不会再落到未渲染的卡片上。
- 听视频 —— 取 B 站 DASH 最高码率音轨，由 daemon 调设备自带 `/usr/bin/ffmpeg` 重封装为带 160×90 黑帧视频轨的分片 MP4 后推流（纯音频 m4s 原生解不了）。
- 网络/缓存 —— 详情页打开即整段预取到 `/userdisk/bili_cache`（600MB / 7 天，启动时 LRU 清理），`/api/stream` 缓存优先并支持 Range/206，失败回退实时代理；播放期间后台预取限速 512KB/s。
- 播放层「铺满/适应」切换；播放期间每 2s 一条 `[Perf]` 诊断日志。

**v2.0.0 已修复并在真机验证通过：**

- 视频横向/斜向条纹 —— 根因是 `onInfo` 参数顺序错误 + 视频宽度不总是 640 导致的 stride 错位；通过修正参数顺序并在起播前 `setVideoInfo(640,360)` 解决。
- 退出播放崩溃/音频线程泄漏 —— 根因是 `.on(null)` 非法解绑导致 `vPlayer.stop()` 被跳过；改为 `sig.off(token)` + 播放代次锁，teardown 完整。
- 长视频播放 2 分钟必断 —— `/api/stream` 的 120s 总超时改为上下文 + 45s 空闲看门狗。
- 改完代码「没生效」 —— A/B 双槽双 daemon、旧进程常驻、版本不可知；改为单实例 + `killall` + `/api/ping` 版本校验。
- 扫码登录可能写空 Cookie、Cookie 明文 0644、上游错误被吞、封面半截缓存等问题。

**已知限制（见 §8）：** v2.2.0 起看视频约 30fps（native 引擎），RGA 尚未用于 YUV→RGBA 转换（当前用 ffmpeg `sws_scale`，若后续接入 RGA 可再降 CPU）；搜索键盘只能输入英文/数字，中文输入暂不可用；「⬇ 下载」为占位按钮；显示有「铺满/适应」两种策略（适应=306×172 letterbox，官方播放器同款）；扫码登录成功链路待真实扫码验证；本地 18080 未做鉴权（按项目决定暂不实现）；设备 UI 偶发触摸无响应/画面冻结（系统层，与本应用无关）。

---

## 1. 项目概述

**笔上哔哩（BiliPen）** 是为**网易有道词典笔 A7** 定制的第三方哔哩哔哩客户端，在极度受限的嵌入式环境下实现：视频播放、视频详情页、看/听双模式、推荐流、搜索（含自绘屏幕键盘）、扫码登录、系统音量联动。

### 1.1 硬件与系统平台规格

| 参数项 | 硬件 / 软件规格 |
| :--- | :--- |
| **设备型号** | 网易有道词典笔 A7（SKU：`OVERHEAD_Y09_SKU_CHN_PRO`） |
| **处理器 (SoC)** | Rockchip RV1106，单核 ARM Cortex-A7 @ 1.0GHz（NEON / VFPv4，hard-float） |
| **内存 (RAM)** | 128MB DDR2（可用约 92.7MB；QuickJS 堆仅 1–3MB） |
| **操作系统** | 嵌入式 Linux 5.10.160-rockchip + uClibc-ng 32 位（无 glibc） |
| **屏幕** | 逻辑 640×172（3.72:1）；物理 fb0 为 172×640 RGB565，RGA 旋转 270° 输出；fps ≤45 |
| **前端运行环境** | 网易 Falcon 轻应用引擎（定制 Vue 2.x + QuickJS 2020-07-05） |
| **音频** | Rockchip Codec（LINEOUT 驱动喇叭）+ 网易 HAL（`libydhal_audio.so` / `libyddal_*`） |
| **应用标识** | `9002000869905604`（安装包 `.amr` = ZIP + manifest 逐文件 md5 校验） |
| **官方参考应用** | 官方视频播放器 AppID `8001661999525016`（验证播放链路的对照实现） |

---

## 2. 整体系统架构

项目由三层构成：**Falcon 前端界面层**、**应用内 C++ 原生插件（软解/Shell）**、**Go 本地守护进程 `bili-daemon`**。

```mermaid
flowchart TD
    subgraph Frontend["Falcon 前端 (QuickJS / Vue 2.x)"]
        UI["首页 UI (推荐 / 搜索 / 扫码登录)"]
        DetailPage["视频详情页 (640×172)"]
        KeyBoard["自绘屏幕键盘 (4 行)"]
        CanvasPlayer["Canvas 2D 播放器 (WXCanvas)"]
        HttpAPI["Falcon HTTP 客户端"]
    end

    subgraph NativePlugins["C++ 原生动态库 (libs/arm)"]
        SoftVideo["libjsapi_softvideo.so (SoftVPlayer)"]
        NekoLib["libjsapi_nekolib.so (Shell 执行引擎)"]
    end

    subgraph Daemon["Go 守护进程 (bili-daemon:18080)"]
        ProxyRouter["HTTP 路由 (/api/feed /detail /audio /stream ...)"]
        BiliClient["B 站接口 (Passport 扫码 / playurl / DASH 音轨)"]
        CoverCache["封面并发下载与缓存 (并发≤3)"]
        VolumeReader["只读 vctl 共享内存 (系统音量展示)"]
        AudioRemux["ffmpeg 音频 remux (音频 copy + 160×90 黑帧)"]
        Prefetch["整段预取缓存 (/userdisk/bili_cache, 600MB/7天)"]
    end

    subgraph HardwareHAL["设备底层驱动与系统服务"]
        TinyALSA["Rockchip Codec (tinymix：LINEOUT 增益)"]
        ShmMem["SysV 共享内存 vctl (key 0x7663746c)"]
        YAudioModule["网易 HAL 音频模块 (libydhal_audio.so)"]
    end

    subgraph Cloud["哔哩哔哩云端服务"]
        BiliWeb["B站 Web API (api.bilibili.com)"]
        BiliPassport["B站通行证 (passport.bilibili.com)"]
        BiliCDN["B站 CDN 媒体流 (360P MP4 / DASH)"]
    end

    UI -->|点卡片| DetailPage
    UI -->|页面交互| CanvasPlayer
    UI -->|搜索页| KeyBoard
    DetailPage -->|▶ 看视频 / 🎧 听视频| CanvasPlayer
    DetailPage -->|/api/detail 预取 + /api/audio| ProxyRouter
    UI -->|127.0.0.1:18080| ProxyRouter
    NekoLib -->|nekolib.shell.exec 拉起| Daemon
    CanvasPlayer -->|setVideoInfo / setImageDataBuffer / onDrawFrame| SoftVideo
    SoftVideo -->|YAudioModule 输出| YAudioModule
    SoftVideo -->|HTTP 拉流 (/api/stream 缓存优先)| ProxyRouter

    ProxyRouter --> BiliClient
    ProxyRouter --> CoverCache
    ProxyRouter --> AudioRemux
    ProxyRouter --> Prefetch
    BiliClient --> BiliWeb
    BiliClient --> BiliPassport
    ProxyRouter -->|Range/206 转发| BiliCDN
    AudioRemux -->|/usr/bin/ffmpeg remux| BiliCDN
    Prefetch -->|整段预取| BiliCDN

    YAudioModule -->|读取音量| ShmMem
    VolumeReader -->|只读| ShmMem
    Daemon -->|启动时锁 LINEOUT 增益| TinyALSA
```

---

## 3. 核心功能模块

### 3.1 视频播放引擎（Canvas 2D + SoftVPlayer）

**渲染通路（v2.0.0 修复后的正确时序，v2.1.0 补充显示策略）：**

1. `<canvas>` 的 attrs 必须显式声明 `width="640" height="360"`（Falcon 仅在 attrs 存在时才更新物理位图宽度，否则退化为默认 300×150）。
2. `createCanvasContext(canvas)` 取 2D Context。
3. `setVideoInfo(640, 360)` —— **起播前必须调用**，让 JS 侧 buffer 与解码输出尺寸对齐。注意：它**不改变**原生实际输出尺寸（探针实测仍按整帧 640×360 写满，见 §4.7），不能用来降低输出分辨率。
4. `imageData = ctx.getImageData(0, 0, 640, 360)`；`vPlayer.setImageDataBuffer(imageData.data.buffer)`。
5. `vPlayer.start('http://127.0.0.1:18080/api/stream?bvid=...')`。
6. 每帧 `onDrawFrame` 回调中 `ctx.putImageData(imageData, 0, 0)`（实测每帧 8–14ms）。
7. 显示层：v2.1.0 起播放层右上角可切「铺满/适应」。**铺满**=1:1 像素、上下裁剪（默认）；**适应**=完整画面缩放到 306×172 居中（letterbox，与官方播放器一致）。

**软解 API 契约（真机 + 反汇编确认）：**

| 接口 | 契约 |
| :--- | :--- |
| `onInfo(cb)` | 回调参数为 **(width, height, duration)**，duration 单位秒。误按 `(duration,width,height)` 解构会导致 buffer 尺寸错乱与堆越界。 |
| `setVideoInfo(w, h)` | 必须在 `start()` 前调用；否则流宽度≠buffer 宽度时逐行错位产生条纹（实测存在 576×360 视频）。 |
| 信号 `.on(cb)` | 返回 **number 类型 token**；`.on(null)` 抛 `TypeError: arg 1 must be function`。 |
| 信号 `.off(token)` | 正确解绑方式；无 `.clear()` / `.connect()`。 |
| `setImageDataBuffer(buf)` | 传 `imageData.data.buffer`，native 按 `w*h*4` 写 RGBA。 |
| `stop()` | 正常时序：stop → flushQueue → audio_thread end → video_thread end → streamDecoder exit → uninit → closeAudioDevice → YAudioModule uninit。 |

### 3.2 本地守护进程 (`bili-daemon`)

- **运行位置**：ARMv7 静态二进制，随包释放到 `/userdisk/secondary/miniapp/data/mini_app/pkg/9002000869905604/{a,b}/libs/bili-daemon`。
- **自拉起**：启动时 `nekolib.shell.exec` 执行 `killall bili-daemon` → 选最新安装槽 → `chmod +x` → 后台拉起；日志落 `/userdisk/bili_daemon.log`。
- **API 一览**：

| 接口 | 说明 |
| :--- | :--- |
| `GET /api/ping`、`/api/health` | `{status, version, pid, uptime}`，用于部署校验与新老版本判断（v2.1.0 实测返回 `{"version":"2.1.0"}`） |
| `GET /api/feed` | B 站推荐流（`fresh_idx` 翻页），封面并发缓存 |
| `GET /api/trending` | 搜索热词（前端 v2.1.0 起不再渲染热点 chips） |
| `GET /api/search?keyword=` | 综合搜索（视频） |
| `GET /api/detail?bvid=BV...` | 视频详情 JSON：`bvid,title,owner,pic,pic_local,duration,desc,view,like,danmaku,cid,dimension:{width,height}`；打开同时后台整段预取。非法 bvid→400，解析失败→502 |
| `GET /api/play?bvid=&title=&mode=video\|audio` | 登记播放会话（bvid 正则校验），`mode` 区分看视频/听视频，返回 `{status:"playing"}` |
| `GET /api/stop` | 结束播放会话 |
| `GET /api/status` | `{playing, bvid, title, volume, mode}`（volume 读自 vctl 共享内存） |
| `GET /api/user/info` | 通过 nav 接口校验登录态（仅 `-101` 时清 Cookie） |
| `GET /api/login/qr` | 生成二维码 PNG + `qrcode_key` |
| `GET /api/login/poll?qrcode_key=` | 轮询扫码结果；成功时从 `data.url` query + `Set-Cookie` 提取凭证并原子落盘 |
| `GET /api/login/logout` | 清除 Cookie |
| `GET /api/stream?bvid=` | 缓存优先：命中 `/userdisk/bili_cache` 直接回本地文件（Range/206 透传）；未命中走 360P MP4 实时代理，失败回退 `backup_url`，45s 空闲看门狗 |
| `GET /api/audio?bvid=&variant=remux\|raw` | 流式 MP4（`remux`，音频 copy + 160×90 视频轨）或音频 m4s（`raw`，实测原生不支持）；非法 bvid→400 |
| `GET /api/metrics` | 诊断 JSON：`version,uptime,load1,mem_available_kb,spools:[{bvid,have,total,done}],counters:{stream_bytes,audio_bytes,cache_fallbacks,stream_stalls,cache_hits}` |

- **媒体流代理**：`playurl`（`qn=16&type=mp4&platform=html5`）+ **10 分钟 URL 缓存**；Range 透传；上游非 200/206 或 HTML 错误页直接拒绝并尝试 backup。
- **本地缓存（v2.1.0）**：详情页打开即整段预取到 `/userdisk/bili_cache`（上限 600MB、7 天过期，启动时 LRU 清理）；`/api/stream` 优先读本地缓存（支持 Range/206），失败自动回退实时代理；播放期间后台预取限速 512KB/s，避免与单核解码抢 CPU。
- **音频 remux（v2.1.0）**：`/api/audio` 由设备自带 `/usr/bin/ffmpeg` 把 DASH 最高码率音轨重封装为带 160×90@1fps 黑帧视频轨的分片 MP4（音频 `-c:a copy`），因为原生播放器打不开纯音频 m4s。

### 3.3 账号体系与扫码登录

1. daemon 调 `passport.bilibili.com/.../qrcode/generate` 取 `qrcode_key`，本地生成二维码 PNG。
2. 前端每 2s 轮询 `/api/login/poll`。
3. 扫码成功后：从响应 `data.url` 的 query 参数（SESSDATA / bili_jct / DedeUserID 等）与 `Set-Cookie` 同时收集凭证 → `saveCookie` 原子写 `/userdisk/bili_cookie.txt`（0600）。
4. 用户中心展示昵称/头像/UID，支持一键退出。
5. `refresh_token` 另存为 `bili_cookie.txt.refresh`（0600）。

### 3.4 系统音量联动（机制已更正）

- 系统音量通过 SysV 共享内存 `vctl`（key `0x7663746c`）传递；实测 u32 布局：`[110, 50, 80, 80, 80, 80]`，**offset 4 即扬声器音量（0–100）**。
- **音量由 `libydhal_audio.so` 直接读 vctl 生效**，应用无需写 ALSA 主音量。
- 本机型 card0 仅有 0–24 号控件（23=`DAC LINEOUT Volume` 0–30，24=`DAC HPMIX Volume`），**不存在 25 号 / Master Playback Volume**——旧实现写控件 25 一直静默失败，但音量仍由 HAL 正常工作。
- v2.0.0 做法：daemon 读取 vctl 用于 `/api/status` 展示；启动时锁 `DAC LINEOUT Volume=16` 防削波；音量线程探测到可写控件才写（否则只读并提示一次）。

### 3.5 封面缓存加速

- B 站封面有防盗链且尺寸大：追加 `@200w_120h.jpg` 拉缩略图，缓存到 `/userdisk/.../data/covers/{bvid}.jpg`。
- 并发上限 3（单核 A7 避免多 TLS 抖动）；先写 `.tmp` 再 rename，避免缓存半截 JPEG。

### 3.6 视频详情页与播放层（v2.1.0）

- 点任意视频卡片先进入**全屏详情页**（640×172，左上角「← 返回」），显示封面、标题、UP 主、时长、播放量，以及三个按钮：**「▶ 看视频」「🎧 听视频」「⬇ 下载」**。
- **「⬇ 下载」为占位按钮**：点击仅提示「下载功能占位，暂未开放」，不发起任何请求。
- 详情页打开即触发整段预取（见 §3.8）。
- 播放层右上角新增**「铺满/适应」**切换：铺满 = 1:1 像素、上下裁剪（默认）；适应 = 完整画面缩放到 306×172 居中。
- 覆盖层（详情页/播放层/键盘）显示时**不再渲染底层首页**，避免点击穿透到不可见的卡片（见 §4.6）。
- 诊断：播放期间每 2s 打印一条 `[Perf] cb/s=… draws/s=… avg=…ms maxgap=…ms out=WxH`。

### 3.7 听视频（DASH 音轨 + ffmpeg remux）

- 音轨选择：从 B 站 DASH 音频流中取 `30280/30232/30216` 里 `bandwidth` 最大者（实测样本 30280 ≈ 162–196kbps）。
- **不能直接把纯音频 m4s 交给软解**：实测日志 `streamDecoder init failed`，原生播放器必须有视频轨。因此由 daemon 调设备自带 `/usr/bin/ffmpeg` 重封装为**分片 MP4**：音频 `-c:a copy` + 160×90@1fps `mpeg4` 黑帧视频轨，再推流给播放器。
- `/api/audio?bvid=...&variant=remux|raw` 提供两个变体；`raw`（纯音频 m4s）实测原生不支持，仅作对照。
- remux 对 4 个样本视频均成功（`ffprobe`：audio=aac、video=mpeg4，时长 101s/159s/192s/1075s 与源一致）。
- 听视频（不渲染视频）时音频流畅；加入视频渲染后音频也会一卡一卡（见 §4.8）。

### 3.8 预取与本地缓存（v2.1.0）

- 详情页打开即把整段视频预取到 `/userdisk/bili_cache`：**上限 600MB、7 天过期**，daemon 启动时按 LRU 清理。
- `/api/stream` **优先读本地缓存文件**（支持 Range/206），失败自动回退实时代理。
- 播放期间后台预取**限速 512KB/s**，避免与单核解码抢 CPU。

### 3.9 搜索页：自绘屏幕键盘（v2.1.0）

- 移除搜索页的热点搜索（chips）；改为**自绘屏幕键盘**，4 行布局：`qwertyuiop` / `asdfghjkl`+`⌫` / `zxcvbnm`+空格+清空+搜索 / `0-9`；顶部实时预览输入内容。
- 原因：该机型 miniapp **原生软键盘不弹出** —— 实测 `focus` 事件会触发、`focus`/`inputMethod` 方法存在且已调用，但输入面板不出现（详见平台手册第 10 章）。
- **已知限制：只能输入英文/数字，中文输入暂不可用。**

---

## 4. 关键技术攻坚（结论版）

### 4.1 视频横向/斜向条纹

**现象**：画面出现密集斜向扫描线/错位，无法辨识。

**根因（三重叠加）**：

1. **`onInfo` 参数顺序错误**（致命）：库发射 `(width, height, duration)`，旧前端按 `(duration, width, height)` 解构 → `vWidth=360, vHeight=视频时长秒`。于是 `getImageData(0,0,360,133)` 只分配 191KB，而 native 按 640×360×4=921KB 写入 → **4.8 倍堆越界**；`scale(172/133)≈1.29` 又把画面放大 2.7 倍。
2. **视频宽度不总是 640**：B 站 360P 部分视频为 576×360；固定按 640 分配 buffer 会让 native 以 576×4 行宽写入 640×4 stride → 每行错位 64px，即使参数顺序正确也仍有条纹。
3. **Canvas 位图宽度依赖 attrs**：Falcon 仅在 `attrs` 显式存在 `width` 时才更新物理位图宽度（否则默认 300×150），属历史隐患。

**修复**：`onInfo` 改正确顺序并做尺寸夹紧；起播前 `setVideoInfo(640,360)` 对齐 JS 侧 buffer 与解码输出；canvas attrs 固定 640×360。（v2.1.0 探针补充：`setVideoInfo` 只对齐尺寸声明、**不改变**原生实际输出尺寸，仍按整帧 640×360 写满，详见 §4.7。）

**验证**：真机日志 `onInfo width=640 height=360 duration=341`；连续截图无条纹、字幕逐帧推进。

### 4.2 退出播放崩溃 / 音频线程泄漏

**根因**：旧 `stop()` 用 `.on(null)` 解绑，真机抛 `TypeError: arg 1 must be function`，抛出后 `vPlayer.stop()` 被跳过 → 解码/音频线程泄漏、可能写已销毁 canvas。

**修复**：记录 `.on()` 返回的 token，停止时 `sig.off(token)`；`vPlayer.stop()` 放在无条件路径；引入 `playGen` 代次锁与定时器取消，避免退出后仍起播。

**验证**：真机 teardown 日志完整（stop → flushQueue → 线程退出 → uninit → closeAudioDevice），无异常。

### 4.3 音频无声（历史问题，已恢复官方库）

早期补丁版 `libjsapi_softvideo.so` 在 `0x140b8` 把 `YAudioModule::setRate` 的 `r1`（应为 `0xac44`=44100Hz）写坏成 `movw fp, #0xb780`。恢复官方原厂库（MD5 `8bde3e91579d7b6b86ad1ff5b68f2fb0`）后音频恢复正常。

### 4.4 长视频 2 分钟必断

旧 `/api/stream` 用 `http.Client{Timeout:120s}`，覆盖 body 读取阶段，>2 分钟视频必被截断。v2.0.0 改为 `r.Context()` + Transport 连接/响应头超时 + **45s 空闲看门狗**（正常播放不受总时长限制）。

**验证**：限速 25KB/s 拉取 683s 长视频，持续 **160.0s** 未断，`http=200 size=4,096,560`。

### 4.5 「改了没生效」：daemon 版本错配

旧实现每次启动同时拉起 `a/`、`b/` 两个 daemon，后启动者 `bind: address already in use` 退出；且设备**没有 `pkill`**（只有 `killall`），旧进程不会被清理，导致新前端连到旧后端。

**修复**：bootstrap 先 `killall bili-daemon`，按安装槽启动；`/api/ping` 返回版本，前端启动时打印并校验。

### 4.6 覆盖层穿透（历史遗留 bug）

详情页/播放层/键盘都是覆盖在首页之上的绝对定位层。旧实现只做视觉遮挡，底层首页仍在渲染树中，触摸会落到被遮住的卡片上。v2.1.0 改为**覆盖层显示时不渲染首页**，穿透命中区自然消失；退出覆盖层再恢复渲染。

### 4.7 `setVideoInfo(w,h)` 不控制软解输出尺寸（探针实测）

**结论**：`setVideoInfo` 只影响 JS 侧期望值，**不改变原生解码输出尺寸**。

**探针**：build 时设 `setVideoInfo(320,180)`，缓冲区仍按 640×360 分配（921,600 字节）。播放后对该缓冲区分四段采样，非零计数为 `14400, 14400, 14400, 13652` —— 每段都被写满，说明原生仍按整帧 640×360 写入。若真按 320×180 分配 buffer（230,400 字节）会直接写越界。

**影响**：不能用「降低输出分辨率」减少每帧开销；显示分辨率固定 640×360，「铺满/适应」都基于该 buffer。

### 4.8 卡顿：瓶颈在原生解码→渲染链路（未完全解决）

- 实测 `cb/s` 与 `draws/s` 相等且只有 **6–12**，`maxgap` **100–215ms**；单帧 `putImageData` 仅 8–14ms。
- 播放期间 daemon 每 2s 采样 miniapp 进程 CPU：**76–83% 单核**（按帧折算约 80ms/帧），说明大头在原生解码/合成，而不是 JS 绘制。
- 同一设备 `ffmpeg` 纯软解 640×360 High@30fps 可达 **115fps**（utime 4.45s/20s ≈ 22% 单核）；加 `-vf format=rgba` 后 **94fps（31% 单核）**。
- 结论：瓶颈在原生播放器的解码→渲染链路 / 单核调度（softvideo 在此硬件上的实际上限约 10–12fps）；听视频（不渲染视频）时音频流畅，加入视频渲染后音频也会一卡一卡。

### 4.9 回调内同步 `stop()` 会死锁

不能在原生回调（`onError`/`onInfo`/`onComplete`）里同步调用 `player.stop()`：会与解码线程互锁，导致 JS 线程卡死。改为 `setTimeout(0)` / `setTimeout(300)` 延后执行。

### 4.10 非 16:9 视频：按实际解码尺寸自动重开一次

旧逻辑在 `onInfo` 报出的尺寸与 640×360 不符时直接中止；新逻辑在 `onInfo` 报出实际解码尺寸（如 640×320、480×360）时，**按该尺寸自动重开一次**（stop → 重建 buffer → `setVideoInfo` → start）。

---

## 5. 项目代码清单

| 文件 | 说明 |
| :--- | :--- |
| [build_bili.py](build_bili.py) | 唯一构建入口：自动交叉编译 daemon → 生成 `bili_pkg/app.js` → 计算 cert → 打包 `.amr` |
| [bili_src/main.go](bili_src/main.go) | daemon 源码（HTTP API、B 站交互、流代理、封面缓存、音量读取） |
| [bili_src/bili-daemon](bili_src/bili-daemon) | 交叉编译产物（ARMv7 静态，6.03MB，6,094,983 字节，strip） |
| [bili_pkg/app.js](bili_pkg/app.js) | 前端逻辑（由 `build_bili.py` 生成，**不要直接改**） |
| [bili_pkg/manifest.json](bili_pkg/manifest.json) | AppID / quickjs 版本 / 逐文件 cert |
| [libjsapi_softvideo.so](libjsapi_softvideo.so) | 官方原厂软解库（音视频解码 + YAudioModule 输出） |
| [libjsapi_nekolib.so](libjsapi_nekolib.so) | 自研 C 扩展，提供 `shell.exec` 拉起 daemon |
| [app_icon.png](app_icon.png) | 应用图标 |
| [9002000869905604.amr](9002000869905604.amr) | 构建产物（2,625,089 字节 ≈ 2.62MB，version 2.1.0） |
| [BiliPen-审计与改进方案.md](BiliPen-审计与改进方案.md) | 完整审计、缺陷清单、根因与路线对比 |
| [CHANGELOG.md](CHANGELOG.md) | 版本更新记录 |
| [网易有道A7词典笔软硬件全栈与Miniapp_AMR开发技术手册.md](网易有道A7词典笔软硬件全栈与Miniapp_AMR开发技术手册.md) | 平台逆向手册（含 §9 实测补充、第 10 章 v2.1.0 补充） |
| [笔上哔哩_开发技术手册.md](笔上哔哩_开发技术手册.md) | 早期「方案 B（原生 C 扩展）」设计稿，未落地（文末含 v2.1.0 差异摘要） |
| `scratch/` | 逆向分析脚本与官方播放器字节码（开发用，不参与打包） |

---

## 6. 构建与部署

### 6.1 编译 Go 守护进程

`build_bili.py` 会自动检测本机 `go` 并交叉编译（`GOOS=linux GOARCH=arm GOARM=7 CGO_ENABLED=0`，`-trimpath -ldflags "-s -w -buildid="`）。手动方式：

```bash
cd bili_src
GOOS=linux GOARCH=arm GOARM=7 CGO_ENABLED=0 \
  go build -trimpath -ldflags "-s -w -buildid=" -o bili-daemon main.go
```

### 6.2 打包 AMR

```bash
python build_bili.py
```

输出 `9002000869905604.amr`（约 2.62MB，2,625,089 字节），同时更新 `bili_pkg/manifest.json` 的 cert。

### 6.3 部署到设备

```bash
# 1. 上传（/tmp 可能被系统清理，建议 /userdisk）
adb push 9002000869905604.amr /userdisk/9002000869905604.amr

# 2. 停旧 daemon（设备只有 killall，没有 pkill）
adb shell "killall bili-daemon 2>/dev/null"

# 3. 静默安装
adb shell "miniapp_cli install /userdisk/9002000869905604.amr"

# 4. 启动应用（应用会自动 chmod + 拉起新槽 daemon）
adb shell "miniapp_cli start 9002000869905604"

# 5. 校验版本（关键！确保连到新 daemon）
adb shell "curl -s http://127.0.0.1:18080/api/ping"
# 期望：{"version":"2.1.0",...}（真机实测返回 {"version":"2.1.0"}）
```

> Windows **Git Bash** 下 `adb push/shell` 的绝对路径会被 MSYS 改写（推送会“成功”但文件不在设备上）；
> 请使用 PowerShell，或加 `MSYS_NO_PATHCONV=1` 前缀。

---

## 7. 维护与调试

1. **前端/系统日志**（含 `[SoftVPlayer]`、`[BiliPen]`、`[Perf]` 前缀）：
   ```bash
   # 真机实测：miniapp 原生日志按 syslog 汇总在 DictPen_*.log
   adb shell "ls -t /userdata/applog/DictPen_*.log | head -1"
   adb shell "tail -f /userdata/applog/DictPen_*.log"
   ```
   > 旧文档写的 `/userdata/applog/YD_PEN_APP.log` 在该机型不一定存在，以 `DictPen_*.log` 为准。
2. **daemon 日志**（每次启动被覆盖）：
   ```bash
   adb shell "tail -f /userdisk/bili_daemon.log"
   ```
3. **健康检查 / 版本**：
   ```bash
   adb shell "curl -s http://127.0.0.1:18080/api/ping"
   ```
4. **诊断指标（v2.1.0）**：
   ```bash
   adb shell "curl -s http://127.0.0.1:18080/api/metrics"
   # version/uptime/load1/mem_available_kb、各预取 spools、stream/audio 计数
   ```
5. **播放性能**：前端播放期间每 2s 打印 `[Perf] cb/s=… draws/s=… avg=…ms maxgap=…ms out=WxH`；`cb/s` 与 `draws/s` 相等且仅 6–12 即为当前卡顿特征（见 §4.8）。
6. **截图**（注意：屏幕/合成器冻结时可能返回旧帧，按键注入可强制刷新）：
   ```bash
   adb shell "miniapp_cli capture /tmp/screen.png" && adb pull /tmp/screen.png .
   adb shell "miniapp_cli injectKey 116"   # 强制刷新/唤醒
   ```
7. **触摸注入**（Type-B 多点触摸，`scratch/tap.pl`）：
   ```bash
   adb push scratch/tap.pl /tmp/tap.pl && adb shell "perl /tmp/tap.pl 150 100"
   ```
8. **重置登录态**：
   ```bash
   adb shell "rm -f /userdisk/bili_cookie.txt /userdisk/bili_cookie.txt.refresh"
   ```
9. **UI 偶发触摸无响应/画面冻结**：再执行一次 `miniapp_cli start 9002000869905604`，或按电源键切换屏幕。

---

## 8. 已知问题与后续计划

| 项 | 状态 | 说明 |
| :--- | :--- | :--- |
| 播放卡顿 | **未完全解决** | 实测 `cb/s` 与 `draws/s` 相等且仅 6–12，`maxgap` 100–215ms；同机 `ffmpeg` 纯软解 640×360 High@30fps 可达 115fps（utime 4.45s/20s ≈ 22% 单核），瓶颈在原生解码→渲染链路/单核调度，不在 JS 丢帧；听视频（不渲染）音频流畅，加视频渲染后音频也卡 |
| 显示比例 | 可切换 | 「铺满」= 1:1 像素、上下裁剪（默认）；「适应」= 640×360 缩放到 306×172 居中（letterbox，与官方播放器一致） |
| 软解输出尺寸 | 设计受限 | `setVideoInfo` 不改变原生输出尺寸（探针实测仍写满 640×360 buffer），无法用 320×180 降低每帧开销，否则写越界 |
| 搜索中文输入 | **已知限制** | 自绘键盘只能输入英文/数字；原生软键盘在该机型不弹出（`focus`/`inputMethod` 存在且已调用，输入面板不出现） |
| 「⬇ 下载」按钮 | 占位 | 点击仅提示「下载功能占位，暂未开放」，未实现真实下载 |
| ffmpeg 硬解 | 不可用 | 设备 `/usr/bin/ffmpeg 4.4.1` 编入 `h264_v4l2m2m`，但实测 `Could not find a valid device`，只能软解 |
| 扫码登录成功链路 | **待真机验证** | 需要真实扫码一次，验证 `data.url` 凭证提取 + 0600 原子落盘 + 用户信息刷新 |
| 本地 18080 鉴权 | 暂不实现 | 项目决定跳过；如需可在前端注入 token + daemon 校验 |
| 设备 UI 触摸/渲染冻结 | 系统层，待排查 | 与本应用无直接关系；临时用 `miniapp_cli start` 或电源键恢复 |
| 退出按钮位置 | 待优化 | 位于屏幕顶边（y≈14–20），易与系统边缘手势冲突，建议下移或加高标题栏 |
| 无单元测试/CI | 待补 | 当前依赖真机回归；建议为 daemon 增加 API 契约测试 |

---

## 9. 版本历史

| 版本 | 日期 | 摘要 |
| :--- | :--- | :--- |
| v2.1.0 | 2026-10-24 | 视频详情页 + 看/听双模式；搜索页自绘屏幕键盘（原生软键盘不弹，仅英文/数字）；覆盖层穿透修复；ffmpeg 音频 remux（音频 copy + 160×90 黑帧轨）；整段预取 + 本地缓存（600MB/7 天/LRU，512KB/s 限速）；铺满/适应切换；新增 `/api/detail`、`/api/audio`、`/api/metrics`；AMR 2.62MB / daemon 6.03MB。已知：卡顿未完全解决、中文输入不可用 |
| v2.0.0 | 2026-10-24 | 修复条纹（onInfo/setVideoInfo）、退出崩溃（off(token)）、长视频截断、daemon 版本错配；包体 4.69→2.56MB；daemon 8.2→5.9MB；daemon v2 API（version/ping/health、playurl 缓存、Range/206、Cookie 加固） |
| v1.0.0 | 2026-10-24 | 首个可运行版本：推荐流/搜索/扫码登录/播放/音量联动 |

详细变更见 [CHANGELOG.md](CHANGELOG.md)。

---

## 版权与免责声明

- 本项目为个人学习与研究用途，与哔哩哔哩、网易有道均无关联。
- 仓库内的 `libjsapi_softvideo.so`、`libjsapi_nekolib.so`、`app_icon.png` 等为设备/官方应用自带资源，版权归原权利人，仅用于在本设备上进行技术研究；请勿用于商业用途或再分发受版权保护的内容。
- 扫码登录使用你自己的 B 站账号，Cookie 仅保存在设备本地（`/userdisk/bili_cookie.txt`，0600）。

*文档更新：2026-10-24（v2.2.0 真机验证后）。*
