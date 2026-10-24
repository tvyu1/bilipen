#!/bin/bash
TC=/root/a7tc/arm-rockchip830-linux-uclibcgnueabihf
mkdir -p /root/a7build && cd /root/a7build
echo "== runtime_lib content =="
tar -tjf "$TC/runtime_lib/lib.tar.bz2" 2>/dev/null | head -30
echo "== fetch ffmpeg (huawei) =="
if [ ! -f ffmpeg-4.4.1.tar.xz ]; then
  curl -sL --max-time 300 -o ffmpeg-4.4.1.tar.xz https://mirrors.huaweicloud.com/ffmpeg/releases/ffmpeg-4.4.1.tar.xz
fi
ls -l ffmpeg-4.4.1.tar.xz
if [ ! -d ffmpeg-4.4.1 ]; then tar -xJf ffmpeg-4.4.1.tar.xz; fi
ls ffmpeg-4.4.1/libavcodec/avcodec.h
echo "== fetch quickjs.h via proxies =="
for u in \
  https://ghproxy.net/https://raw.githubusercontent.com/bellard/quickjs/v2020-07-05/quickjs.h \
  https://mirror.ghproxy.com/https://raw.githubusercontent.com/bellard/quickjs/v2020-07-05/quickjs.h \
  https://gh-proxy.com/https://raw.githubusercontent.com/bellard/quickjs/v2020-07-05/quickjs.h \
  https://raw.gitmirror.com/bellard/quickjs/v2020-07-05/quickjs.h ; do
  code=$(curl -sL -o /tmp/qjs.h -w '%{http_code}' --max-time 15 "$u" || true)
  sz=$(stat -c%s /tmp/qjs.h 2>/dev/null || echo 0)
  echo "$code $sz $u"
  if [ "$code" = "200" ] && [ "$sz" -gt 5000 ]; then cp /tmp/qjs.h quickjs.h; break; fi
done
ls -l quickjs.h 2>/dev/null || true
