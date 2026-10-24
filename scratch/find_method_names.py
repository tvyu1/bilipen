with open("scratch/official_index.js.bin", "rb") as f:
    data = f.read()

from exact_atoms import atoms
import struct

# In QuickJS bytecode, functions are serialized as:
# byte 0x01 (BC_TAG_FUNCTION_BYTECODE)
# byte js_mode
# string/atom func_name
# vardefs...
# Let's search backwards from 0x6bb45 for 0x01 followed by something that looks like a function header
pos = 0x6bb45
candidates = []
while pos > 0x69000:
    # Check if pos is a function header
    # Let's look for known method names in atoms nearby
    pos -= 1
    val = struct.unpack("<I", data[pos:pos+4])[0]
    if val < len(atoms):
        name = atoms[val]
        if name in ['created', 'mounted', 'start', 'play', 'initPlayer', 'onInfo', 'onState', 'startPlay', 'loadVideo', 'onDrawFrame']:
            print(f"Found candidate method name '{name}' at 0x{pos:x}")
