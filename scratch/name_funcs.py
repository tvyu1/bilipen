with open("scratch/libfalcon.so", "rb") as f:
    data = f.read()

from disasm_canvas_ctx import sections, get_sh_name, get_str
import struct

symtab = None
strtab = None
for s in sections:
    sname = get_sh_name(s['name_idx'])
    if sname == '.dynsym': symtab = s
    elif sname == '.dynstr': strtab = s

funcs = [0x1d2d9c, 0x1ddd04, 0x1d12a8, 0x1d82d4, 0x1d438c]

for target_addr in funcs:
    for i in range(symtab['size'] // symtab['entsize']):
        sym = data[symtab['offset'] + i*symtab['entsize'] : symtab['offset'] + (i+1)*symtab['entsize']]
        st_name, st_value, st_size, st_info, st_other, st_shndx = struct.unpack("<IIIBBH", sym)
        if st_value == target_addr:
            print(f"0x{target_addr:x}: {get_str(st_name)}")
            break
