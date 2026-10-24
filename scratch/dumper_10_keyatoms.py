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
atom_off = []
for i in range(atom_count):
    atom_off.append(off)
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

KEYS = ['width', 'height', '640', '360', '172', '545', '2560', 'canvas', 'Canvas',
        'style', 'attrs', 'transform', 'scale', 'ImageData', 'imageData', 'ctx',
        '44100', 'setTimeout', 'delay', 'play', 'stop', 'onInfo', 'onDrawFrame',
        'SoftVPlayer', 'video', 'Video', 'base64', 'url', 'URL', 'src',
        'createCanvasContext', 'getImageData', 'putImageData', 'setImageDataBuffer',
        'canvasRender', 'ref', 'class', 'px', '%', 'vw', 'vh', 'frame',
        'buffer', 'Buffer', 'ArrayBuffer', 'Uint8Array', 'drawImage', 'fillRect']

for kw in KEYS:
    hits = [(i, a) for i, a in enumerate(atoms) if kw in a]
    if hits:
        print(f"--- '{kw}': {len(hits)} atoms")
        for i, a in hits[:12]:
            print(f"   [{i}] @0x{atom_off[i]:x} {a[:150]!r}")
