with open("scratch/create_qrcode.js.bin", "rb") as f:
    data = f.read()

# Let's search for "createCanvasContext" in data
pos = 0
matches = []
while True:
    pos = data.find(b"createCanvasContext", pos)
    if pos == -1: break
    matches.append(pos)
    pos += 1

print(f"Occurrences of 'createCanvasContext' in create_qrcode.js.bin: {[hex(m) for m in matches]}")

# Let's search for bytecode using that atom
# First parse atoms of create_qrcode.js.bin
def read_leb128(d, off):
    res = 0; shift = 0
    while True:
        b = d[off]; off += 1
        res |= (b & 0x7f) << shift
        if (b & 0x80) == 0: break
        shift += 7
    return res, off

off = 1
atom_cnt, off = read_leb128(data, off)
atoms = []
target_id = None
for i in range(atom_cnt):
    slen, off = read_leb128(data, off)
    wide = slen & 1; slen >>= 1
    if wide:
        s = data[off:off+slen*2].decode('utf-16le', errors='ignore')
        off += slen*2
    else:
        s = data[off:off+slen].decode('latin1', errors='ignore')
        off += slen
    atoms.append(s)
    if s == 'createCanvasContext':
        target_id = i

print(f"Total atoms: {atom_cnt}, 'createCanvasContext' is Atom {target_id}")

import struct
target_u32 = struct.pack("<I", target_id)
p = off
while True:
    p = data.find(target_u32, p)
    if p == -1: break
    print(f"createCanvasContext used at 0x{p:x}")
    # Print nearby bytes
    chunk = data[p-30:p+30]
    print("  hex:", " ".join(f"{b:02x}" for b in chunk))
    p += 1
