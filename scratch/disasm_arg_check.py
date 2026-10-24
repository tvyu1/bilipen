import capstone

with open("scratch/libfalcon.so", "rb") as f:
    data = f.read()

val = 0x294c30
md = capstone.Cs(capstone.CS_ARCH_ARM, capstone.CS_MODE_ARM)
code = data[val:val+80]
print("Disassembly of wrap_createCanvasContext argument check:")
for insn in md.disasm(code, val):
    print(f"0x{insn.address:x}: {insn.mnemonic:8s} {insn.op_str}")
