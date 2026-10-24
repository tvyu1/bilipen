with open("scratch/libfalcon.so", "rb") as f:
    data = f.read()

import re
chunk = data[0x76d480:0x76d550]
for s in re.findall(b"[%a-zA-Z0-9_:./ -]{2,}", chunk):
    print(" ", s.decode('latin1'))
