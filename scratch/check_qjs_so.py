with open("scratch/libquickjs.so", "rb") as f:
    data = f.read()

import re
matches = [s.decode('latin1') for s in re.findall(b"[a-z0-9_]{3,}\0", data) if any(k in s for k in [b"push", b"call", b"get_field", b"put_field"])]
print("Opcode-like names:", matches[:30])

# Let's search for "call_method"
pos = data.find(b"call_method\0")
print("pos of call_method:", pos)
if pos != -1:
    chunk = data[pos-100:pos+200]
    for s in chunk.split(b'\0'):
        if s: print(" ", s.decode('latin1'))
