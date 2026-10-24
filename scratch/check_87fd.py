with open("scratch/create_qrcode.js.bin", "rb") as f:
    data = f.read()

from disasm_qrcode_ctx import atoms
import struct

start = 0x87d0
end = 0x8840
print("Bytecode around 0x87fd in create_qrcode.js.bin:")
for i in range(start, end):
    b = data[i]
    extra = ""
    if i + 4 <= len(data):
        v = struct.unpack("<I", data[i+1:i+5])[0]
        if v < len(atoms) and len(atoms[v]) > 1:
            extra = f"Atom {v} = '{atoms[v]}'"
    print(f"0x{i:04x}: {b:02x} {extra}")
