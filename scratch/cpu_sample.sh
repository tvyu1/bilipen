#!/bin/sh
# 采样 miniapp 进程 CPU 时间与系统负载，用于分析播放期间的 CPU 占用。
rm -f /tmp/cpu_sample.txt
i=0
while [ $i -lt 300 ]; do
  P=$(ps | grep '/usr/bin/miniapp' | grep -v grep | awk '{print $1}' | head -1)
  U=$(awk '{print $14+$15}' /proc/$P/stat 2>/dev/null)
  echo "$(date +%s) $U $(cat /proc/loadavg)" >> /tmp/cpu_sample.txt
  i=$((i+1))
  sleep 1
done
echo done >> /tmp/cpu_sample.txt
