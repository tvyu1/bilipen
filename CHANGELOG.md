# CHANGELOG

本项目版本以 AMR 包内 `manifest.version` 与 `bili-daemon` 的 `/api/ping.version` 双处对齐。

---

## v2.2.0（2026-10-24）

> 主题：自研 native 视频解码模块，看视频 10–12fps → **~30fps**。
> 验证方式：真机日志 `[Perf] native draws/s=25–34`、daemon 线程 CPU 采样、用户确认画面流畅且音频正常。

### 新增

- **`libjsapi_rgavideo.so`**（13,820 字节）：用 Rockchip `arm-rockchip830-linux-uclibcgnueabihf-gcc 8.3.0` 交叉编译，链接设备自带 FFmpeg 4.4.1（libavformat/libavcodec/libswscale/libavutil）。内部实现：FFmpeg 软件解码 + `sws_scale` YUV420→RGBA + 双缓冲 + PTS 节奏与丢帧；通过 `registerCModuleLoader("rgavideo", …)` 注册 QuickJS 模块、导出 `custom_init_jsapis`；JS 接口 `setBuffer(ab,w,h) / start(url) / readFrame() / stop() / info() / error() / duration() / position()`，前端每 16ms 轮询取帧后 `putImageData`。
- **看视频音频并行方案**：native 视频解码的同时，用 `SoftVPlayer` 播放 `/api/audio?variant=remux`（DASH 最高音轨 + ffmpeg 重封装），失败自动重试两次。
- **安全回退**：`import('rgavideo')` 失败或初始化异常时自动回退 softvideo 视频链路。

### 修复

- **播放卡顿根因定位**：线程级 CPU 采样显示旧链路 `video_decoder` 占 **72–79% 单核**（JS 渲染仅 17–21%）；同机 ffmpeg 解同一文件仅 30%（解码）/42%（解码+RGBA），softvideo 低效约 5 倍。新 native 链路把解码交给 ffmpeg。
- **音频 remux 起播竞态**：首字节到达前软解可能报 `streamDecoder init failed`，增加两次自动重试。

### 性能与实测

- native 播放：`draws/s=25–34`（约 30fps），单帧 14–17ms（`readFrame` memcpy + `putImageData`），`maxgap` 58–80ms（偶发 150–394ms）。
- 整机 CPU 55–82%（旧链路 95–98% 且仅 10–12fps）；旧 `video_decoder` 降到 ~3%（仅音频 remux 的 160×90 视频轨）。
- 音频：用户确认正常。

### 已知问题

- **尚未接入 RGA 做 YUV→RGBA 转换**（当前 `sws_scale`）；RGA 需要 dma-buf/连续物理内存，后续可直接替换 native 模块中的转换步骤。
- 搜索键盘仅英文/数字；「⬇ 下载」占位；扫码登录成功链路待真实扫码验证。

---

## v2.1.0（2026-10-24）

> 主题：视频详情页 + 看/听双模式、搜索页自绘屏幕键盘、覆盖层穿透修复、整段预取与本地缓存。
> 验证方式：真机（7FC2800009702019）日志、`/api/ping`、`/api/metrics`、`ffprobe`、缓冲区四段采样、截图对比。

### 新增

- **视频详情页**：点任意视频卡片先进入全屏详情页（640×172，左上「← 返回」），显示封面、标题、UP 主、时长、播放量，以及三个按钮「▶ 看视频」「🎧 听视频」「⬇ 下载」；**下载为占位按钮**，点击仅提示「下载功能占位，暂未开放」。
- **听视频**：新增 `/api/audio?bvid=...&variant=remux|raw`；选择 B 站 DASH 最高码率音轨（`30280/30232/30216` 取 `bandwidth` 最大，实测样本 30280 ≈ 162–196kbps），由 daemon 调用设备自带 `/usr/bin/ffmpeg` 重封装为分片 MP4（音频 copy + 160×90@1fps mpeg4 黑帧视频轨）后推流给播放器。
- **搜索页自绘屏幕键盘**：移除热点搜索（chips），改为 4 行屏幕键盘（`qwertyuiop` / `asdfghjkl`+`⌫` / `zxcvbnm`+空格+清空+搜索 / `0-9`），顶部实时预览输入内容。原因：该机型 miniapp 原生软键盘不弹出（实测 `focus` 事件触发、`focus`/`inputMethod` 方法存在且已调用，输入面板不出现）。**已知限制：只能输入英文/数字，中文输入暂不可用。**
- **预取与本地缓存**：详情页打开即触发整段预取到 `/userdisk/bili_cache`（上限 600MB、7 天过期、启动时 LRU 清理）；`/api/stream` 优先读本地缓存（支持 Range/206），失败自动回退实时代理；预取全局限速（空闲 1MB/s、播放中 512KB/s）且**最多 2 路并发**，避免多条 HTTPS 下载同时抢单核。
- **播放层「铺满/适应」切换**：铺满 = 1:1 像素、上下裁剪（默认）；适应 = 完整画面缩放到 306×172 居中。
- **新 API**：`GET /api/detail?bvid=`（返回 `bvid,title,owner,pic,pic_local,duration,desc,view,like,danmaku,cid,dimension:{width,height}`，非法 bvid→400、解析失败→502）；`GET /api/metrics`（`version,uptime,load1,mem_available_kb,spools:[{bvid,have,total,done}],counters:{stream_bytes,audio_bytes,cache_fallbacks,stream_stalls,cache_hits}`）；`/api/play` 增加 `mode=video|audio`，`/api/status` 返回增加 `mode`。
- **诊断日志**：播放期间每 2s 一条 `[Perf] cb/s=… draws/s=… avg=…ms maxgap=…ms out=WxH`。

### 修复

- **覆盖层穿透（历史遗留 bug）**：详情页/播放层/键盘显示时不再渲染底层首页，点击不会再落到未渲染的首页卡片上。
- **非 16:9 视频起播中止**：旧逻辑因 `onInfo` 尺寸与 640×360 不符而直接中止；新逻辑在 `onInfo` 报出实际解码尺寸（如 640×320、480×360）时按该尺寸自动重开一次。
- **回调内同步 `stop()` 死锁**：不能在原生回调（`onError`/`onInfo`/`onComplete`）里同步调用 `player.stop()`（与解码线程互锁、JS 线程卡死），改为 `setTimeout(0)` / `setTimeout(300)` 延后执行。
- **纯音频 m4s 无法播放**：原生软解直接打开报 `streamDecoder init failed`，改由 remux 提供带视频轨的 MP4。
- **首页偶发空白**：`/api/feed` 原先同步等待 8 张封面下载（每批 3 张、每张 6s 超时），经常超过前端 8s 超时；改为**先返回列表、封面后台异步缓存**，前端失败**自动重试 4 次**，daemon 增加「上次成功推荐」缓存兜底。
- **音频线程优先级实验回退**：`renice`/`chrt` 方案在真机上导致听视频变差（线程优先级反转），已整体撤回。

### 性能与实测

- **`setVideoInfo` 探针**：build 设 `setVideoInfo(320,180)`、缓冲区仍按 640×360 分配（921,600 字节），播放后对缓冲区分四段采样，非零计数 `14400,14400,14400,13652` —— 原生把整帧 640×360 写满，**不能用 320×180 输出降低每帧开销（会写越界）**，显示分辨率固定 640×360。
- **卡顿未完全解决**：实测 `cb/s` 与 `draws/s` 相等且只有 6–12，`maxgap` 100–215ms；同一设备 `ffmpeg` 纯软解 640×360 High@30fps 可达 115fps（utime 4.45s/20s ≈ 22% 单核），加 `-vf format=rgba` 后 94fps（31% 单核）；播放期间 daemon 采样 miniapp 进程 CPU 为 **76–83% 单核**（约 80ms/帧），而 `putImageData` 仅 8–14ms/帧 —— 瓶颈在原生解码→合成链路/单核调度，不在 JS 丢帧。
- **音频 remux 对 4 个样本视频均成功**：`ffprobe` 显示 audio=aac、video=mpeg4，时长与源一致（101s/159s/192s/1075s）。
- **设备实测**：`/api/ping` 返回 `{"version":"2.1.0"}`；miniapp 原生日志路径 `/userdata/applog/DictPen_*.log`（syslog 汇总），daemon 日志 `/userdisk/bili_daemon.log`（每次启动被覆盖）。
- **ffmpeg 硬解不可用**：设备 `/usr/bin/ffmpeg 4.4.1` 编入 `h264_v4l2m2m`，实测 `Could not find a valid device`。
- **包体**：`9002000869905604.amr` = **2,625,089 字节（约 2.62MB）**；daemon 交叉编译 ARMv7 stripped = **6,094,983 字节（约 6.03MB）**。

### 已知问题

- 播放卡顿未完全解决：听视频（不渲染视频）时音频流畅，加入视频渲染后音频也会一卡一卡；瓶颈在原生解码→渲染链路/单核调度。
- 搜索键盘只能输入英文/数字，**中文输入暂不可用**。
- 「⬇ 下载」为占位按钮，未实现真实下载。
- 显示分辨率固定 640×360（`setVideoInfo` 不改变原生输出尺寸）。
- 扫码登录成功路径仍待真实扫码验证；本地 18080 无鉴权；设备 UI 偶发触摸无响应/画面冻结（系统层，与本版本无关）。

---

## v2.0.0 — 2026-10-24

> 主题：修复「条纹 + 越修越多 bug + 改了没生效」，daemon 全面加固。
> 验证方式：真机（7FC2800009702019）日志、截图、curl API 测试。

### 前端（`bili_pkg/app.js`，源在 `build_bili.py`）

- **修复 `onInfo` 参数顺序**：软解库实际发射 `(width, height, duration)`（duration 秒），旧代码按 `(duration,width,height)` 解构，导致 `getImageData` buffer 只有 191KB 而 native 写 921KB（4.8 倍堆越界）且缩放比例失控。
- **起播前调用 `setVideoInfo(640,360)`**：部分视频为 576×360，固定 640 buffer 会产生 stride 错位；强制输出尺寸后条纹消失。
- **修复信号解绑**：`.on(null)` 抛 `TypeError: arg 1 must be function`，导致 `vPlayer.stop()` 被跳过、线程泄漏；改为保存 `.on()` 返回的 token 并用 `sig.off(token)` 解绑。
- **播放代次锁**：`playGen` + 定时器取消，杜绝「退出后仍起播」「300ms teardown 杀掉新播放」。
- **daemon 启动改造**：先 `killall bili-daemon`（设备无 pkill）、按安装槽启动、日志落 `/userdisk/bili_daemon.log`。
- **移除 `pollStatus` 幽灵播放层**；启动时 `/api/stop` 清理残留会话并打印 daemon 版本。

### daemon（`bili_src/main.go`，v2.0.0）

- **新增** `/api/ping` / `/api/health` 返回 `version/pid/uptime`；启动日志带版本号。
- **`/api/stream` 重写**：移除 120s `Client.Timeout` → `r.Context()` + 连接/响应头超时 + 45s 空闲看门狗；Range/206 校验；失败回退 `backup_url`；拒绝 HTML 错误页；只透传必要响应头。
- **`playurl` 缓存**：`resolvePlayURL` 10 分钟缓存 + bvid 正则校验（非法 bvid 返回 400）。
- **扫码登录加固**：从 `data.url` query + `Set-Cookie` 双向收集凭证；空凭证不落盘；保存 `refresh_token`。
- **Cookie 安全**：`0600` + 临时文件 rename 原子写；仅在 nav 明确 `-101` 时清除。
- **状态语义修正**：删除 `ffmpegCmd` 死代码，`/api/play|stop|status` 反映真实会话。
- **音量机制修正**：本机型无 ALSA 主音量控件（0–24 号），系统音量由 `libydhal_audio.so` 读取 `vctl` 共享内存（key `0x7663746c`，offset 4 = 0–100）生效；daemon 改为「探测到可写控件才写，否则只读并提示一次」，LINEOUT 增益改用控件名锁定。
- **封面缓存**：并发从 8–12 降到 3；`.tmp` + rename，避免半截 JPEG。
- **健壮性**：`ReadHeaderTimeout`、请求上下文、错误分类、日志前缀统一。

### 构建/打包（`build_bili.py`）

- 打包前自动交叉编译 daemon：`GOOS=linux GOARCH=arm GOARM=7 CGO_ENABLED=0` + `-trimpath -ldflags "-s -w -buildid="`。
- daemon 8.2MB → **5.9MB**；AMR 4.69MB → **2.56MB（-45%）**。
- 版本号统一升到 `2.0.0`（`App.meta.version` + `manifest.version`）。

### 文档

- README 重写为 v2.0.0 现状（架构/API 契约/部署/排障/已知问题）。
- 新增 CHANGELOG（本文件）。
- 审计报告补充 §7（前端真机验证）与 §8（daemon v2.0.0 验证）。
- 平台手册新增 §9「真机实测补充」（软解 API、音量机制、系统工具、部署注意事项）。
- 方案 B 手册加「文档状态」说明（未落地，被方案 A 取代）。

### 已知问题

- 扫码登录**成功路径**待真实扫码验证（二维码生成、失效码路径已验证）。
- 本地 18080 未做鉴权（项目决定暂不实现）。
- 设备 UI 偶发触摸无响应/画面冻结，属系统层，与本版本无直接关系。
- 显示为 306×172 letterbox（与官方播放器一致）；满宽裁剪为可选改造。

---

## v1.0.0 — 2026-10-24

- 首个可运行版本：推荐流、搜索、热词、扫码登录、Canvas 软解播放、系统音量联动、封面缓存。
- 已知问题：画面条纹、退出播放崩溃/无声、长视频 2 分钟截断、A/B 双 daemon 版本错配。
