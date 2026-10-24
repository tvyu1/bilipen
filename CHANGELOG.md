# CHANGELOG

## v2.2.0（2026-10-24）

> 主题：自研 native 视频解码模块，看视频 10–12fps → **~30fps**。

### 新增

- **`libjsapi_rgavideo.so`**（13,820 字节）：用 Rockchip `arm-rockchip830-linux-uclibcgnueabihf-gcc 8.3.0` 交叉编译，链接设备自带 FFmpeg 4.4.1（libavformat/libavcodec/libswscale/libavutil）。实现 FFmpeg 软件解码 + `sws_scale` YUV420→RGBA + 双缓冲 + PTS 节奏与丢帧；通过 `registerCModuleLoader("rgavideo", …)` 注册 QuickJS 模块，JS 每 16ms 轮询 `readFrame()` 取帧后 `putImageData`。
- **看视频音频并行**：native 解码的同时用 `SoftVPlayer` 播放 `/api/audio?variant=remux`（DASH 最高音轨 + ffmpeg 重封装），失败自动重试两次。
- **安全回退**：模块导入或初始化异常时自动回退原 softvideo 视频链路。

### 修复

- **播放卡顿根因**：线程级采样显示旧链路 `video_decoder` 占 72–79% 单核，JS 渲染仅 17–21%；同机 ffmpeg 解同一文件仅 30%（解码）/42%（解码+RGBA），即 softvideo 低效约 5 倍。新链路把解码交给 ffmpeg。
- **音频 remux 起播竞态**：首字节前可能报 `streamDecoder init failed`，增加两次自动重试。

### 实测

- native 播放：`draws/s=25–34`（约 30fps），单帧 14–17ms，`maxgap` 58–80ms（偶发 150–394ms）。
- 整机 CPU 55–82%（旧链路 95–98% 且仅 10–12fps）。
- 音频正常。

### 已知问题

- 尚未接入 RGA 做 YUV→RGBA 转换（当前 `sws_scale`）。
- 搜索键盘仅英文/数字；「下载」为占位；扫码登录成功链路待真实扫码验证。
