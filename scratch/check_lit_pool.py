with open("scratch/libfalcon.so", "rb") as f:
    data = f.read()

import struct

start = 0x2952a0
end = 0x295350
print("Literal pool for wrap_createCanvasContext:")
for i in range(start, end, 4):
    val = struct.unpack("<I", data[i:i+4])[0]
    print(f"  0x{i:x}: 0x{val:x} ({val})")
