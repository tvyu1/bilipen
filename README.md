# 笔上哔哩 (BiliPen)

网易有道词典笔 A7（型号 `Y09`）上的哔哩哔哩轻应用：Falcon 运行时（Vue2 + QuickJS）前端 + Go 守护进程 + 自研 native 视频解码模块。

**当前版本：v2.2.0** · 版本说明见 [CHANGELOG.md](CHANGELOG.md)

## 功能

- 推荐流、搜索、扫码登录
- 视频详情页：**看视频 / 听视频 / 下载（占位）**
- 看视频：自研 native 模块（FFmpeg 4.4.1 软件解码 + `sws_scale`），真机约 **30fps**
- 听视频：B 站 DASH 最高音质音轨，由 daemon 调用设备 ffmpeg 重封装后播放
- 搜索页自绘屏幕键盘（该机型 miniapp 原生软键盘不弹出；仅英文/数字）
- 整段预取本地缓存，`/api/stream` 缓存优先并支持 Range/206

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
- 搜索：点输入框弹出屏幕键盘，输入后点「搜索」
- 登录：用手机 B 站 App 扫码

## 构建

前置：Python 3、Go 1.22+（用于编译 daemon）。

- **前端 / 打包**：`python build_bili.py`（生成 `9002000869905604.amr`，自动编译 Go daemon 并重算 manifest 证书）
- **daemon**：`bili_src/main.go`（Go，交叉编译到 linux/arm）
- **native 模块**：`native/rgavideo.c`；预编译的 `libjsapi_rgavideo.so` 已随仓库提供，重新编译需要 Rockchip `arm-rockchip830-linux-uclibcgnueabihf` 工具链与设备 FFmpeg 4.4.1 库

## 已知限制

- 搜索键盘仅英文/数字，中文输入暂不可用
- 「下载」为占位按钮，未实现真实下载
- native 模块的 YUV→RGBA 转换用 ffmpeg `sws_scale`，尚未接入 RGA
- 本地 18080 仅监听 `127.0.0.1`，未做鉴权

## 免责声明

本项目为个人学习与研究用途，与哔哩哔哩、网易有道均无关联；仓库内涉及的厂商库与图标版权归原权利人。
