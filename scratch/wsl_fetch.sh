#!/bin/bash
set -e
cd /root
mkdir -p a7build && cd a7build
echo "== fetch quickjs =="
if [ ! -f quickjs.h ]; then
  curl -sL --max-time 120 -o quickjs.tar.xz https://bellard.org/quickjs/quickjs-2020-07-05.tar.xz
  ls -l quickjs.tar.xz
  tar -xJf quickjs.tar.xz --strip-components=1 quickjs-2020-07-05/quickjs.h quickjs-2020-07-05/quickjs-atom.h quickjs-2020-07-05/cutils.h 2>/dev/null || tar -xJf quickjs.tar.xz
  ls -l quickjs.h 2>/dev/null || true
fi
echo "== fetch ffmpeg headers =="
if [ ! -f ffmpeg-4.4.1/libavcodec/avcodec.h ]; then
  curl -sL --max-time 300 -o ffmpeg.tar.xz https://ffmpeg.org/releases/ffmpeg-4.4.1.tar.xz
  ls -l ffmpeg.tar.xz
  tar -xJf ffmpeg.tar.xz
  ls -d ffmpeg-4.4.1
fi
ls -l quickjs.h && ls ffmpeg-4.4.1/libavcodec/avcodec.h
