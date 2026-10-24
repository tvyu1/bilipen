with open("scratch/create_qrcode.js.bin", "rb") as f:
    data = f.read()

from disasm_qrcode_ctx import atoms
import struct

# Let's inspect bytes from 0x87d0 to 0x8830
chunk = data[0x87c0:0x8830]
for i in range(0, len(chunk)):
    b = chunk[i]
    off = 0x87c0 + i
    extra = ""
    # Check if 4 bytes match an atom
    if i + 4 <= len(chunk):
        aid = struct.unpack("<I", chunk[i:i+4])[0]
        if aid < len(atoms) and len(atoms[aid]) > 1:
            extra = f"-> Atom {aid} ({atoms[aid]})"
    print(f"0x{off:04x}: {b:02x} {extra}")
