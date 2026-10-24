import sys

PATH = "scratch/official_index.js.bin"
data = open(PATH, "rb").read()


def read_leb128(d, off):
    res = 0
    shift = 0
    while True:
        b = d[off]
        off += 1
        res |= (b & 0x7f) << shift
        if (b & 0x80) == 0:
            break
        shift += 7
    return res, off


off = 1
atom_count, off = read_leb128(data, off)
atoms = []
for i in range(atom_count):
    slen, off = read_leb128(data, off)
    wide = slen & 1
    slen >>= 1
    if wide:
        s = data[off:off + slen * 2].decode('utf-16le', errors='ignore')
        off += slen * 2
    else:
        s = data[off:off + slen].decode('latin1', errors='ignore')
        off += slen
    atoms.append(s)

print("atoms 410..470:")
for i in range(410, 470):
    print(f"  [{i}] {atoms[i]!r}")
print("atom 44:", repr(atoms[44]), " 174:", repr(atoms[174]), " 218:", repr(atoms[218]))
