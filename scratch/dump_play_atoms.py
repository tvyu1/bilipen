with open("scratch/official_index.js.bin", "rb") as f:
    data = f.read()

from exact_atoms import atoms
import struct

start = 0x6a800
end = 0x6bd00
print("Sequential atom references between 0x6a800 and 0x6bd00:")
last_atom = None
for i in range(start, end-4):
    v = struct.unpack("<I", data[i:i+4])[0]
    if v < len(atoms) and len(atoms[v]) > 1:
        name = atoms[v]
        if name != last_atom:
            last_atom = name
            print(f"  [0x{i:06x}] Atom {v}: {name}")
