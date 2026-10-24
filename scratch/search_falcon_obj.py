with open("scratch/libfalcon.so", "rb") as f:
    data = f.read()

import re
pos = 0
while True:
    pos = data.find(b"$falcon", pos)
    if pos == -1: break
    print(f"$falcon found at 0x{pos:x}")
    chunk = data[max(0, pos-100):min(len(data), pos+150)]
    for s in re.findall(b"[%a-zA-Z0-9_:./ -]{3,}", chunk):
        print("  ", s.decode('latin1'))
    pos += len(b"$falcon")
