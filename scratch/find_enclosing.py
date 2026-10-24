import struct
from disasm_canvas_ctx import sections, get_sh_name, get_str

with open("scratch/libfalcon.so", "rb") as f:
    data = f.read()

symtab = None
strtab = None
for s in sections:
    sname = get_sh_name(s['name_idx'])
    if sname == '.dynsym': symtab = s
    elif sname == '.dynstr': strtab = s

target_addr = 0x73368
best = None
for i in range(symtab['size'] // symtab['entsize']):
    sym = data[symtab['offset'] + i*symtab['entsize'] : symtab['offset'] + (i+1)*symtab['entsize']]
    st_name, st_value, st_size, st_info, st_other, st_shndx = struct.unpack("<IIIBBH", sym)
    if st_value <= target_addr < st_value + st_size:
        best = (get_str(st_name), st_value, st_size)

print("Enclosing symbol for 0x73368:", best)
