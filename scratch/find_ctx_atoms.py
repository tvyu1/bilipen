with open("scratch/official_index.js.bin", "rb") as f:
    data = f.read()

from parse_quickjs_atoms import atoms
import struct

start = 0x06ba80
end = 0x06bb35

# Let's search for all u32 in this range that match atoms
for i in range(start, end-4):
    val = struct.unpack("<I", data[i:i+4])[0]
    if val < len(atoms) and len(atoms[val]) > 2:
        print(f"0x{i:06x}: Atom {val} = '{atoms[val]}'")
