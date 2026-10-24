# 笔上哔哩 (BiliPen)

网易有道词典笔 A7（型号 `Y09`）上的哔哩哔哩轻应用：Falcon 运行时（Vue2 + QuickJS）前端 + Go 守护进程 + 自研 native 视频解码模块。

**当前版本：v2.2.0** · 版本说明见 [CHANGELOG.md](CHANGELOG.md)

## 功能现状

- **推荐流**：可用
- **扫码登录**：可用（手机 B 站 App 扫码）
- **视频详情页**：可用（封面/标题/UP/时长/播放量 + 看视频/听视频/下载）
- **看视频**：可用，自研 native 模块（FFmpeg 4.4.1 软解 + `sws_scale`），真机约 **30fps**
- **听视频**：可用，DASH 最高音质音轨，由 daemon 调用设备 ffmpeg 重封装后播放
- **搜索**：**暂不可用** —— 该机型 miniapp 原生软键盘不弹出，自绘屏幕键盘方案也未生效，无法输入关键词
- **下载**：占位按钮，未实现

## 项目结构

| 路径 | 说明 |
|---|---|
| `README.md` | 本说明（功能、结构、安装、使用、构建、限制） |
| `CHANGELOG.md` | 版本说明（当前仅保留最新版本 v2.2.0） |
| `build_bili.py` | 打包脚本：编译 Go daemon → 复制 `libs/arm/*.so` → 生成 `bili_pkg/app.js` → 重算 manifest 证书 → 输出 `.amr` |
| `bili_src/main.go` | Go 守护进程（`bili-daemon`）：B 站接口、搜索/推荐/详情、扫码登录、音频 remux、预取缓存、流代理；仅监听 `127.0.0.1:18080` |
| `bili_src/go.mod`、`go.sum` | Go 模块依赖（仅 `skip2/go-qrcode`） |
| `native/rgavideo.c` | native 视频解码模块源码：FFmpeg 软解 + `sws_scale` 转 RGBA + 双缓冲 + PTS 节奏，注册为 QuickJS 模块 `rgavideo` |
| `libjsapi_rgavideo.so` | 预编译 native 模块（ARMv7 / uClibc，13.8KB），随仓库提供，普通构建无需工具链 |
| `libjsapi_softvideo.so` | 设备自带软解/音频 JSAPI（听视频、看视频音频轨、回退链路使用） |
| `libjsapi_nekolib.so` | 设备自带 shell/文件等 JSAPI（拉起 daemon、日志等使用） |
| `app_icon.png` | 应用图标 |
| `.gitignore`、`.gitattributes` | 构建产物与二进制的 git 配置 |

构建产物：`9002000869905604.amr`（不入库，见 Releases）。

## 安装

前置：设备已开启 adb，且已具备 Falcon 轻应用运行时。

```bash
adb push 9002000869905604.amr /userdisk/
adb shell "miniapp_cli install /userdisk/9002000869905604.amr"
adb shell "miniapp_cli start 9002000869905604"
```

也可从 [Releases](https://github.com/3804313647/bilipen/releases) 下载最新 AMR。

## 使用

- 左侧导航切换「推荐 / 搜索 / 登录」
- 点任意视频卡片进入详情页，再选「▶ 看视频」「🎧 听视频」「⬇ 下载」
- 播放层右上角可在「适应 / 铺满」间切换显示方式，「✕ 退出播放」返回
- 登录：用手机 B 站 App 扫码（登录状态保存在设备本地）

## 构建

### 依赖

- **Python 3**：运行打包脚本
- **Go 1.22+**：交叉编译 daemon（`GOOS=linux GOARCH=arm GOARM=7 CGO_ENABLED=0`）
- **（仅重编 native 模块时需要）Rockchip 交叉工具链**：`arm-rockchip830-linux-uclibcgnueabihf`（crosstool-NG 1.24.0，GCC 8.3.0，来自 RV1106 SDK；Linux 宿主，Windows 下可用 WSL2）
- **（仅重编 native 模块时需要）FFmpeg 4.4.1 头文件与设备动态库**：`libavformat.so.58` / `libavcodec.so.58` / `libswscale.so.5` / `libavutil.so.56`（从设备 `/usr/lib` 拉取用于链接，运行期由设备解析）
- **（仅重编 native 模块时需要）QuickJS 2020-07-05 头文件**：`quickjs.h`

### 打包

```bash
python build_bili.py
# 输出 9002000869905604.amr
```

`build_bili.py` 会先尝试用本机 Go 重新编译 `bili_src/main.go`（没有 Go 时会提示并使用现有二进制），然后复制 `libs/arm/*.so`、生成 `app.js`、计算 manifest 证书并打包。

### 重新编译 native 模块（可选）

预编译的 `libjsapi_rgavideo.so` 已随仓库提供。只有修改 `native/rgavideo.c` 后才需要重编，参考流程（WSL2 验证过）：

```bash
# 1) 解压工具链
tar -xzf arm-rockchip830-linux-uclibcgnueabihf.tar.gz -C ~/a7tc

# 2) 准备头文件
#    QuickJS: https://bellard.org/quickjs/quickjs-2020-07-05.tar.xz
#    FFmpeg : https://mirrors.aliyun.com/ubuntu/pool/universe/f/ffmpeg/ffmpeg_4.4.1.orig.tar.xz
#    （FFmpeg 头目录需补一个生成的 avconfig.h：
#      printf '#define AV_HAVE_BIGENDIAN 0\n#define AV_HAVE_FAST_UNALIGNED 1\n' > libavutil/avconfig.h）

# 3) 从设备拉取链接用动态库
adb pull /usr/lib/libavformat.so.58.76.100 devlibs/libavformat.so
adb pull /usr/lib/libavcodec.so.58.134.100  devlibs/libavcodec.so
adb pull /usr/lib/libswscale.so.5.9.100     devlibs/libswscale.so
adb pull /usr/lib/libavutil.so.56.70.100    devlibs/libavutil.so

# 4) 交叉编译
TC=~/a7tc/arm-rockchip830-linux-uclibcgnueabihf
$TC/bin/arm-rockchip830-linux-uclibcgnueabihf-gcc -shared -fPIC -O2 \
  -fvisibility=hidden -I~/a7build -I~/a7build/ffmpeg-4.4.1 \
  -o libjsapi_rgavideo.so native/rgavideo.c \
  -Ldevlibs -lavformat -lavcodec -lswscale -lavutil -lm -lpthread -ldl \
  -Wl,--allow-shlib-undefined -Wl,-s
```

编译产物放到仓库根目录（`libjsapi_rgavideo.so`），`build_bili.py` 会自动打进 AMR 的 `libs/arm/`。

### native 模块接口

- 导出 `custom_init_jsapis`；通过运行时的 `registerCModuleLoader("rgavideo", loader)` 注册 QuickJS 模块
- JS 接口：`setBuffer(arrayBuffer,w,h)`、`start(url)`、`readFrame()`、`stop()`、`info()`、`error()`、`duration()`、`position()`
- 前端每 16ms 轮询一次，取到帧才 `putImageData`；模块不可用时自动回退到 softvideo 视频链路

## 已知限制

- **搜索键盘不可用**：原生软键盘不弹出，自绘键盘也未能生效，搜索页目前无法输入关键词（中文/英文都不行）
- 「下载」为占位按钮，未实现真实下载
- native 模块的 YUV→RGBA 用 ffmpeg `sws_scale`，尚未接入 RGA（RGA 需要 dma-buf/连续物理内存）
- 本地 `18080` 仅监听 `127.0.0.1`，未做鉴权
- 设备 UI 偶发触摸无响应/画面冻结（系统层问题，与本应用无关）

## 免责声明

本项目为个人学习与研究用途，与哔哩哔哩、网易有道均无关联；仓库内涉及的厂商库与图标版权归原权利人。
