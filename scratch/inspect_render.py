import struct
from parse_quickjs_atoms import atoms

with open("scratch/official_index.js.bin", "rb") as f:
    data = f.read()

m = 358386
chunk = data[m-60:m+80]
for i in range(0, len(chunk)-4):
    val = struct.unpack("<I", chunk[i:i+4])[0]
    if val < len(atoms) and len(atoms[val]) > 1:
        name = atoms[val]
        print(f"  [{m-60+i:x}] Atom {val}: {name}")
