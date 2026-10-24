with open("scratch/official_index.js.bin", "rb") as f:
    data = f.read()

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

for idx in [2125, 2126, 2127, 2128, 2129, 2130, 2131, 2132, 2133, 2134, 2135, 2136, 2137]:
    print(f"Atom {idx}: {repr(atoms[idx])}")
