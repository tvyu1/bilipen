import glob


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


for fn in sorted(glob.glob('scratch/*.js.bin')):
    data = open(fn, 'rb').read()
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
    print(f"\n=== {fn} len={len(data)} atoms={atom_count} bytecode_start={off} (0x{off:x})")
    nxt = data[off:off + 48]
    print("  next bytes:", nxt.hex(' '))
    # decode as LEB sequence
    vals = []
    p = off
    try:
        while p < off + 40 and len(vals) < 20:
            v, p = read_leb128(data, p)
            vals.append(v)
    except Exception:
        pass
    print("  as LEB:", vals)
    # first atoms near end of table
    print("  last atoms:", [atoms[-1], atoms[-2], atoms[-3]])
