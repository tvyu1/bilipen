with open("scratch/official_index.js.bin", "rb") as f:
    data = f.read()

from parse_quickjs_atoms import atoms
import struct

start = 0x6bca0
end = 0x6bcd5
for i in range(start, end):
    b = data[i]
    extra = ""
    if b in [0x04, 0x41, 0x42, 0x4c, 0x43]:
        aid = struct.unpack("<I", data[i+1:i+5])[0]
        if aid < len(atoms):
            extra = f"Atom {aid} ({atoms[aid]})"
    print(f"0x{i:06x}: {b:02x} {extra}")
