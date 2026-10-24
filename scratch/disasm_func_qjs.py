with open("scratch/official_index.js.bin", "rb") as f:
    data = f.read()

from parse_quickjs_atoms import atoms
import struct

# In QuickJS bytecode, find the start of the function containing 0x6bb45
# Functions usually start with byte 0x01 or function header.
# Let's search backwards from 0x6bb45 for function boundary, or let's search for function name in atoms.
# Let's inspect bytes from 0x6ba00 to 0x6bc00
# And print every opcode and atom reference
# In QuickJS:
# 0x04 = OP_push_atom_value u32
# 0x41 = OP_call_method u32 (argc is pushed or in next bytes)
# 0x42 = OP_get_field u32
# 0x4c = OP_put_field u32

start = 0x6bb00
end = 0x6bb70

i = start
while i < end:
    b = data[i]
    extra = ""
    # Check if this opcode has a 32-bit atom operand
    if b in [0x04, 0x41, 0x42, 0x4c, 0x43]:
        atom_id = struct.unpack("<I", data[i+1:i+5])[0]
        if atom_id < len(atoms):
            extra = f"Atom {atom_id} ('{atoms[atom_id]}')"
    print(f"0x{i:06x}: {b:02x} {extra}")
    if extra:
        i += 5
    else:
        i += 1
