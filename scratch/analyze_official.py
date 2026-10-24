import re

with open("scratch/official_index.js.bin", "rb") as f:
    data = f.read()

pos = data.find(b"setImageDataBuffer")
print("pos of setImageDataBuffer:", pos)
nearby = data[max(0, pos-1500):min(len(data), pos+1500)]
print("Nearby strings:")
for s in re.findall(b"[a-zA-Z0-9_:\./ -]{3,}", nearby):
    print(" ", s.decode("latin1"))
