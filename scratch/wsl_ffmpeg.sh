#!/bin/bash
cd /root/a7build || exit 1
echo "== aliyun jammy ffmpeg pool =="
curl -s --max-time 30 https://mirrors.aliyun.com/ubuntu/pool/universe/f/ffmpeg/ -o list.html
grep -o 'href="[^"]*"' list.html | grep -E 'ffmpeg_4\.4|libav(codec|format|util|swscale|swresample)-dev_(4\.4|5)' | head -20
echo "== try source orig tar =="
for u in \
  https://mirrors.aliyun.com/ubuntu/pool/universe/f/ffmpeg/ffmpeg_4.4.2.orig.tar.xz \
  https://mirrors.tuna.tsinghua.edu.cn/ubuntu/pool/universe/f/ffmpeg/ffmpeg_4.4.2.orig.tar.xz ; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 -r 0-1023 "$u" || true)
  echo "$code $u"
done
