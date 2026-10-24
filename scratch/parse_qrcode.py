with open("scratch/create_qrcode.js.bin", "rb") as f:
    data = f.read()

import re
strs = re.findall(b"[%a-zA-Z0-9_:./ -]{3,}", data)
for s in strs:
    if any(k in s.lower() for k in [b"context", b"canvas", b"draw", b"get", b"create"]):
        print(s.decode('latin1'))
