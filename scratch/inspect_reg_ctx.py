with open("scratch/libfalcon.so", "rb") as f:
    data = f.read()

import re
chunk = data[0x73368-100:0x73368+200]
print("Nearby strings:")
for s in re.findall(b"[%a-zA-Z0-9_:./ -]{3,}", chunk):
    print(" ", s.decode('latin1'))
