with open("scratch/official_index.js.bin", "rb") as f:
    data = f.read()

from parse_quickjs_atoms import atoms
import struct

pos = 0x6bb45
chunk = data[pos-100:pos+150]

print("Bytecode around createCanvasContext (0x6bb45):")
for i in range(0, len(chunk), 16):
    hex_str = " ".join(f"{b:02x}" for b in chunk[i:i+16])
    print(f"{pos-100+i:06x}: {hex_str}")

print("\nAtoms in this range:")
for i in range(0, len(chunk)-4):
    v = struct.unpack("<I", chunk[i:i+4])[0]
    if v < len(atoms) and len(atoms[v]) > 1:
        print(f"  [{pos-100+i:x}] {v}: {atoms[v]}")
