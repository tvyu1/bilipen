import re

with open("scratch/official_index.js.bin", "rb") as f:
    data = f.read()

sub = data[14209:27000]
strs = re.findall(b"[a-zA-Z0-9_:./ -]{3,}", sub)
seen = set()
for s in strs:
    dec = s.decode("latin1")
    if dec not in seen:
        seen.add(dec)
        print(dec)
