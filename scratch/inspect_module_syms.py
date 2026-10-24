# -*- coding: utf-8 -*-
import struct
from dumper_elf import Elf


def syms(path):
    e = Elf(path)
    d = e.data
    ds = e.by_name['.dynsym']
    dstr = e.by_name['.dynstr']
    sd = d[dstr['off']:dstr['off'] + dstr['size']]

    def nm(si):
        raw = d[ds['off'] + si * ds['entsize']:ds['off'] + (si + 1) * ds['entsize']]
        st = struct.unpack('<I', raw[:4])[0]
        en = sd.find(b'\0', st)
        return sd[st:en].decode('latin1')

    out = []
    for i in range(ds['size'] // ds['entsize']):
        raw = d[ds['off'] + i * ds['entsize']:ds['off'] + (i + 1) * ds['entsize']]
        st_name, st_value, st_size, st_info, st_other, st_shndx = struct.unpack('<IIIBBH', raw)
        out.append((nm(i), st_shndx, st_value, st_size))
    return out


for path in ('..\\libjsapi_nekolib.so', '..\\libjsapi_softvideo.so'):
    print('==== ' + path)
    ss = syms(path)
    print('-- exports (defined, non-empty name) --')
    for n, shndx, val, size in ss:
        if n and shndx != 0:
            print('  %s @0x%x size=%d' % (n, val, size))
    print('-- imports (UND) containing js/module/register/quick --')
    for n, shndx, val, size in ss:
        if n and shndx == 0 and any(k in n.lower() for k in ('js_', 'module', 'register', 'quick', 'custom')):
            print('  ' + n)

print('==== libfalcon exports matching register/module/jsapi')
for n, shndx, val, size in syms('..\\libfalcon.so'):
    if n and shndx != 0 and any(k in n.lower() for k in ('register', 'module', 'jsapi')):
        print('  ', n)
