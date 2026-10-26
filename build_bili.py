#!/usr/bin/env python3
import os
import json
import hashlib
import zipfile
import shutil
import subprocess

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PKG_DIR = os.path.join(BASE_DIR, "bili_pkg")
OUTPUT_AMR = os.path.join(BASE_DIR, "9002000869905604.amr")
FRONTEND_APP_JS = os.path.join(BASE_DIR, "frontend", "app.js")


def build_daemon():
    """存在 Go 工具链时自动重新编译守护进程，避免打进包的是旧二进制。"""
    go = shutil.which("go")
    src_dir = os.path.join(BASE_DIR, "bili_src")
    out = os.path.join(src_dir, "bili-daemon")
    if not go:
        if not os.path.exists(out):
            raise RuntimeError(
                "未找到 Go 编译环境，且本地不存在预编译守护进程: %s\n"
                "请先安装 Go 1.22+，或将预编译好的 bili-daemon 放入 bili_src 目录。" % out
            )
        print("[Warn] 未找到 go，使用现有 bili_src/bili-daemon")
        return
    env = dict(os.environ)
    env.update({"GOOS": "linux", "GOARCH": "arm", "GOARM": "7", "CGO_ENABLED": "0"})
    cmd = [go, "build", "-trimpath", "-ldflags", "-s -w -buildid=", "-o", out, "."]
    subprocess.run(cmd, cwd=src_dir, env=env, check=True)
    print("[Build] bili-daemon = %d bytes" % os.path.getsize(out))


build_daemon()

# 1. Clean & prepare directory
os.makedirs(os.path.join(PKG_DIR, "libs", "arm"), exist_ok=True)

# 2. Copy compiled binary & libraries
src_daemon = os.path.join(BASE_DIR, "bili_src", "bili-daemon")
dst_daemon = os.path.join(PKG_DIR, "libs", "arm", "bili-daemon")
shutil.copy2(src_daemon, dst_daemon)

src_nekolib = os.path.join(BASE_DIR, "libjsapi_nekolib.so")
dst_nekolib = os.path.join(PKG_DIR, "libs", "arm", "libjsapi_nekolib.so")
shutil.copy2(src_nekolib, dst_nekolib)

src_softvideo = os.path.join(BASE_DIR, "libjsapi_softvideo.so")
dst_softvideo = os.path.join(PKG_DIR, "libs", "arm", "libjsapi_softvideo.so")
shutil.copy2(src_softvideo, dst_softvideo)

src_rgav = os.path.join(BASE_DIR, "libjsapi_rgavideo.so")
if os.path.exists(src_rgav):
    shutil.copy2(src_rgav, os.path.join(PKG_DIR, "libs", "arm", "libjsapi_rgavideo.so"))

src_icon = os.path.join(BASE_DIR, "app_icon.png")
dst_icon = os.path.join(PKG_DIR, "app_icon.png")
shutil.copy2(src_icon, dst_icon)

# 3. Copy app.js from frontend source directory
if not os.path.exists(FRONTEND_APP_JS):
    raise FileNotFoundError("前端源码缺失: %s" % FRONTEND_APP_JS)

shutil.copy2(FRONTEND_APP_JS, os.path.join(PKG_DIR, "app.js"))
print("[Build] app.js copied from frontend/app.js (%d bytes)" % os.path.getsize(FRONTEND_APP_JS))

# 4. Manifest template
manifest = {
    "appName": "笔上哔哩",
    "version": "2.4.6",
    "appid": "9002000869905604",
    "icon": "app_icon.png",
    "quickjs": {
        "version": "20200705",
        "bigNum": False
    },
    "props": {
        "addDesktop": {
            "y09_platform": True
        },
        "supportUnInstall": True,
        "supportCleanUp": True
    },
    "cert": {}
}

# 5. Calculate cert (size & md5) for all files except manifest.json
def get_file_info(filepath):
    with open(filepath, 'rb') as f:
        data = f.read()
        return len(data), hashlib.md5(data).hexdigest()

for root, dirs, files in os.walk(PKG_DIR):
    for file in files:
        if file == "manifest.json":
            continue
        full_path = os.path.join(root, file)
        rel_path = os.path.relpath(full_path, PKG_DIR).replace("\\", "/")
        size, md5_val = get_file_info(full_path)
        manifest["cert"][rel_path] = {
            "size": size,
            "md5": md5_val
        }

manifest_path = os.path.join(PKG_DIR, "manifest.json")
with open(manifest_path, 'w', encoding='utf-8') as f:
    json.dump(manifest, f, indent=2, ensure_ascii=False)

# 6. Create ZIP (AMR)
with zipfile.ZipFile(OUTPUT_AMR, 'w', zipfile.ZIP_DEFLATED) as z:
    for root, dirs, files in os.walk(PKG_DIR):
        for file in files:
            full_path = os.path.join(root, file)
            rel_path = os.path.relpath(full_path, PKG_DIR).replace('\\', '/')
            zinfo = zipfile.ZipInfo(rel_path)
            zinfo.compress_type = zipfile.ZIP_DEFLATED
            if file == "bili-daemon" or file.endswith(".sh") or file.endswith(".so"):
                zinfo.external_attr = (0o755 << 16) | 0o100000
            else:
                zinfo.external_attr = (0o644 << 16) | 0o100000
            with open(full_path, 'rb') as f_in:
                z.writestr(zinfo, f_in.read())

print(f"[Build Success] AMR Archive created at: {OUTPUT_AMR} ({os.path.getsize(OUTPUT_AMR)} bytes)")
