# -*- coding: utf-8 -*-
"""全文档一致性校验：链接存在性、标题结构、版本/关键数字一致性。"""
import io
import os
import re

ROOT = r"E:\dw\youdaokaifa-a7"
DOCS = [
    "README.md",
    "CHANGELOG.md",
    "BiliPen-审计与改进方案.md",
    "网易有道A7词典笔软硬件全栈与Miniapp_AMR开发技术手册.md",
    "笔上哔哩_开发技术手册.md",
]

print("=== 文档清单 ===")
for d in DOCS:
    p = os.path.join(ROOT, d)
    n = sum(1 for _ in io.open(p, encoding="utf-8"))
    print(f"{d}: {n} 行, {os.path.getsize(p)} bytes")

print("\n=== 本地 Markdown 链接存在性 ===")
bad = []
for d in DOCS:
    s = io.open(os.path.join(ROOT, d), encoding="utf-8").read()
    for m in re.finditer(r"\]\(([^)#]+?)(?:#[^)]*)?\)", s):
        target = m.group(1).strip()
        if target.startswith(("http", "file:", "mailto:")):
            continue
        tp = os.path.join(ROOT, target.replace("/", "\\"))
        if not os.path.exists(tp):
            bad.append((d, target))
print("缺失链接:", bad if bad else "无")

print("\n=== 版本号一致性（应全部为 2.0.0，除历史段） ===")
for d in DOCS:
    s = io.open(os.path.join(ROOT, d), encoding="utf-8").read()
    v2 = len(re.findall(r"2\.0\.0", s))
    v1 = len(re.findall(r"1\.0\.0", s))
    print(f"{d}: 2.0.0 x{v2}, 1.0.0 x{v1}")

print("\n=== 关键数字抽查 ===")
checks = {
    "README.md": ["2.56MB", "5.9MB", "640×360", "306×172"],
    "CHANGELOG.md": ["onInfo", "setVideoInfo", "120s", "2.56MB"],
    "BiliPen-审计与改进方案.md": ["onInfo", "sig.off(token)", "160", "2.56MB"],
    "网易有道A7词典笔软硬件全栈与Miniapp_AMR开发技术手册.md": ["(width, height, duration)", "offset 4", "不存在 25 号控件", "killall"],
    "笔上哔哩_开发技术手册.md": ["未落地", "方案 A", "v2.0.0"],
}
for d, keys in checks.items():
    s = io.open(os.path.join(ROOT, d), encoding="utf-8").read()
    miss = [k for k in keys if k not in s]
    print(f"{d}: {'OK' if not miss else '缺少 ' + str(miss)}")

print("\n=== 标题结构（一级/二级标题数） ===")
for d in DOCS:
    s = io.open(os.path.join(ROOT, d), encoding="utf-8").read()
    h1 = len(re.findall(r"^# ", s, re.M))
    h2 = len(re.findall(r"^## ", s, re.M))
    print(f"{d}: H1={h1}, H2={h2}")

print("\n=== 过期表述扫描 ===")
stale = ["待更新", "已修复」结论与现状不符", "设备当前离线", "pkill -f 'libs/bili-daemon'"]
for d in DOCS:
    s = io.open(os.path.join(ROOT, d), encoding="utf-8").read()
    hits = [k for k in stale if k in s]
    if hits:
        print(f"{d}: {hits}")
print("扫描完成")
