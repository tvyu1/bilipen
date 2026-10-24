with open("scratch/libfalcon.so", "rb") as f:
    data = f.read()

import re
matches = re.findall(b"invalid\0push_i32[^\0]*", data)
print("matches:", matches)
if not matches:
    pos = data.find(b"invalid\0")
    print("pos of invalid:", pos)
    chunk = data[pos:pos+1000]
    strs = [s.decode('latin1') for s in chunk.split(b'\0') if s]
    print("First 30 opcode names:", strs[:30])
