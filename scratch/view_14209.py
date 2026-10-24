import re

with open("scratch/official_index.js.bin", "rb") as f:
    data = f.read()

nearby = data[14209-200:14209+400]
for s in re.findall(b"[a-zA-Z0-9_:./ -]{3,}", nearby):
    print(" ", s.decode("latin1"))
