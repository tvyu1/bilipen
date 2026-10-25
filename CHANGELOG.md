# CHANGELOG

## v2.4.2（2026-10-25）

> 主题：**全面稳定性加固与工程化重构**（P0/P1/P2 技术债务与高危风险修复）。

### 稳定性与防冻屏（P0）

- **FFmpeg 网络超时中断机制**：在 `native/rgavideo.c` 中为 `AVFormatContext` 挂载 `decode_interrupt_cb`。当用户在弱网或播放中退出时，立即中断阻塞中的 `avformat_open_input` 与 `av_read_frame`，彻底杜绝主线程 `pthread_join` 死等引发的系统冻屏（ANR）。
- **磁盘存储防耗尽（运行时自动清理）**：在 `bili_src/main.go` 中新增 `cleanCovers()` 将封面缓存上限限制为 120 张；在每次发起视频预取与每隔 10 分钟自动执行 `cleanCache()`，杜绝长时间运行占满 `/userdisk` 分区。
- **构建环境自愈报错**：`build_bili.py` 优化了未安装 Go 编译器时的友好提示，防止直接抛出 `FileNotFoundError` 异常中断。

### 待机功耗与性能（P1）

- **守护进程 5 分钟空闲自动退出**：在 Go 守护进程中新增 `idleWatchdog` 活动监视器，无网络请求且未播放 5 分钟后优雅退出，彻底解决退出应用后后台常驻空转导致的严重待机掉电问题。
- **CPU 轮询降频与单核减负**：针对机型无独立硬件音量控件的特性，将 `volumeSyncLoop` 空转周期由 100ms 降频至 2 秒；`startCPULogger` 在空闲期间休眠延长至 10 秒。
- **B 站官方 WBI 签名支持**：在 Go 守护进程中完整实现 B 站 WBI 鉴权算法（含 mixin key 重排与 `w_rid`/`wts` 动态计算），feed 推荐与搜索接口改用 WBI 签名端点，彻底消除 `-412` 反爬拦截隐患。
- **代码健壮性与静态分析**：修复 32 位 ARM 上 `position`/`duration` 64 位浮点数的数据竞争；重构 `shmMemPtr` 共享内存读取逻辑，完全消除 `go vet` 的 `unsafe.Pointer` 违规报警。

### 工程化与代码解耦（P2）

- **解耦前端代码巨石**：将 `build_bili.py` 中硬编码的 2500+ 行 Vue2 前端源码正式抽离至独立的 `frontend/app.js` 目录，构建脚本只保留装配与签名流程，恢复前端模块化可维护性。
- **死代码清理**：清理了已关闭的动态音画对齐 `if (false)` 调试块。

---

## v2.4.1（2026-10-25）

> 主题：**修复搜索输入**（接入系统原生输入法）+ 界面精简。本版包含 v2.4.0 的全部内容。

### 修复

- **搜索一直无法输入**：该机型 `$falcon.startTextEdit` 为 `undefined`（文档中的 `$falcon` 入口在此固件不存在）。实际 API 由设备自带的 `/etc/miniapp/jsapis/libjsapi_export_core.so` 通过 JS 模块 `global` 提供：
  - `import('global').default.Global` 是**构造函数**，必须 `new` 出实例后才有 `startTextEdit / closeTextEdit / textEditFinished`；
  - `textEditFinished` 实际回调为 **两个参数** `(taskUuid, resultJson)`（`{"text":"…","cursorIndex":N,"editConfirmed":true}`），此前包装函数只声明 1 个参数、丢掉了结果 JSON，导致输入框拿不到文字；
  - 现在完整转发参数并解析，`editConfirmed=true` 时自动搜索。
- **移除左侧导航底部「停止播放」按钮**：播放层右上角已有「✕ 退出播放」，该按钮冗余，删除模板与样式。

### 新增

- **搜索框清空按钮**：输入框右侧圆形「✕」，一键清空关键词与结果列表。

### 实测

- 搜索页可正常调起系统输入法，输入「fe」「kkk」「喂喂喂」等中英文内容后点「搜索」均能自动查询并列出结果；清空按钮、移除停止按钮后的布局均正常。

### 已知问题

- 「下载」为占位按钮（见 README TODO）。
- 音频停止后约 1 秒尾音、偶发爆音/失真（低优先级）。
- 尚未接入 RGA 做 YUV→RGBA 转换（当前 `sws_scale`）。
