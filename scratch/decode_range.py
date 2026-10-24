import struct
from parse_quickjs_atoms import atoms

with open("scratch/official_index.js.bin", "rb") as f:
    data = f.read()

start = 442500
end = 443200
chunk = data[start:end]

for i in range(0, len(chunk)-4):
    val = struct.unpack("<I", chunk[i:i+4])[0]
    if val < len(atoms) and len(atoms[val]) > 1:
        # print if it looks like a variable/method
        name = atoms[val]
        if not name.startswith('#') and not name.endswith('px'):
            print(f"  0x{start+i:x}: {val} = '{name}'")
