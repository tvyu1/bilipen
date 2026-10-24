with open("scratch/official_index.js.bin", "rb") as f:
    data = f.read()

import re
pos = data.find(b"canvasRender")
chunk = data[pos-100:pos+200]
print("Around canvasRender in atom/string table:")
for s in re.findall(b"[%a-zA-Z0-9_:./ -]{2,}", chunk):
    print(" ", s.decode('latin1'))
