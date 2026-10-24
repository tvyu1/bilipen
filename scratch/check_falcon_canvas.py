import re

with open("libfalcon.so", "rb") as f:
    data = f.read()

pos = 0
matches = []
for m in re.finditer(b"JSCanvas[A-Za-z0-9_]*", data):
    matches.append(m.group().decode('latin1'))

print("JSCanvas occurrences:")
for s in sorted(set(matches)):
    print(" ", s)
