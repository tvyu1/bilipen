import struct
from parse_quickjs_atoms import atoms

with open("scratch/official_index.js.bin", "rb") as f:
    data = f.read()

m = 442904
chunk = data[m-100:m+200]

print("Deconding u32 atom references in chunk around 442904:")
for i in range(0, len(chunk)-4):
    val = struct.unpack("<I", chunk[i:i+4])[0]
    if val < len(atoms):
        if len(atoms[val]) > 2:
            print(f"  +{i:03d} (0x{m-100+i:x}): Atom {val} = '{atoms[val]}'")
