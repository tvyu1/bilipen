with open("scratch/create_qrcode.js.bin", "rb") as f:
    data = f.read()

from disasm_qrcode_ctx import atoms
import struct

# Find atoms related to canvas or ref or id
for i, a in enumerate(atoms):
    if any(k in a.lower() for k in ['canvas', 'ref', 'id']):
        print(f"Atom {i}: {a}")
