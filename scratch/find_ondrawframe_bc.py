import sys, os, struct
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from parse_quickjs_atoms import atoms, offset as bc_start

with open("scratch/official_index.js.bin", "rb") as f:
    data = f.read()

target_u32 = struct.pack("<I", 1474) # onDrawFrame
pos = bc_start
while True:
    pos = data.find(target_u32, pos)
    if pos == -1:
        break
    print(f"Found onDrawFrame at offset: 0x{pos:x} ({pos})")
    pos += 1
