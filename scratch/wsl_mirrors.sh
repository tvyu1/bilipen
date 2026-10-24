#!/bin/bash
TC=/root/a7tc/arm-rockchip830-linux-uclibcgnueabihf
echo "== runtime_lib =="
ls -l "$TC/runtime_lib" 2>/dev/null
tar -tjf "$TC/runtime_lib/lib.tar.bz2" 2>/dev/null | grep -E 'libav|swscale|librga|libdrm|libasound' | head -15
echo "== mirrors ffmpeg =="
for u in \
  https://mirrors.tuna.tsinghua.edu.cn/ffmpeg/releases/ffmpeg-4.4.1.tar.xz \
  https://mirrors.ustc.edu.cn/ffmpeg/releases/ffmpeg-4.4.1.tar.xz \
  https://mirrors.huaweicloud.com/ffmpeg/releases/ffmpeg-4.4.1.tar.xz \
  https://mirrors.aliyun.com/ffmpeg/releases/ffmpeg-4.4.1.tar.xz ; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 12 -r 0-1023 "$u" || true)
  echo "$code $u"
done
echo "== mirrors quickjs =="
for u in \
  https://gitee.com/mirrors/quickjs/repository/archive/v2020-07-05.tar.gz \
  https://gitee.com/quickjs/quickjs/repository/archive/v2020-07-05.tar.gz \
  https://mirrors.tuna.tsinghua.edu.cn/quickjs/quickjs-2020-07-05.tar.xz ; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 12 -r 0-1023 "$u" || true)
  echo "$code $u"
done
echo "== apt sources =="
grep -h -m3 -E '^(deb|URIs)' /etc/apt/sources.list /etc/apt/sources.list.d/* 2>/dev/null | head -6
