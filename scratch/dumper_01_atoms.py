import struct, sys

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
print(f"byte0={data[0]:#x} atom_count={atom_count}")
atoms = []
atom_offs = []
atom_lens = []
for i in range(atom_count):
    start = off
    slen, off = read_leb128(data, off)
    wide = slen & 1
    slen >>= 1
    atom_lens.append((slen, wide))
    if wide:
        s = data[off:off + slen * 2].decode('utf-16le', errors='ignore')
        off += slen * 2
    else:
        s = data[off:off + slen].decode('latin1', errors='ignore')
        off += slen
    atoms.append(s)
    atom_offs.append(start)

print(f"atom table ends at {off} (0x{off:x})")
print("last 12 atoms:")
for i in range(atom_count - 12, atom_count):
    print(f"  [{i}] off=0x{atom_offs[i]:x} len={atom_lens[i]} {atoms[i][:120]!r}")

print("longest atoms:")
for i in sorted(range(atom_count), key=lambda i: -atom_lens[i][0])[:15]:
    print(f"  [{i}] off=0x{atom_offs[i]:x} len={atom_lens[i][0]} wide={atom_lens[i][1]} {atoms[i][:80]!r}")

print("range 26280..26560 hex+ascii:")
seg = data[26280:26560]
for i in range(0, len(seg), 16):
    chunk = seg[i:i + 16]
    asc = "".join(chr(b) if 32 <= b < 127 else "." for b in chunk)
    print(f"0x{26280+i:05x}: {chunk.hex(' '):<48} {asc}")

for idx in [2129, 2133, 2136, 2137, 1472, 1474, 1603, 2150]:
    print(f"atom[{idx}] off=0x{atom_offs[idx]:x} = {atoms[idx]!r}")
