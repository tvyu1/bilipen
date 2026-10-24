# CHANGELOG

## v2.2.1（2026-10-24）

> 主题：**修复连续播放/退出应用后的系统级崩溃**（宿主进程崩溃 → 系统 UI 重载），并降低渲染负载。

### 修复

- **系统级崩溃（核心修复）**
  - 真机表现：连续「起播 → 返回/退出应用 → 播放下一个」后，系统 UI 突然重载（宿主 falcon 进程崩溃，由 `guardian_run` 拉起），严重时触发 `runDictPen` 的连续崩溃看门狗重启。
  - 通过 core dump（390MB，真机生成 + ARM gdb 分析）定位：崩溃发生在 JS 定时器回调 `getImageData(160,90)` → `JS_NewArrayBufferCopy` → 设备 libc 内 mimalloc 分配器，此时堆元数据已被写成 `0xFF010101`（一个近黑视频像素值）。
  - 根因：传给 vendor `SoftVPlayer` 的 160×90 像素缓冲区（57,600 字节）在 JS 侧只是局部变量，QuickJS GC 会将其回收，而 vendor 解码线程仍持续向该内存写像素 → 踩坏 mimalloc 堆 → 之后任意一次 malloc（如图片解码 / `getImageData`）随机崩溃。
  - 修复：JS 侧持有该缓冲区强引用（`_audioImageData`），仅在播放器 `stop()` 完成后、下次起播覆盖引用时才允许释放。

- **大封面图内存压力**：远程封面统一追加 B 站图片处理后缀 `@320w_180h.jpg`（解码位图 14.7MB → 230KB），消除日志中的 `BitmapFactory: image is too too large` 告警与瞬时内存峰值。

- **降低单核负载**：native 渲染上限 **24fps**（减少 1/4 的 `readFrame` 帧拷贝与 `putImageData`）；`sws_scale` 插值由 `SWS_BILINEAR` 改为 `SWS_FAST_BILINEAR`。

- **停止流程简化**：不再在 `/api/stop` 时主动取消媒体流 / 暂停播放器（该顺序曾触发厂商播放器状态机异常，加重崩溃），改为依赖播放器自身 `stop()`。

### 实测

- 连续「起播 → 退出应用 → 换下一个」5–10 次：修复前必然崩溃，修复后不再崩溃（用户确认）。
- 24fps 渲染下画面流畅度可接受；爆音/失真有所改善（用户确认）。

### 已知问题

- 音频：停止后约 1 秒尾音、偶发爆音/失真、音画同步一般（**优先级低**，见 README 的 TODO/路线图）。
- 搜索键盘不可用（输入法问题），下载为占位按钮。
- 尚未接入 RGA 做 YUV→RGBA 转换（当前 `sws_scale`）。
