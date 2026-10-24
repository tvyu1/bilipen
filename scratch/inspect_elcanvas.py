with open("scratch/create_qrcode.js.bin", "rb") as f:
    data = f.read()

idx = data.find(b"_elCanvas")
print("Found _elCanvas at:", idx)

import re
chunk = data[idx-200:idx+400]
print("Nearby strings:")
for s in re.findall(b"[%a-zA-Z0-9_:./ -]{2,}", chunk):
    print(" ", s.decode('latin1'))
