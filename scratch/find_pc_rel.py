with open("scratch/libfalcon.so", "rb") as f:
    data = f.read()

import struct

target = 0x76d4d0

# Search for ARM instructions that load target or target relative to PC
# In ARM:
# 1) ldr rX, [pc, #imm] -> loads a constant C from literal pool
# 2) add rX, pc, rX -> rX = (pc + 8) + C
# So (pc + 8) + C = target => C = target - (pc + 8)
print("Scanning for PC-relative references to 0x76d4d0...")
for i in range(0, 0x300000, 4):
    val = struct.unpack("<I", data[i:i+4])[0]
    expected_pc = target - val - 8
    # If expected_pc is near i
    if abs(expected_pc - i) < 1000:
        print(f"Candidate literal at 0x{i:x}: val=0x{val:x}, pc=0x{expected_pc:x}")
