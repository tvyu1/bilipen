# 笔上哔哩 (BiliPen)

网易有道词典笔 A7（型号 `Y09`）上的哔哩哔哩轻应用：Falcon 运行时（Vue2 + QuickJS）前端 + Go 守护进程 + 自研 native 视频解码模块。

**当前版本：v3.0.1** · 版本说明见 [CHANGELOG.md](CHANGELOG.md)

## 功能现状

### 浏览层（640×172 三栏骨架）

- **左栏**：3 个图标（首页 / 历史 / 我的），**长按 600ms 显示名称**
- **顶部动作栏**：当前页标题 + 搜索 / 历史 / 收藏 / 缓存 / 刷新
- **内容区**：统一 **2×2 卡片网格 + 右侧翻页列**（`n/m` 页码 + 上/下）；**首页翻到末页再按「下」自动换一批并回到第 1 页**
- **推荐流**：WBI 鉴权 + 热门榜单降级 + 磁盘持久化缓存秒开
- **搜索**：系统原生输入法输入；支持 **视频 / UP主** 与 **综合 / 播放 / 最新** 排序；UP主卡片点按转为按名字搜视频
- **历史**：本地（`/userdisk/bili_history.json`，最多 60 条）与**云端**（需登录）双来源
- **收藏**：收藏夹列表 → 内容网格（需登录）
- **缓存**：离线下载专区的浏览、剩余空间显示与删除

### 播放页（一屏双栏）

- **布局**：左侧视频 306×172 + 右侧详情 334×172
- **控制条**：暂停 / 快退 10s / 进度条（点击跳转）/ 快进 10s / 时间；播放中默认隐藏，单击画面唤出；左上 `‹` 返回
- **四标签**：详情（标题·UP·播放量）/ 分P（原地切换并持久显示 `P2 · 分P名`）/ 评论（最热·最新·翻页）/ 推荐（点选换播）
- **操作行**：赞 / 投币 / 收藏 / 下载 / 更多（**稍后再看、一键三连**）；状态实时高亮
- **看视频**：自研 native 模块（FFmpeg 4.4.1 软解 + `sws_scale`），解码输出对齐显示区，稳定 30fps；播放期间保持屏幕常亮
- **听视频**：DASH 最高音质音轨，由 daemon 调用设备 ffmpeg 重封装（`chrt -f 49`）后播放
- **音画同步**：音频为主时钟（斜率回归估计）+ 对称 ±45ms 死区 + 双向卡顿保护
- **硬件音量联动**：读 SysV 共享内存（`0x7663746c`）联动声卡 Control 23（0..30）
- **离线播放**：DASH 双流下载 + `-c copy` 极速合并，断网 100% 离线声画播放

### 账号与稳定性

- **扫码登录**：手机 B 站 App 扫码，凭证持久化；点赞/投币/收藏/评论/云端历史均需登录，未登录时按钮给出明确提示
- **稳定性**：连续起播/退出/切页无堆损坏；网络强制 IPv4；屏幕感知看门狗；native `setBuffer` 容错

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
- [ ] _（低优先级）_ 音频停止后约 1 秒尾音（厂商 `YAudioModule` 的 ALSA 缓冲残留）
- [ ] _（低优先级）_ 音频偶发爆音 / 失真（单核 CPU 争抢）
- [ ] _（可选）_ RGA 硬件 YUV→BGRA：已实现并用探针在真机验证 ABI（librga 1.9.3），但设备只有可缓存 dma-heap，每次调用被内核强制同步 cache，实测净收益为负，故通过 `USE_RGA=false` 关闭；换 uncached dma-buf 后可重启
- [ ] _（可选）_ 弹幕（需新增弹幕接口与渲染层）

## 项目结构

| 路径 | 说明 |
|---|---|
| `README.md` | 本说明（功能、结构、安装、使用、构建、限制、TODO） |
| `CHANGELOG.md` | 版本演进历史（v2.4.0 ~ v3.0.1） |
| `frontend/app.js` | 前端 Vue2 + QuickJS 单文件源码（三栏骨架、2×2 网格与翻页、播放页双栏、音画同步控制器、进度条交互、原生输入法接入） |
| `build_bili.py` | 打包脚本：交叉编译 Go daemon → 复制 `libs/arm/*.so` → 装配 `frontend/app.js` → 重算 manifest 证书 → 输出 `.amr` |
| `bili_src/main.go` | 守护进程入口：路由注册、待机看门狗（屏幕状态感知）、CPU 采样、全局常量 |
| `bili_src/bili_api.go` | B 站 Web API：WBI 鉴权、强制 IPv4、Feed 三级容灾、DASH 协商、搜索/详情、扫码登录、封面与二维码缓存 |
| `bili_src/actions.go` | 互动与内容接口：分P / 推荐 / 评论 / 三连状态 / 点赞 / 投币 / 收藏 / 收藏夹 / 云端历史 / 稍后再看 / 登录态 / 分P 选择；含 `csrfToken`、`ensureLogin` 基础设施 |
| `bili_src/stream.go` | 视频流代理：预取缓存（600MB 上限）、关键帧切片 Seek（`&ss=`）、spool 取消、`chrt` 收窄 |
| `bili_src/audio.go` | 音频流：DASH 音轨 + 合成 1fps 黑帧轨重封装、ALSA 就绪探针、流取消 |
| `bili_src/volume.go` | 硬件音量联动：SysV 共享内存（Key `0x7663746c`）→ ALSA Control 23 |
| `bili_src/history.go` | 本地观看历史（`/userdisk/bili_history.json`，60 条） |
| `bili_src/download.go` | 离线下载：DASH 双流限速下载、`-c copy` 合并、磁盘空间监控 |
| `bili_src/go.mod`、`go.sum` | Go 依赖（仅 `skip2/go-qrcode`） |
| `native/rgavideo.c` | native 解码模块：FFmpeg 软解 + `sws_scale`/可选 RGA + 6 槽环形缓冲 + 锁外转换 + PTS 节奏/追帧 + 暂停恢复 + 裁剪/缩放模式 |
| `libjsapi_rgavideo.so` | 预编译 native 模块（ARMv7 / uClibc，22KB），随仓库提供 |
| `libjsapi_softvideo.so` | 设备自带软解/音频 JSAPI（音频轨与回退链路） |
| `libjsapi_nekolib.so` | 设备自带 shell/文件 JSAPI（拉起 daemon、亮屏续期） |
| `app_icon.png` | 应用图标 |
| `.gitignore`、`.gitattributes` | 构建产物与二进制配置 |

构建产物：`9002000869905604.amr`（不入库，由 `python build_bili.py` 生成）。

## 安装

前置：设备已开启 adb，且已具备 Falcon 轻应用运行时。

```bash
adb push 9002000869905604.amr /userdisk/9002000869905604.amr
adb shell "miniapp_cli install /userdisk/9002000869905604.amr"
adb shell "killall bili-daemon miniapp 2>/dev/null; miniapp_cli start 9002000869905604"
adb shell "curl -s http://127.0.0.1:18080/api/ping"   # 确认版本
```

## 使用

- **左栏**：点图标切换首页 / 历史 / 我的；**长按**显示名称
- **动作栏**：搜索 / 历史 / 收藏 / 缓存 / 刷新；当前页高亮
- **首页 / 历史 / 收藏 / 缓存**：2×2 四张卡，右侧上/下翻页；首页翻到末页再按下自动换一批
- **搜索**：点输入框调起系统输入法；用芯片切「视频 / UP主」与「综合 / 播放 / 最新」；右侧「✕」清空
- **播放**：点卡片 → 详情页 → 「▶ 看视频」；播放页左视频右详情，四个标签可切；进入为封面暂停态，点中央 ▶ 同时起音视频；底部控制条可暂停、±10s、点击进度条跳转
- **互动**：详情标签里的 赞 / 币 / 藏 / 下载 / 更多（稍后再看、一键三连）
- **退出播放**：左上 `‹`；画面固定「适应」（等比完整显示，不裁切）
- **登录**：我的页扫码（手机 B 站 App），登录后互动功能可用

## 构建

### 依赖

- **Python 3**：打包脚本
- **Go 1.22+**：交叉编译 daemon（`GOOS=linux GOARCH=arm GOARM=7 CGO_ENABLED=0`）
- **（仅重编 native 时需要）Rockchip 交叉工具链**：`arm-rockchip830-linux-uclibcgnueabihf`（GCC 8.3.0，来自 RV1106 SDK；Windows 下用 WSL2）
- **（仅重编 native 时需要）FFmpeg 4.4.1 头文件 + 设备动态库**（`libavformat.so.58` / `libavcodec.so.58` / `libswscale.so.5` / `libavutil.so.56`）
- **（仅重编 native 时需要）QuickJS 2020-07-05 头文件**（`quickjs.h`）

### 打包

```bash
python build_bili.py
# 输出 9002000869905604.amr
```

脚本会先用 Go 交叉编译 `bili_src/`，再复制 `libs/arm/*.so`、装配 `frontend/app.js`、计算 manifest 证书并打包。

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
- JS 接口：`setBuffer(arrayBuffer,w,h)`、`setCropMode(0|1)`（适应/铺满源裁剪）、`setScaleAlgo(0..3)`、`setRGAEnabled(0|1)`、`rgaAvailable()`、`start(url)`、`readFrame()`、`stop()`、`pause()`、`unpause()`、`resume(offsetSec)`、`adjust(deltaSec)`、`info()`、`error()`、`duration()`、`position()`
- 前端每 8ms 轮询 `readFrame()`（截止时间制 30fps 出帧）；模块不可用时自动回退到 softvideo 链路

## 守护进程接口（127.0.0.1:18080）

- **基础**：`/api/ping`、`/api/health`、`/api/status`、`/api/metrics`
- **内容**：`/api/feed`、`/api/trending`、`/api/search`（`type`/`order`）、`/api/detail`（含 `aid`/`relation`）、`/api/parts`、`/api/related`、`/api/comments`、`/api/proxy/cover`
- **播放**：`/api/play`、`/api/stream`（`&ss=`）、`/api/audio`（`variant=remux`）、`/api/alsa/ready`、`/api/stop`、`/api/volume`、`/api/selectcid`
- **历史**：`/api/history`、`/api/history/add`、`/api/history/clear`、`/api/history/cloud`
- **互动**：`/api/action/relation`、`/api/action/like`、`/api/action/coin`、`/api/action/fav`、`/api/fav/folders`、`/api/fav/items`、`/api/toview/add`、`/api/share/qr`
- **下载**：`/api/download/start`、`/api/download/list`、`/api/download/status`、`/api/download/delete`
- **账号**：`/api/user/info`、`/api/login/state`、`/api/login/qr`、`/api/login/poll`、`/api/login/logout`

## 已知限制

- 音频停止后约 **1 秒尾音**（厂商 `YAudioModule` 的 ALSA 缓冲残留）、偶发爆音/失真（低优先级）
- 解码 YUV→RGBA 默认用 `sws_scale`；RGA 已实现但默认关闭（见 TODO）
- 守护进程仅监听 `127.0.0.1:18080`，**未做鉴权**（依赖仅本机可访问）
- **弹幕未实现**；**系统手势返回不支持**（平台限制，见上文）
- 播放固定 letterbox「适应」模式（v3.0.1 移除了「铺满」切换）；非 16:9 视频按实际解码尺寸显示

## 免责声明

本项目为个人学习与研究用途，与哔哩哔哩、网易有道均无关联；仓库内涉及的厂商库与图标版权归原权利人。
