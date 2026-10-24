#!/bin/bash
TC=/root/a7tc/arm-rockchip830-linux-uclibcgnueabihf
GCC=$TC/bin/arm-rockchip830-linux-uclibcgnueabihf-gcc
echo "== gcc =="; $GCC -dumpversion; $GCC -dumpmachine
SYS=$($GCC -print-sysroot)
echo "== sysroot: $SYS =="
echo "== include top =="; ls "$SYS/usr/include" 2>/dev/null | head -25
echo "== quickjs.h =="; find "$SYS" -name 'quickjs.h' 2>/dev/null | head -3
echo "== rga headers =="; find "$SYS" -iname '*rga*.h' -o -iname 'im2d*.h' 2>/dev/null | head -5
echo "== av headers =="; find "$SYS" -path '*libav*' -name '*.h' 2>/dev/null | head -5
echo "== sysroot libs =="; ls "$SYS/usr/lib" 2>/dev/null | head -25
echo "== compile test =="
cd /tmp && printf 'int f(void){return 42;}\n' > t.c && $GCC -shared -fPIC -o libt.so t.c && file libt.so
