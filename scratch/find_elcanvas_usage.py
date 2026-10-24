with open("scratch/create_qrcode.js.bin", "rb") as f:
    data = f.read()

from disasm_qrcode_ctx import atoms
import struct

# Find where Atom 331 ('_elCanvas') is used
target = struct.pack("<I", 331) # '_elCanvas'
p = 0
while True:
    p = data.find(target, p)
    if p == -1: break
    print(f"_elCanvas used at 0x{p:x}")
    chunk = data[p-40:p+60]
    for i in range(0, len(chunk)-4):
        v = struct.unpack("<I", chunk[i:i+4])[0]
        if v < len(atoms) and len(atoms[v]) > 1:
            print(f"  [0x{p-40+i:x}] Atom {v}: {atoms[v]}")
    p += 1
