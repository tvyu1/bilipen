with open("libjsapi_softvideo.so", "rb") as f:
    data = f.read()

import capstone, struct

# Find openAudioDevice in dynsym
from disasm_symbols import target_symbols, sections, get_sh_name, get_str

symtab = None
strtab = None
for s in sections:
    sname = get_sh_name(s['name_idx'])
    if sname == '.dynsym': symtab = s
    elif sname == '.dynstr': strtab = s

for i in range(symtab['size'] // symtab['entsize']):
    sym = data[symtab['offset'] + i*symtab['entsize'] : symtab['offset'] + (i+1)*symtab['entsize']]
    st_name, st_value, st_size, st_info, st_other, st_shndx = struct.unpack("<IIIBBH", sym)
    name = get_str(st_name)
    if 'openAudioDevice' in name:
        print(f"{name}: 0x{st_value:x}, size={st_size}")
        md = capstone.Cs(capstone.CS_ARCH_ARM, capstone.CS_MODE_ARM)
        code = data[st_value:st_value+min(st_size, 160)]
        for insn in md.disasm(code, st_value):
            print(f"  0x{insn.address:x}: {insn.mnemonic} {insn.op_str}")
