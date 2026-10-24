import struct

def read_leb128(data, offset):
    res = 0
    shift = 0
    while True:
        b = data[offset]
        offset += 1
        res |= (b & 0x7f) << shift
        if (b & 0x80) == 0:
            break
        shift += 7
    return res, offset

with open("scratch/official_index.js.bin", "rb") as f:
    data = f.read()

offset = 1 # skip tag
atom_count, offset = read_leb128(data, offset)
print(f"Total atoms: {atom_count}")

atoms = []
target_atoms = {}
for i in range(atom_count):
    str_len, offset = read_leb128(data, offset)
    is_wide = str_len & 1
    str_len >>= 1
    if is_wide:
        s = data[offset:offset + str_len*2].decode('utf-16le', errors='ignore')
        offset += str_len * 2
    else:
        s = data[offset:offset + str_len].decode('latin1', errors='ignore')
        offset += str_len
    atoms.append(s)
    if any(k in s for k in ['Canvas', 'canvas', 'SoftVPlayer', 'setImageData', 'putImageData', 'getImageData', 'onDrawFrame']):
        target_atoms[i] = s

print(f"Parsed atoms, found {len(target_atoms)} targets:")
for idx, name in target_atoms.items():
    print(f"  Atom {idx}: {name}")

# Now offset is where bytecode functions begin!
print(f"Bytecode data begins at offset {offset}, total length {len(data)}")
