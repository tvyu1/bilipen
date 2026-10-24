import struct
import sys


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


PATH = "scratch/official_index.js.bin"
data = open(PATH, "rb").read()
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


def trace(a, b, label):
    print(f"\n===== {label}: 0x{a:x}..0x{b:x}")
    i = a
    last = None
    while i < b:
        v = struct.unpack('<I', data[i:i + 4])[0] if i + 4 <= len(data) else 0xffffffff
        if 0 < v < atom_count and len(atoms[v]) >= 2 and atoms[v] != last:
            prev = data[i - 1] if i > 0 else None
            name = atoms[v]
            print(f"  0x{i-1:06x}: op={prev:02x} atom[{v}]={name!r}")
            last = name
            i += 1
        else:
            i += 1


if __name__ == '__main__':
    a = int(sys.argv[1], 0)
    b = int(sys.argv[2], 0)
    label = sys.argv[3] if len(sys.argv) > 3 else ''
    trace(a, b, label)
