with open("scratch/libfalcon.so", "rb") as f:
    data = f.read()

import re

# Search for the string "createCanvasContext" in libfalcon.so
idx = data.find(b"createCanvasContext")
print("createCanvasContext at:", hex(idx))
# Let's see what is around this string in rodata
ro = data[idx-50:idx+150]
for s in re.findall(b"[%a-zA-Z0-9_:./ -]{3,}", ro):
    print(" ", s.decode('latin1'))
