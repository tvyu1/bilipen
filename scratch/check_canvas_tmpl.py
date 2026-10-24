with open("scratch/create_qrcode.js.bin", "rb") as f:
    data = f.read()

from disasm_qrcode_ctx import atoms
import struct

# In create_qrcode.js.bin, find where Atom 360 ('canvas') is used
target = struct.pack("<I", 360) # 'canvas'
p = 0
while True:
    p = data.find(target, p)
    if p == -1: break
    print(f"canvas used at 0x{p:x}")
    # Inspect nearby atoms
    chunk = data[p-20:p+100]
    for i in range(0, len(chunk)-4):
        v = struct.unpack("<I", chunk[i:i+4])[0]
        if v < len(atoms) and len(atoms[v]) > 1:
            print(f"  [0x{p-20+i:x}] Atom {v}: {atoms[v]}")
    p += 1
