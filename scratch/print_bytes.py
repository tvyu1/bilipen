with open("scratch/official_index.js.bin", "rb") as f:
    data = f.read()

from exact_atoms import atoms
import struct

start = 0x06bc40
end = 0x06bc70
print("Bytes from 0x06bc40 to 0x06bc70:")
for i in range(start, end):
    print(f"0x{i:06x}: {data[i]:02x}")
