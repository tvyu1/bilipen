with open("scratch/official_index.js.bin", "rb") as f:
    data = f.read()

import struct

target = struct.pack("<I", 2134)
p = 0
while True:
    p = data.find(target, p)
    if p == -1: break
    print(f"getContext (Atom 2134) at 0x{p:x}")
    p += 1
