with open("scratch/official_index.js.bin", "rb") as f:
    data = f.read()

from parse_quickjs_atoms import atoms
import struct

# Let's search backwards from 0x6bca0 to find the JSFunctionDef header.
# A function bytecode block usually starts with byte 0x01 (TAG_FUNCTION_BYTECODE) or similar.
# Let's search backwards for string atom names that might be method names.
pos = 0x6bca0
while pos > 0x6b000:
    for i in range(len(atoms)):
        if atoms[i] in ['onInfo', 'start', 'play', 'mounted', 'created', 'init', 'createCanvasContext']:
            target = struct.pack("<I", i)
            if data[pos:pos+4] == target:
                print(f"Found method/atom '{atoms[i]}' at 0x{pos:x}")
    pos -= 1
