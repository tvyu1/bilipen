#!/bin/bash
set -e
mkdir -p /root/a7build && cd /root/a7build
echo "== quickjs.h includes =="
grep -n '#include' quickjs.h | head -10
echo "== fetch ffmpeg 4.4.1 source (aliyun) =="
if [ ! -d ffmpeg-4.4.1 ]; then
  [ -f ffmpeg_4.4.1.orig.tar.xz ] || curl -sL --max-time 300 -o ffmpeg_4.4.1.orig.tar.xz https://mirrors.aliyun.com/ubuntu/pool/universe/f/ffmpeg/ffmpeg_4.4.1.orig.tar.xz
  ls -l ffmpeg_4.4.1.orig.tar.xz
  tar -xJf ffmpeg_4.4.1.orig.tar.xz
fi
ls -d ffmpeg-4.4.1 && ls ffmpeg-4.4.1/libavcodec/avcodec.h ffmpeg-4.4.1/libavformat/avformat.h ffmpeg-4.4.1/libswscale/swscale.h
echo "== device libs symlink dir =="
mkdir -p /root/a7build/devlibs
D=/mnt/e/dw/youdaokaifa-a7/scratch/libav_arm
ln -sf "$D/libavcodec.so.58.134.100"  devlibs/libavcodec.so
ln -sf "$D/libavformat.so.58.76.100"  devlibs/libavformat.so
ln -sf "$D/libavutil.so.56.70.100"    devlibs/libavutil.so
ln -sf "$D/libswscale.so.5.9.100"     devlibs/libswscale.so
ln -sf "$D/libswresample.so.3.9.100"  devlibs/libswresample.so
ln -sf "$D/librga.so"                 devlibs/librga.so
ls -l devlibs
echo "== compile smoke test =="
TC=/root/a7tc/arm-rockchip830-linux-uclibcgnueabihf
GCC=$TC/bin/arm-rockchip830-linux-uclibcgnueabihf-gcc
cat > /tmp/smoke.c <<'EOF'
#include <stdio.h>
#include "quickjs.h"
#include "libavcodec/avcodec.h"
#include "libavformat/avformat.h"
#include "libswscale/swscale.h"
int smoke(void) { return JS_NewCFunction2 != 0 && avcodec_version() != 0; }
EOF
$GCC -shared -fPIC -O2 -I. -Iffmpeg-4.4.1 \
  -o /tmp/libsmoke.so /tmp/smoke.c \
  -Ldevlibs -lavformat -lavcodec -lswscale -lavutil -lm -lpthread -ldl
file /tmp/libsmoke.so
$TC/bin/arm-rockchip830-linux-uclibcgnueabihf-readelf -d /tmp/libsmoke.so | grep NEEDED | head
