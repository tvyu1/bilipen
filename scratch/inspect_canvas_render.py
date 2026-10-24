import struct
from parse_quickjs_atoms import atoms

with open("scratch/official_index.js.bin", "rb") as f:
    data = f.read()

m = 358386
chunk = data[m-200:m+200]
print("All atoms around 358386:")
for i in range(0, len(chunk)-4):
    val = struct.unpack("<I", chunk[i:i+4])[0]
    if val < len(atoms) and len(atoms[val]) > 1:
        print(f"  [{m-200+i:x}] {val}: '{atoms[val]}'")
