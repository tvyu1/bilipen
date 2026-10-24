import struct

def parse_elf(filename):
    with open(filename, 'rb') as f:
        data = f.read()
    if data[:4] != b'\x7fELF':
        return []
    e_shoff, = struct.unpack('<I', data[32:36])
    e_shentsize, e_shnum, e_shstrndx = struct.unpack('<HHH', data[46:52])
    
    sections = []
    for i in range(e_shnum):
        off = e_shoff + i * e_shentsize
        sh_name, sh_type, sh_flags, sh_addr, sh_offset, sh_size, sh_link, sh_info, sh_addralign, sh_entsize = struct.unpack('<IIIIIIIIII', data[off:off+40])
        sections.append({
            'name_idx': sh_name, 'type': sh_type, 'offset': sh_offset, 'size': sh_size,
            'link': sh_link, 'entsize': sh_entsize, 'info': sh_info
        })
    
    shstrtab = data[sections[e_shstrndx]['offset']:sections[e_shstrndx]['offset']+sections[e_shstrndx]['size']]
    def get_name(idx):
        end = shstrtab.find(b'\x00', idx)
        return shstrtab[idx:end].decode('ascii', errors='ignore')
    
    for s in sections:
        s['name'] = get_name(s['name_idx'])
    
    symtab = [s for s in sections if s['type'] in (2, 11)] # SHT_SYMTAB, SHT_DYNSYM
    symbols = []
    for s in symtab:
        strtab = data[sections[s['link']]['offset']:sections[s['link']]['offset']+sections[s['link']]['size']]
        def get_sym_name(idx):
            end = strtab.find(b'\x00', idx)
            return strtab[idx:end].decode('ascii', errors='ignore')
        
        entsize = s['entsize'] or 16
        for i in range(s['size'] // entsize):
            off = s['offset'] + i * entsize
            st_name, st_value, st_size, st_info, st_other, st_shndx = struct.unpack('<IIIBBH', data[off:off+16])
            sym_name = get_sym_name(st_name)
            bind = st_info >> 4
            sym_type = st_info & 0xf
            symbols.append({'name': sym_name, 'bind': bind, 'type': sym_type, 'shndx': st_shndx, 'sec': s['name']})
    return symbols

for fn in ['libjsapi_fs.so', 'libjsapi_nekolib.so']:
    print('=== ' + fn + ' ===')
    syms = parse_elf(fn)
    for s in syms:
        if s['name']:
            print(' ', s['sec'], s['name'], 'bind=', s['bind'], 'shndx=', s['shndx'])
