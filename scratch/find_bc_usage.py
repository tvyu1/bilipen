import sys, os, struct
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from parse_quickjs_atoms import atoms, offset as bc_start

with open("scratch/official_index.js.bin", "rb") as f:
    data = f.read()

target_u32 = struct.pack("<I", 2137)
pos = bc_start
matches = []
while True:
    pos = data.find(target_u32, pos)
    if pos == -1:
        break
    matches.append(pos)
    pos += 1

print(f"Found {len(matches)} occurrences of atom 2137 (setImageDataBuffer) in bytecode:")
for m in matches:
    print(f"  Offset: {m}")
    chunk = data[m-60:m+100]
    print("   Hex:", " ".join(f"{b:02x}" for b in chunk))
