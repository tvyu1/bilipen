with open("scratch/official_index.js.bin", "rb") as f:
    data = f.read()

pos = data.find(b"onDrawFrame")
print("pos:", pos)
print("nearby hex:")
chunk = data[pos-100:pos+200]
print(" ".join(f"{b:02x}" for b in chunk))
