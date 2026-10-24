import sys

path = sys.argv[1]
start = int(sys.argv[2], 0)
length = int(sys.argv[3], 0)
d = open(path, 'rb').read()
for i in range(start, min(start + length, len(d)), 16):
    c = d[i:i + 16]
    asc = ''.join(chr(x) if 32 <= x < 127 else '.' for x in c)
    print(f'0x{i:06x}: {c.hex(" "):<48} {asc}')
