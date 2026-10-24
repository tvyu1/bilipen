with open("scratch/official_index.js.bin", "rb") as f:
    data = f.read()

from parse_quickjs_atoms import atoms
import struct

# Opcode table for QuickJS
# Let's inspect bytes from 0x6bb20 to 0x6bb60
chunk = data[0x6bb10:0x6bb60]

for i in range(len(chunk)):
    b = chunk[i]
    pos = 0x6bb10 + i
    # Let's check if 4 bytes match an atom
    matched = ""
    if i + 4 <= len(chunk):
        val = struct.unpack("<I", chunk[i:i+4])[0]
        if val < len(atoms) and len(atoms[val]) > 1:
            matched = f"-> Atom {val}: {atoms[val]}"
    print(f"0x{pos:06x}: {b:02x} ({b:3d}) {matched}")
