with open("scratch/libfalcon.so", "rb") as f:
    data = f.read()

import struct

# Find string "createCanvasContext"
pos = data.find(b"createCanvasContext\0")
print("pos of string createCanvasContext:", pos)

# Find references to wrap_createCanvasContext (0x294ba8)
target = struct.pack("<I", 0x294ba8)
p = 0
while True:
    p = data.find(target, p)
    if p == -1: break
    print(f"Reference to wrap_createCanvasContext at 0x{p:x}")
    p += 1
