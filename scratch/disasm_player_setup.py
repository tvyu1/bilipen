with open("scratch/official_index.js.bin", "rb") as f:
    data = f.read()

from exact_atoms import atoms
import struct

start = 0x06b9e0
end = 0x06bc70

# Let's inspect all opcodes and atoms
i = start
while i < end:
    b = data[i]
    extra = ""
    # Check if 4 bytes match an atom
    if i + 5 <= end:
        aid = struct.unpack("<I", data[i+1:i+5])[0]
        if aid < len(atoms) and len(atoms[aid]) > 1:
            extra = f"Atom {aid} ('{atoms[aid]}')"
    print(f"0x{i:06x}: {b:02x} {extra}")
    if extra:
        i += 5
    else:
        i += 1
