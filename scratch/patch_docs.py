# -*- coding: utf-8 -*-
import io

p = "BiliPen-审计与改进方案.md"
s = io.open(p, encoding="utf-8").read()

old_head = """> 审计对象：`E:\\dw\\youdaokaifa-a7`（作品「笔上哔哩」，网易有道词典笔 A7 第三方 B 站客户端）
> 方法：源码逐行审计 + ARM 反汇编（libjsapi_softvideo.so）+ 官方播放器 QuickJS 字节码逆向（静态，设备当时离线）
> 结论可信度：代码级结论均有行号证据；平台行为类结论已标注「待真机验证」"""
new_head = """> 审计对象：`E:\\dw\\youdaokaifa-a7`（作品「笔上哔哩」，网易有道词典笔 A7 第三方 B 站客户端）
> 方法：源码逐行审计 + ARM 反汇编（libjsapi_softvideo.so / libfalcon.so）+ 官方播放器 QuickJS 字节码逆向 + **真机验证**
> 状态：**2026-10-24 已完成 v2.0.0 修复与真机回归**；缺陷处理状态见 §0.1，验证记录见 §7（前端）与 §8（daemon）"""
s = s.replace(old_head, new_head, 1)

anchor = "---\n\n## 1. 项目全貌"
status = """### 0.1 缺陷处理状态（2026-10-24，v2.0.0）

| 原编号 / 缺陷 | 状态 | 处理与证据 |
|---|---|---|
| P0-1 `onInfo` 参数顺序错 | 已修复 | 真机日志证实 `(width,height,duration)`；修正并夹紧尺寸（§7.1） |
| P0-2 缓冲尺寸与 canvas 位图失配 / 条纹 | 已修复 | 起播前 `setVideoInfo(640,360)` 强制输出尺寸；截图无条纹（§7.2） |
| P0-3 播放/停止定时器竞态 | 已修复 | `playGen` 代次锁 + 定时器取消 + 延迟卸载代次校验（§7.5） |
| P0-4 daemon 双实例 / 版本错配 | 已修复 | `killall` + 单槽启动 + `/api/ping` 版本校验（§7.4、§8.1） |
| P0-5 `/api/stream` 120s 截断长视频 | 已修复 | 上下文 + 45s 空闲看门狗；160s 长视频实测不断（§8.1） |
| P0-6 canvas 物理位图宽度默认 300 隐患 | 已核对 | attrs 显式 640×360 生效（日志 `Initial buffer set: 640x360`） |
| P1-8 `.on(null)` 解绑抛异常导致线程泄漏 | 已修复 | 改为 `sig.off(token)`；teardown 日志完整（§7.3） |
| P1 扫码登录 Cookie / 明文 0644 / -101 误清 | 部分修复 | 代码已加固；**成功路径待真实扫码验证**（§8.1、§8.3） |
| P1 封面并发与缓存半截 | 已修复 | 并发≤3 + tmp→rename（§8.1） |
| P1 长视频断流、playurl 重复解析 | 已修复 | 缓存 + Range/206 + backup 回退（§8.1） |
| P1 音量线程写不存在控件 | 已修复并更正机制 | HAL 读 vctl 实现音量；daemon 只读展示（§8.2） |
| P1 本地 18080 无鉴权 | 暂不实现 | 项目决定跳过（§8.3） |
| P1 `/api/status` 语义虚假（ffmpeg 死代码） | 已修复 | 改为真实会话语义（§8.1） |
| P2 前端状态机/幽灵层/重复点击等 | 部分修复 | pollStatus 已移除、代次锁已加；其余见 §2.2 未处理项 |
| 打包：daemon 未 strip / 包体大 / 版本号 | 已修复 | 自动编译 strip；4.69MB→2.56MB；版本 2.0.0（§8.1） |

---

## 1. 项目全貌"""
s = s.replace(anchor, status, 1)

s = s.replace("│                   └─ volumeSyncLoop                  SysV shm 0x7663746c → tinymix 23/25",
              "│                   └─ VolumeReader (只读)              SysV shm 0x7663746c（音量由 HAL 读取生效）")
s = s.replace("│                   ├─ /api/play|stop|status           播放会话登记（与实际播放器脱节）",
              "│                   ├─ /api/play|stop|status           播放会话登记（v2 已与会话语义对齐）")
s = s.replace("[bili_src/main.go](bili_src/main.go) | 754 行", "[bili_src/main.go](bili_src/main.go) | 981 行")
s = s.replace("[build_bili.py](build_bili.py) | 1137 行", "[build_bili.py](build_bili.py) | 1220 行")
s = s.replace("[README.md](README.md) | 285 行 | 成品说明（§4.1 的「已修复」结论与现状不符，需更新）",
              "[README.md](README.md) | 当前版本说明（v2.0.0 现状、API 契约、部署与排障）")
s = s.replace("| [scratch/](scratch/) | 125 文件", "| [scratch/](scratch/) | 逆向脚本与官方字节码")
s = s.replace("| [bili_pkg/manifest.json](bili_pkg/manifest.json) | 39 行 |", "| [bili_pkg/manifest.json](bili_pkg/manifest.json) | cert + 版本 |")
s = s.replace("## 3. 条纹根因：先测量，再动手",
              "## 3. 条纹根因：先测量，再动手（已于 2026-10-24 完成，结论见 §7.2 / §8.1）")
s = s.replace("## 6. 待真机验证清单（设备当前离线）",
              "## 6. 待验证清单（大部分已在 §7/§8 完成；剩余见 §8.3）")
s = s.replace("### 4.1 短期（0.5–1 天，只改必要点）",
              "### 4.1 短期（0.5–1 天，只改必要点）—— 已全部实施并验证（v2.0.0）")

io.open(p, "w", encoding="utf-8", newline="\n").write(s)
print("report patched; lines:", s.count("\n") + 1)
