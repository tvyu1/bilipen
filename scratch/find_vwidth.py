import struct
from parse_quickjs_atoms import atoms

with open("scratch/official_index.js.bin", "rb") as f:
    data = f.read()

target = struct.pack('<I', 2124) # vWidth
pos = 0
while True:
    pos = data.find(target, pos)
    if pos == -1: break
    print(f"vWidth at 0x{pos:x} ({pos})")
    chunk = data[pos-30:pos+50]
    for i in range(0, len(chunk)-4):
        v = struct.unpack("<I", chunk[i:i+4])[0]
        if v < len(atoms) and len(atoms[v]) > 2:
            print(f"   nearby atom: {atoms[v]}")
    pos += 1
