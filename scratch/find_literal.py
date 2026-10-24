with open("scratch/libfalcon.so", "rb") as f:
    data = f.read()

import capstone, struct

# In ARM, literal pool often loads an offset or address.
# Let's search for the value 0x76d4d0 (or offset from PC) in the literal pools of .text
target_addr = 0x76d4d0
print(f"Searching for literal pool references to 0x{target_addr:x}")

# Let's search all 4-byte integers in data
for i in range(0, 0x400000, 4):
    val = struct.unpack("<I", data[i:i+4])[0]
    if val == target_addr:
        print(f"Found literal pool at 0x{i:x}: {hex(val)}")
        # Let's see what instruction loads from this literal pool
        for j in range(max(0, i-200), i, 4):
            insn = struct.unpack("<I", data[j:j+4])[0]
            # Check ldr rx, [pc, #imm]
            # In ARM: 0xe59fxxxx or 0xe51fxxxx
            if (insn & 0xff7f0000) == 0xe51f0000:
                imm = insn & 0xfff
                is_add = (insn & (1 << 23)) != 0
                target = (j + 8) + imm if is_add else (j + 8) - imm
                if target == i:
                    print(f"  Loaded by ldr at 0x{j:x}")
