with open("scratch/official_index.js.bin", "rb") as f:
    data = f.read()

from exact_atoms import atoms
import struct

start = 0x6bb30
end = 0x6bc70

for i in range(start, end):
    b = data[i]
    extra = ""
    if i + 4 <= len(data):
        aid = struct.unpack("<I", data[i+1:i+5])[0]
        if aid < len(atoms) and len(atoms[aid]) > 1:
            extra = f"Atom {aid} ('{atoms[aid]}')"
    if extra:
        print(f"0x{i:06x}: {b:02x} {extra}")
