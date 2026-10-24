# CHANGELOG

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
