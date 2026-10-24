with open("scratch/libfalcon.so", "rb") as f:
    data = f.read()

import re

# Find all occurrences of b"createCanvasContext"
p = 0
while True:
    p = data.find(b"createCanvasContext", p)
    if p == -1: break
    print(f"createCanvasContext at offset 0x{p:x}")
    # Show nearby strings
    nearby = data[max(0, p-60):min(len(data), p+120)]
    print("  nearby:", re.findall(b"[%a-zA-Z0-9_:./ -]{3,}", nearby))
    p += len(b"createCanvasContext")
