# native/rgavideo.c —— 自研 native 视频解码模块

`libjsapi_rgavideo.so` 用 FFmpeg 软件解码替换 softvideo 的视频解码链路，把看视频从 10–12fps 提升到 ~30fps。
源码为 `rgavideo.c`，编译产物 `../libjsapi_rgavideo.so` 已随仓库提交（13,820 字节），因此**普通构建不需要工具链**；
只有修改 C 源码后才需要重新交叉编译。

## 依赖

- Rockchip 交叉工具链：`arm-rockchip830-linux-uclibcgnueabihf-gcc 8.3.0`（crosstool-NG）
- 设备自带 FFmpeg 4.4.1 动态库（链接用，运行期由设备 `/usr/lib` 解析）：
  `libavformat.so.58` / `libavcodec.so.58` / `libswscale.so.5` / `libavutil.so.56`
- 头文件：
  - QuickJS 2020-07-05 的 `quickjs.h`
  - FFmpeg 4.4.1 源码头（`libavformat/avformat.h` 等；需自行生成 `libavutil/avconfig.h`）

## 在 WSL 中构建（本机验证过的方式）

```bash
# 1) 解压工具链
tar -xzf arm-rockchip830-linux-uclibcgnueabihf.tar.gz -C ~/a7tc

# 2) 准备头文件（国内镜像）
#    QuickJS: https://bellard.org/quickjs/quickjs-2020-07-05.tar.xz
#    FFmpeg : https://mirrors.aliyun.com/ubuntu/pool/universe/f/ffmpeg/ffmpeg_4.4.1.orig.tar.xz
#    解压后把 avconfig.h 补进 FFmpeg 头目录：
#    printf '#define AV_HAVE_BIGENDIAN 0\n#define AV_HAVE_FAST_UNALIGNED 1\n' > libavutil/avconfig.h

# 3) 从设备拉取链接用 .so（或使用 SDK 中的同名库）
adb pull /usr/lib/libavformat.so.58.76.100 devlibs/libavformat.so
adb pull /usr/lib/libavcodec.so.58.134.100  devlibs/libavcodec.so
adb pull /usr/lib/libswscale.so.5.9.100     devlibs/libswscale.so
adb pull /usr/lib/libavutil.so.56.70.100    devlibs/libavutil.so

# 4) 交叉编译
TC=~/a7tc/arm-rockchip830-linux-uclibcgnueabihf
$TC/bin/arm-rockchip830-linux-uclibcgnueabihf-gcc -shared -fPIC -O2 \
  -fvisibility=hidden -I~ /a7build -I~/a7build/ffmpeg-4.4.1 \
  -o libjsapi_rgavideo.so rgavideo.c \
  -Ldevlibs -lavformat -lavcodec -lswscale -lavutil -lm -lpthread -ldl \
  -Wl,--allow-shlib-undefined -Wl,-s
```

编译产物放回仓库根目录（`../libjsapi_rgavideo.so`），`build_bili.py` 会自动打进 AMR 的 `libs/arm/`。

## 模块契约

- 导出：`custom_init_jsapis`（运行时 `dlopen` 每个 `libjsapi_*.so` 后调用）
- 注册：`registerCModuleLoader("rgavideo", loader)`，`JS_NewCModule` + `JS_SetModuleExport("default")`
  （与官方 `libjsapi_nekolib.so` 相同的注册方式；QuickJS 符号由运行时导出）
- JS 接口：
  - `setBuffer(arrayBuffer, w, h)`：RGBA 目标缓冲（= `ImageData.data.buffer`）
  - `start(url)` / `stop()`
  - `readFrame()`：有新帧则 memcpy 到 JS 缓冲并返回 1，否则 0
  - `info()` → `{width,height,duration,position,finished}`
  - `error()` / `duration()` / `position()`
- 内部：FFmpeg 解码 → `sws_scale` YUV420→RGBA → 双缓冲 → PTS 节奏（按帧时间戳 sleep）→ 消费不及时最多等 40ms 后丢帧。
- 音频：本模块不处理；前端并行用 `SoftVPlayer` 播 `/api/audio?variant=remux`。

## 已知边界

- 尚未接入 RGA：`sws_scale` 是 CPU 转换。设备有 `/dev/rga` 与 `librga.so`（`c_RkRgaInit/c_RkRgaBlit`），
  但 RGA 需要 dma-buf/连续物理内存，而当前帧来自 FFmpeg 的普通 malloc 缓冲；后续可替换转换步骤。
