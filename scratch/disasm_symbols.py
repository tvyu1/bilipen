import capstone
import struct

with open("libjsapi_softvideo.so", "rb") as f:
    data = f.read()

# Parse ELF symbol table
# e_shoff at 32
e_shoff = struct.unpack("<I", data[32:36])[0]
e_shentsize = struct.unpack("<H", data[46:48])[0]
e_shnum = struct.unpack("<H", data[48:50])[0]
e_shstrndx = struct.unpack("<H", data[50:52])[0]

# Read section headers
sections = []
for i in range(e_shnum):
    s_hdr = data[e_shoff + i*e_shentsize : e_shoff + (i+1)*e_shentsize]
    sh_name, sh_type, sh_flags, sh_addr, sh_offset, sh_size, sh_link, sh_info, sh_addralign, sh_entsize = struct.unpack("<10I", s_hdr)
    sections.append({
        'name_idx': sh_name, 'type': sh_type, 'addr': sh_addr,
        'offset': sh_offset, 'size': sh_size, 'link': sh_link, 'entsize': sh_entsize
    })

shstr = data[sections[e_shstrndx]['offset'] : sections[e_shstrndx]['offset'] + sections[e_shstrndx]['size']]
def get_sh_name(idx):
    end = shstr.find(b'\0', idx)
    return shstr[idx:end].decode('latin1')

symtab = None
strtab = None
for s in sections:
    sname = get_sh_name(s['name_idx'])
    if sname == '.dynsym':
        symtab = s
    elif sname == '.dynstr':
        strtab = s

strdata = data[strtab['offset'] : strtab['offset'] + strtab['size']]
def get_str(idx):
    end = strdata.find(b'\0', idx)
    return strdata[idx:end].decode('latin1')

target_symbols = {}
for i in range(symtab['size'] // symtab['entsize']):
    sym = data[symtab['offset'] + i*symtab['entsize'] : symtab['offset'] + (i+1)*symtab['entsize']]
    st_name, st_value, st_size, st_info, st_other, st_shndx = struct.unpack("<IIIBBH", sym)
    name = get_str(st_name)
    if 'setVideoInfo' in name or 'setImageDataBuffer' in name or 'play' in name:
        target_symbols[name] = (st_value, st_size)

print("Found target symbols:")
for name, (val, size) in target_symbols.items():
    print(f"  {name}: value=0x{val:x}, size={size}")

md = capstone.Cs(capstone.CS_ARCH_ARM, capstone.CS_MODE_ARM)

for name in ['_ZN22JSSoftVideoPlayerProxy12setVideoInfoER22JQFunctionCallbackInfo', '_ZN22JSSoftVideoPlayerProxy18setImageDataBufferER22JQFunctionCallbackInfo']:
    if name in target_symbols:
        val, size = target_symbols[name]
        print(f"\n--- Disassembly of {name} (0x{val:x}) ---")
        code = data[val:val+min(size, 160)]
        for insn in md.disasm(code, val):
            print(f"0x{insn.address:x}: {insn.mnemonic} {insn.op_str}")
