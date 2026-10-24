import struct
from parse_quickjs_atoms import atoms

with open("scratch/official_index.js.bin", "rb") as f:
    data = f.read()

# Let's inspect bytes before offset 352130 (0x55f82)
chunk = data[352130-100:352130+100]
print("Dump around 352130:")
for i in range(0, len(chunk), 16):
    print(" ".join(f"{b:02x}" for b in chunk[i:i+16]))
