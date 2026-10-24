with open("scratch/libfalcon.so", "rb") as f:
    data = f.read()

import struct

pc = 0x294c68 + 8
offset = struct.unpack("<I", data[0x294c68 + 0x68c + 8 : 0x294c68 + 0x68c + 12])[0]
# In ARM, offset in literal pool
lit_addr = 0x294c68 + 8 + 0x68c
lit_val = struct.unpack("<I", data[lit_addr:lit_addr+4])[0]
target = pc + lit_val
print(f"lit_addr: 0x{lit_addr:x}, lit_val: 0x{lit_val:x}, target: 0x{target:x}")
print("String at target:", repr(data[target:target+40]))
