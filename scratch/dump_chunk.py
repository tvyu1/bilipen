with open("scratch/official_index.js.bin", "rb") as f:
    data = f.read()

pos = data.find(b"setImageDataBuffer")
chunk = data[pos-300:pos+300]
print("Hex dump around setImageDataBuffer:")
for i in range(0, len(chunk), 16):
    hex_str = " ".join(f"{b:02x}" for b in chunk[i:i+16])
    asc_str = "".join(chr(b) if 32 <= b < 127 else "." for b in chunk[i:i+16])
    print(f"{i:04x}: {hex_str:<48}  {asc_str}")
