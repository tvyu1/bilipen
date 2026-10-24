import sys

PATH = "scratch/official_index.js.bin"
data = open(PATH, "rb").read()


def dump(a, b, label=''):
    print(f'--- {label} 0x{a:x}..0x{b:x}')
    for i in range(a, b, 16):
        c = data[i:i + 16]
        asc = ''.join(chr(x) if 32 <= x < 127 else '.' for x in c)
        print(f'0x{i:06x}: {c.hex(" "):<48} {asc}')


if __name__ == '__main__':
    a = int(sys.argv[1], 0)
    b = int(sys.argv[2], 0)
    label = sys.argv[3] if len(sys.argv) > 3 else ''
    dump(a, b, label)
