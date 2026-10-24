import struct
from parse_quickjs_atoms import atoms

with open("scratch/official_index.js.bin", "rb") as f:
    data = f.read()

# Let's inspect the entire function surrounding offset 442904
start = 442750
end = 443100
chunk = data[start:end]

print("Decompiled sequence around 442904:")
i = 0
while i < len(chunk):
    op = chunk[i]
    # Check if there is an atom reference (u32)
    if i + 4 <= len(chunk):
        val = struct.unpack("<I", chunk[i:i+4])[0]
        if val < len(atoms) and len(atoms[val]) > 1:
            print(f"  [{start+i:x}] Atom {val}: {atoms[val]}")
    i += 1
