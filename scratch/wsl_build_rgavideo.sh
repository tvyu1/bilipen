#!/bin/bash
set -e
TC=/root/a7tc/arm-rockchip830-linux-uclibcgnueabihf
GCC=$TC/bin/arm-rockchip830-linux-uclibcgnueabihf-gcc
BUILD=/root/a7build
SRC=/mnt/e/dw/youdaokaifa-a7/native/rgavideo.c
OUT=/mnt/e/dw/youdaokaifa-a7/libjsapi_rgavideo.so
cd "$BUILD"
echo "== compile =="
$GCC -shared -fPIC -O2 -fvisibility=hidden \
  -I"$BUILD" -I"$BUILD/ffmpeg-4.4.1" \
  -o "$OUT" "$SRC" \
  -L"$BUILD/devlibs" -lavformat -lavcodec -lswscale -lavutil -lm -lpthread -ldl \
  -Wl,--allow-shlib-undefined -Wl,-s
echo "== result =="
ls -l "$OUT"
file "$OUT"
$TC/bin/arm-rockchip830-linux-uclibcgnueabihf-readelf -d "$OUT" | grep -E 'NEEDED|SONAME' | head -12
echo "== exports =="
$TC/bin/arm-rockchip830-linux-uclibcgnueabihf-nm -D "$OUT" 2>/dev/null | grep -E 'custom_init_jsapis|registerCModuleLoader|JS_NewCModule|U ' | head -12
