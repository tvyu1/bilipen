# 笔上哔哩 (BiliPen)

网易有道词典笔上的哔哩哔哩轻应用：Falcon 运行时（Vue2 + QuickJS）单文件前端 + Go 守护进程 + 自研 native 视频解码模块。

**当前版本：v3.0.9**（音画同步改为「音频 = 主时钟」）· 版本说明见 [CHANGELOG.md](CHANGELOG.md) · 安装包见 [Releases](https://github.com/tvyu1/bilipen/releases)

## 支持设备

| 设备 | 屏幕 | 说明 |
|---|---|---|
| 有道词典笔 A7（型号 `Y09`） | 640×172 | 早期适配目标，布局基准 |
| 有道词典笔 A7P | 1020×240 | 与 A7 同一 SoC，**仅屏幕分辨率不同** |

同一份前端同时适配两代设备：样式按 640×172 基准写成 vw/vh，启动时读设备真实分辨率折算成整数 px（见「分辨适配」）。A7 上折算结果与原值逐像素一致，A7P 上宽高各自贴合屏幕。

## 版本与发布（v3.0.9）

**v3.0.8（2026-11-12）**：前端样式全量改 **vw/vh**（样式表 422 处尺寸 + 内联样式 8 处，合计 430 处；宽按 640 基准、高/字号按 172 基准），启动时按真实分辨率一次性折算成**整数 px**，避免亚像素落点导致文字发虚/锯齿；视频解码尺寸由设备真实宽高计算。A7 上与 3.0.7 逐像素对比 0 差异，A7P 上不再出现「下部显示不全」。

**v3.0.9（2026-11-12）**：音画同步改为「**音频 = 主时钟**」——删除把音频 pause 的 park/unpark 逻辑，改为**视频超前就定住画面等音频、视频落后就跳帧追**，修复「声音消失、音频位置冻结而视频继续」（旧版静音 16s、`apos` 冻在 18.0s 而 `pos` 跑到 33.8s）。

**产物**

| 文件 | 大小 | md5 |
|---|---|---|
| `9002000869905604.amr` | 2,800,423 B | `9af9dd2ecc49c68389353f0777f6a5d5` |
| 包内 `app.js` | 215,153 B | `fdde08fa3d3f6384c733dfee8ab02b93` |
| 包内 `libs/arm/bili-daemon` | 6,422,663 B | `506e4d4d5ba7ed5665e27d110a2546a8` |

> 逐版本改动、历史产物 md5 与实测证据见 [CHANGELOG.md](CHANGELOG.md)。

## 功能现状

### 浏览层（三栏骨架：A7 640×172 / A7P 1020×240）

- **左栏**：3 个图标（首页 / 历史 / 我的），**长按 600ms 显示名称**
- **顶部动作栏**：当前页标题 + 搜索 / 历史 / 收藏 / 缓存 / 刷新
- **内容区**：统一 **2×2 卡片网格 + 右侧翻页列**（`n/m` 页码 + 上/下）；**首页翻到末页再按「下」自动换一批并回到第 1 页**
- **推荐流**：WBI 鉴权 + 热门榜单降级 + 磁盘持久化缓存秒开
- **搜索**：系统原生输入法输入；支持 **视频 / UP主** 与 **综合 / 播放 / 最新** 排序；UP主卡片点按转为按名字搜视频
- **历史**：本地（`/userdisk/bili_history.json`，最多 60 条）与**云端**（需登录）双来源
- **收藏**：收藏夹列表 → 内容网格（需登录）
- **缓存**：离线下载专区的浏览、剩余空间显示与删除

### 播放页（一屏双栏）

- **布局**：左侧视频 + 右侧详情。A7 为 306×172 + 334×172；A7P 按 1020×240 等比折算（约 488×240 + 532×240）
- **控制条**：暂停 / 快退 10s / **进度条（仅展示，点击跳转已于 3.0.7 移除）** / 快进 10s / 时间；播放中默认隐藏，单击画面唤出；左上 `‹` 返回
- **四标签**：详情（标题·UP·播放量）/ 分P（原地切换并持久显示 `P2 · 分P名`）/ 评论（最热·最新·翻页）/ 推荐（点选换播）
- **操作行**：赞 / 投币 / 收藏 / 下载 / 更多（**稍后再看、一键三连**）；状态实时高亮
- **看视频**：自研 native 模块（FFmpeg 4.4.1 软解 + `sws_scale`），解码输出对齐显示区；A7 实测 25–30 draws/s，播放期间保持屏幕常亮
- **听视频**：DASH 最高音质音轨，由 daemon 调用设备 ffmpeg 重封装（`chrt -f 49`）后播放
- **音画同步**：音频为主时钟；视频超前 >1.2s 定住画面等音频（3s 兜底放行），视频落后 >0.6s 用 `rgav.adjust()` 跳帧追；**音频任何情况下都不 pause**
- **硬件音量联动**：读 SysV 共享内存（`0x7663746c`）联动声卡 Control 23（0..30）
- **离线播放**：DASH 双流下载 + `-c copy` 极速合并，断网 100% 离线声画播放

### 分辨适配（A7 / A7P）

- 样式表全量使用 **vw/vh**：宽度按 640 基准、高度/字号/圆角按 172 基准
- 尺寸唯一来源是运行时的 `$falcon.env.deviceWidth` / `deviceHeight`；启动时 `setViewPort(DEV_W)` 并打印 `[Adapt] screen WxH vw/vh layout`（取不到时回落 640×172）
- `__adaptStyleTree()` 在 `onLaunch` 把整棵样式树里的 vw/vh **一次性折算成整数 px**：直接吃 vw/vh 会产生小数长度，文字落在亚像素上发虚、锯齿变多
- 视频层不写死分辨率：解码输出框（`predictDecode`）与 canvas 缩放（`scale(DEV_H / playSize.h)`）按设备真实宽高算；16:9 视频在 A7 输出 306×172、在 A7P 输出 426×240

### 账号与稳定性

- **扫码登录**：手机 B 站 App 扫码，凭证持久化；点赞/投币/收藏/评论/云端历史均需登录，未登录时按钮给出明确提示
- **稳定性**：连续起播/退出/切页无堆损坏；网络强制 IPv4；屏幕感知看门狗；native `setBuffer` 容错
- **网络容错**：系统 DNS 失败后走公共 DNS 兜底（`223.5.5.5` / `119.29.29.29` / `8.8.8.8`，结果缓存 10 分钟）；三个 `http.Transport` 限制 `MaxConnsPerHost`；封面下载限 2 并发 + 同 bvid 去重；启动时把 `RLIMIT_NOFILE` 抬到硬上限；WBI key 拉取失败退避 60s

### 已知不支持

- **弹幕**：未实现（播放页不显示弹幕控件）
- **系统手势返回**：本固件的手势是「回桌面」语义，宿主不派发 `onBackPressed`（`libfalcon.so` 虽存在 `FalconPage::supportBack` / `JSPageInstance::onBackPressed` 符号，实测手势只触发 `page onHide`），因此应用内返回统一走播放页左上 `‹` 与各页返回控件

## TODO / 路线图

- [x] 自研 native 软解替代厂商软解（10~12fps → 30fps）
- [x] 音画同步闭环、进度条与暂停、观看历史、保持亮屏
- [x] 离线下载与离线音画播放
- [x] 系统原生输入法搜索、WBI 签名、待机省电加固
- [x] 解码输出对齐显示区（单帧 8~14ms → 1~2ms）
- [x] UI 与市面商业化版本同构（三栏骨架 + 播放页双栏）与互动功能（弹幕除外）
- [x] 同一份前端适配 A7（640×172）与 A7P（1020×240）：样式 vw/vh + 启动折算整数 px
- [x] 音画同步改「音频 = 主时钟」，消除音频被 pause 后永不恢复的静音问题
- [ ] _（低优先级）_ 音频停止后约 1 秒尾音（厂商 `YAudioModule` 的 ALSA 缓冲残留）
- [ ] _（低优先级）_ 音频偶发爆音 / 失真（单核 CPU 争抢）
- [ ] _（可选）_ RGA 硬件 YUV→BGRA：已实现并用探针在真机验证 ABI（librga 1.9.3），但设备只有可缓存 dma-heap，每次调用被内核强制同步 cache，实测净收益为负，故通过 `USE_RGA=false` 关闭；换 uncached dma-buf 后可重启
- [ ] _（可选）_ 弹幕（需新增弹幕接口与渲染层）

## 项目结构

| 路径 | 说明 |
|---|---|
| `README.md` | 本说明（功能、结构、安装、构建、调试、约定、限制、TODO） |
| `CHANGELOG.md` | 版本演进历史（v2.4.1 ~ v3.0.9，含实测证据与各版产物 md5） |
| `frontend/app.js` | **唯一前端源文件**（Vue2 + QuickJS，单文件约 215KB）：三栏骨架、2×2 网格与翻页、播放页双栏、分辨适配、音画同步控制器、进度条交互、原生输入法接入 |
| `build_bili.py` | 打包脚本：交叉编译 Go daemon → 复制 `libs/arm/*.so` → 装配 `frontend/app.js` → 写 manifest（版本号）+ 重算证书 → 输出 `.amr` |
| `bili_src/main.go` | 守护进程入口：路由注册、待机看门狗（屏幕状态感知）、CPU 采样、fd 收敛、全局常量（`Version` / `Port` 等） |
| `bili_src/bili_api.go` | B 站 Web API：WBI 鉴权、强制 IPv4、公共 DNS 兜底、Feed 三级容灾、DASH 协商、搜索/详情、扫码登录、封面与二维码缓存 |
| `bili_src/actions.go` | 互动与内容接口：分P / 推荐 / 评论 / 三连状态 / 点赞 / 投币 / 收藏 / 收藏夹 / 云端历史 / 稍后再看 / 登录态 / 分P 选择；含 `csrfToken`、`ensureLogin` 基础设施 |
| `bili_src/stream.go` | 视频流代理：预取缓存（600MB 上限）、关键帧切片 Seek（`&ss=`）、spool 取消、`chrt` 收窄、`/api/stream/status` |
| `bili_src/audio.go` | 音频流：DASH 音轨 + 合成 1fps 黑帧轨重封装、ALSA 就绪探针、流取消 |
| `bili_src/volume.go` | 硬件音量联动：SysV 共享内存（Key `0x7663746c`）→ ALSA Control 23 |
| `bili_src/history.go` | 本地观看历史（`/userdisk/bili_history.json`，60 条） |
| `bili_src/download.go` | 离线下载：DASH 双流限速下载、`-c copy` 合并、断点续传、磁盘空间监控 |
| `bili_src/cache.go` | 在线缓存清单与清理（跳过正在播放/写入的文件） |
| `bili_src/go.mod`、`go.sum` | Go 依赖（仅 `skip2/go-qrcode`） |
| `native/rgavideo.c` | native 解码模块：FFmpeg 软解 + `sws_scale`/可选 RGA + 6 槽环形缓冲 + 锁外转换 + PTS 节奏/追帧 + 暂停恢复 + 裁剪/缩放模式 |
| `libjsapi_rgavideo.so` | 预编译 native 模块（ARMv7 / uClibc，22KB），随仓库提供 |
| `libjsapi_softvideo.so` | 设备自带软解/音频 JSAPI（音频轨与回退链路） |
| `libjsapi_nekolib.so` | 设备自带 shell/文件 JSAPI（拉起 daemon、亮屏续期） |
| `bili_pkg/` | 打包中间目录（`app.js`、`manifest.json`、`libs/`、图标；全部由脚本生成、不入库） |
| `app_icon.png` | 应用图标 |
| `.gitignore`、`.gitattributes` | 构建产物与二进制配置 |

构建产物：`9002000869905604.amr`（不入库，由 `python build_bili.py` 生成）。

## 开发约定

> 下面几条是踩过坑之后固化下来的硬约束，改前端/播放链路前先看一遍。

1. **`frontend/app.js` 是唯一前端源文件**：仓库里没有 Vue SFC/工程化源码，也没有构建期的模板编译。所有 UI、样式、播放逻辑都在这一个文件里；**改完必须重新跑 `python build_bili.py` 打包**，否则设备上跑的还是旧 `bili_pkg/app.js`。
2. **样式统一用 vw/vh，禁止再写固定 px 尺寸**：宽度基准 640（如整宽 `100vw`、左栏 `7.5vw`、播放区 `47.8125vw`），高度/字号/圆角基准 172（如状态栏 `12.790698vh`）。除 `0px`、必须由 JS 按真实像素计算的少量位置（视口、解码输出尺寸、canvas 缩放）外，不要出现写死的 px 宽度/高度/字号。
3. **尺寸只能来自 `$falcon.env`**：设备宽高从 `$falcon.env.deviceWidth` / `deviceHeight` 读取（取不到回落 640×172），不要写死 640/172/306/334 之类的常量，也不要在代码里判断机型。需要像素值时用 `__vw()` / `__vh()` 折算，新增内联样式同样走这两个函数。
4. **音画同步只允许动视频侧**：音频是主时钟，**任何情况下都不 pause 音频**。视频超前就 `_brakeVideo` 定住画面等音频（最长 3s 兜底放行），视频落后就 `rgav.adjust()` 跳帧追。不要恢复「暂停音频等视频」的 park/unpark 写法——那会让音频永久停在冻结位置，表现为「声音消失、画面继续」。
5. **版本号改动要同步两处**：`build_bili.py` 里 manifest 的 `version`（决定包内版本与 PMS 判定）和 `bili_src/main.go` 的 `Version`（`/api/ping` 回报值），改完重新打包。
6. **不要提交构建产物**：`9002000869905604.amr`、`bili_pkg/`、`bili_src/bili-daemon` 均在 `.gitignore` 内，由脚本生成。

## 安装

前置：设备已开启 adb，且已具备 Falcon 轻应用运行时；主机使用 `adb` 与设备自带的 `miniapp_cli`。

```bash
# 1. 推送安装包
adb push 9002000869905604.amr /userdisk/9002000869905604.amr

# 2. 先卸载（PMS 会拒绝同版本/降级安装）
adb shell "miniapp_cli uninstall 9002000869905604"

# 3. 安装
adb shell "miniapp_cli install /userdisk/9002000869905604.amr"

# 4. 让宿主重新加载前端（否则仍在跑旧 app.js）
adb shell "kill -9 \$(pidof miniapp)"

# 5. 确认版本
adb shell "curl -s http://127.0.0.1:18080/api/ping"
```

> 安装后从桌面点开「笔上哔哩」。前端启动时会 `killall bili-daemon` 并只拉起「最新安装槽」那份 daemon，日志写到 `/userdisk/bili_daemon.log`；所以**换包后必须重启宿主进程**，只重启 daemon 不会加载新前端。

## 使用

- **左栏**：点图标切换首页 / 历史 / 我的；**长按**显示名称
- **动作栏**：搜索 / 历史 / 收藏 / 缓存 / 刷新；当前页高亮
- **首页 / 历史 / 收藏 / 缓存**：2×2 四张卡，右侧上/下翻页；首页翻到末页再按下自动换一批
- **搜索**：点输入框调起系统输入法；用芯片切「视频 / UP主」与「综合 / 播放 / 最新」；右侧「✕」清空
- **播放**：点卡片 → 详情页 → 「▶ 看视频」；播放页左视频右详情，四个标签可切；进入为封面暂停态，点中央 ▶ 同时起音视频；底部控制条可暂停、±10s、点击进度条跳转
- **互动**：详情标签里的 赞 / 币 / 藏 / 下载 / 更多（稍后再看、一键三连）
- **退出播放**：左上 `‹`；画面固定「适应」（等比完整显示，不裁切）
- **登录**：我的页扫码（手机 B 站 App），登录后互动功能可用

## 调试与验证

### 日志

| 位置 | 内容 |
|---|---|
| `/userdata/applog/DictPen_*.log` | 设备应用日志；其中带 appid `9002000869905604` 的行即本应用前端 `console.log/warn` 的输出 |
| `/userdisk/bili_daemon.log` | daemon 标准输出/错误：起播、切片、DNS 兜底、spool、metrics 相关警告 |

常用观察点（前端日志）：`[Adapt] screen WxH vw/vh layout`（分辨率适配）、`[Sync] video ahead … -> brake` / `[Sync] catch-up video`（音画同步动作）、`[Perf] cb/s … out=WxH`（出帧与解码尺寸）。

### 抓屏

```bash
adb shell "miniapp_cli capture /userdisk/screen.png"
adb pull /userdisk/screen.png
```

### 自动化触摸（原始 MT 事件）

需要可重复的自动化交互验证时，可直接向触摸节点注入多点触控协议（MT）事件：`ABS_MT_SLOT`（选槽）→ `ABS_MT_TRACKING_ID`（按下给新 id / 抬起给 -1）→ `ABS_MT_POSITION_X` / `ABS_MT_POSITION_Y`（坐标）→ `SYN_REPORT`。写入 `/dev/input/event2` 即可（需 root）。长按 600ms 显示名称、单击唤出控制条、进度条点按等交互都可用这种方式回归。

### 接口自检

```bash
adb shell "curl -s http://127.0.0.1:18080/api/ping"      # 版本/存活
adb shell "curl -s http://127.0.0.1:18080/api/metrics"   # goroutines / open_fds / dns_fallback 等
```

## 构建

### 依赖

- **Python 3**：打包脚本
- **Go 1.22+**：交叉编译 daemon（`GOOS=linux GOARCH=arm GOARM=7 CGO_ENABLED=0`；未安装 go 时脚本会退回使用仓库内已有的 `bili_src/bili-daemon`）
- **（仅重编 native 时需要）Rockchip 交叉工具链**：`arm-rockchip830-linux-uclibcgnueabihf`（GCC 8.3.0，来自 RV1106 SDK；Windows 下用 WSL2）
- **（仅重编 native 时需要）FFmpeg 4.4.1 头文件 + 设备动态库**（`libavformat.so.58` / `libavcodec.so.58` / `libswscale.so.5` / `libavutil.so.56`）
- **（仅重编 native 时需要）QuickJS 2020-07-05 头文件**（`quickjs.h`）

### 打包

```bash
python build_bili.py
# 输出 9002000869905604.amr（仓库根目录）
```

脚本流程：Go 交叉编译 `bili_src/` → 复制 `libs/arm/*.so`、图标 → 把 `frontend/app.js` 复制为 `bili_pkg/app.js` → 写 manifest（含版本号）并对包内所有文件重算 size/md5 证书 → 打成 zip 形式的 `.amr`（daemon 与 `.so` 置 0755）。

改完前端只跑这一条命令即可；native 模块未重编时脚本直接复用根目录的 `libjsapi_rgavideo.so`。

### 重新编译 native 模块（可选）

仅在修改 `native/rgavideo.c` 后需要；仓库已自带预编译 `.so`。WSL 下常用流程：

```bash
# 工具链解压到 /root/a7tc，FFmpeg 头与 QuickJS 头放在 /root/a7build
# 设备动态库放 /root/a7build/devlibs（libavformat.so 等软链或实体文件）
TC=/root/a7tc/arm-rockchip830-linux-uclibcgnueabihf
$TC/bin/arm-rockchip830-linux-uclibcgnueabihf-gcc -shared -fPIC -O2 \
  -fvisibility=hidden -I/root/a7build -I/root/a7build/ffmpeg-4.4.1 \
  -o libjsapi_rgavideo.so native/rgavideo.c \
  -L/root/a7build/devlibs -lavformat -lavcodec -lswscale -lavutil -lm -lpthread -ldl \
  -Wl,--allow-shlib-undefined -Wl,-s
```

### native 模块接口

- 导出 `custom_init_jsapis`，通过运行时的 `registerCModuleLoader("rgavideo", loader)` 注册 QuickJS 模块
- JS 接口：`setBuffer(arrayBuffer,w,h)`、`setCropMode(0|1)`（适应/铺满源裁剪）、`setScaleAlgo(0..3)`、`setRGAEnabled(0|1)`、`rgaAvailable()`、`start(url)`、`readFrame()`、`stop()`、`pause()`、`unpause()`、`resume(sec)`、`adjust(deltaSec)`、`info()`、`error()`、`duration()`、`position()`
- 前端每 8ms 轮询 `readFrame()`（截止时间制 30fps 出帧）；模块不可用时自动回退到 softvideo 链路

## 守护进程接口（127.0.0.1:18080）

- **基础**：`/api/ping`（版本）、`/api/health`、`/api/status`、`/api/metrics`（`version`/`uptime`/`load1`/`mem_available_kb`/`goroutines`/`open_fds`/`cover_pending`/`spools` + `counters`：`stream_bytes`/`audio_bytes`/`cache_fallbacks`/`stream_stalls`/`cache_hits`/`dns_fallback`）
- **内容**：`/api/feed`、`/api/trending`、`/api/search`（`type`/`order`）、`/api/detail`（含 `aid`/`relation`）、`/api/parts`、`/api/related`、`/api/comments`、`/api/proxy/cover`
- **播放**：`/api/play`、`/api/stream`（`&ss=`）、`/api/stream/status`（`source/have/total/done/percent`）、`/api/audio`（`variant=remux`）、`/api/alsa/ready`、`/api/stop`、`/api/volume`、`/api/selectcid`
- **历史**：`/api/history`、`/api/history/add`、`/api/history/clear`、`/api/history/cloud`
- **互动**：`/api/action/relation`、`/api/action/like`、`/api/action/coin`、`/api/action/fav`、`/api/fav/folders`、`/api/fav/items`、`/api/toview/add`、`/api/share/qr`
- **下载与缓存**：`/api/download/start`、`/api/download/pause`、`/api/download/list`、`/api/download/status`、`/api/download/delete`、`/api/cache/list`、`/api/cache/delete`、`/api/cache/clear`
- **账号**：`/api/user/info`、`/api/login/state`、`/api/login/qr`、`/api/login/poll`、`/api/login/logout`

## 已知限制

- 音频停止后约 **1 秒尾音**（厂商 `YAudioModule` 的 ALSA 缓冲残留）、偶发爆音/失真（低优先级）
- 解码 YUV→RGBA 默认用 `sws_scale`；RGA 已实现但默认关闭（见 TODO）
- 守护进程仅监听 `127.0.0.1:18080`，**未做鉴权**（依赖仅本机可访问）
- **弹幕未实现**；**系统手势返回不支持**（平台限制，见上文）
- 播放固定 letterbox「适应」模式（v3.0.1 移除了「铺满」切换）；非 16:9 视频按实际解码尺寸显示
- **投币**受 B 站人机验证风控限制（接口返回 `-401` 且 `decisions` 含 `verify_captcha_level2/3`），客户端无法绕过，需在手机 App 内投币
- 校园网/弱网下若**系统 DNS 整体不可用**，本应用靠公共 DNS 兜底继续工作，但其它应用仍会断网；可用 `/api/metrics` 的 `dns_fallback` 判断兜底是否生效
- 换分辨率（A7 ↔ A7P）无需改代码，但 `vw/vh → px` 的折算依赖运行时 `$falcon.env`；取不到该环境时按 640×172 处理，A7P 上会出现布局偏小

## 免责声明

本项目为个人学习与研究用途，与哔哩哔哩、网易有道均无关联；仓库内涉及的厂商库与图标版权归原权利人。
