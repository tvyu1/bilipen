with open("scratch/official_index.js.bin", "rb") as f:
    data = f.read()

from parse_quickjs_atoms import atoms
import struct

for addr in [0x56744, 0x6bcca]:
    print(f"\n--- Around 0x{addr:x} ---")
    chunk = data[addr-60:addr+60]
    for i in range(0, len(chunk)-4):
        val = struct.unpack("<I", chunk[i:i+4])[0]
        if val < len(atoms) and len(atoms[val]) > 1:
            print(f"  [0x{addr-60+i:x}] Atom {val}: {atoms[val]}")
