import re

with open("scratch/official_index.js.bin", "rb") as f:
    data = f.read()

# In QuickJS bytecode, find references to the string 'canvasRender' or 'setImageDataBuffer'
# The atom table stores strings prefixed by length. Let's see the atom index.
# In QuickJS, strings in bytecode are atoms.
# Let's search for functions in index.js.bin that contain bytecode using these atoms.
# Or let's decompile with qjs if possible, or just parse QuickJS function headers.
# Let's search for "SoftVPlayer" in data
p = 0
while True:
    p = data.find(b"SoftVPlayer", p)
    if p == -1:
        break
    print("SoftVPlayer found at offset:", p)
    p += 1
