with open("scratch/libfalcon.so", "rb") as f:
    data = f.read()

import struct
target = struct.pack("<I", 0x294ba8)
pos = 0
found = []
while True:
    pos = data.find(target, pos)
    if pos == -1: break
    found.append(pos)
    pos += 1

print(f"References to 0x294ba8 in libfalcon.so: {[hex(p) for p in found]}")
