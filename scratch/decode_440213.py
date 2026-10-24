import struct
from parse_quickjs_atoms import atoms

with open("scratch/official_index.js.bin", "rb") as f:
    data = f.read()

m = 440213
chunk = data[m-60:m+120]
for i in range(0, len(chunk)-4):
    val = struct.unpack("<I", chunk[i:i+4])[0]
    if val < len(atoms) and len(atoms[val]) > 1:
        name = atoms[val]
        if not name.startswith('#') and not name.endswith('px'):
            print(f"  0x{m-60+i:x}: {val} = '{name}'")
