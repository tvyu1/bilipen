with open("scratch/create_qrcode.js.bin", "rb") as f:
    data = f.read()

from disasm_qrcode_ctx import atoms
import struct

start = 0x5e10
end = 0x5e45
for i in range(start, end):
    b = data[i]
    extra = ""
    if i + 4 <= len(data):
        aid = struct.unpack("<I", data[i+1:i+5])[0]
        if aid < len(atoms) and len(atoms[aid]) > 1:
            extra = f"Atom {aid} ({atoms[aid]})"
    print(f"0x{i:04x}: {b:02x} {extra}")
