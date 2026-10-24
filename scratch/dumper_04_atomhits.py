import struct


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
bc = off
print(f"bytecode region: 0x{bc:x}..0x{len(data):x} ({len(data)-bc} bytes)")

targets = {1472: 'SoftVPlayer', 1474: 'onDrawFrame', 1603: 'canvas', 2129: 'putImageData',
           2133: 'createCanvasContext', 2136: 'getImageData', 2137: 'setImageDataBuffer',
           2150: 'canvasRender'}
for aid, name in targets.items():
    pat = struct.pack('<I', aid)
    pos = bc
    hits = []
    while True:
        pos = data.find(pat, pos)
        if pos == -1:
            break
        hits.append(pos)
        pos += 1
    print(f"\natom {aid} ({name}): {len(hits)} u32 hits")
    for h in hits:
        print(f"  @0x{h:x} (rel 0x{h-bc:x})")
