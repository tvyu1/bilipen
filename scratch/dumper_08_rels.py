import struct

from dumper_elf import Elf

e = Elf()
d = e.data
dynsym_sec = e.by_name['.dynsym']
dynstr_sec = e.by_name['.dynstr']
strdata = d[dynstr_sec['off']:dynstr_sec['off'] + dynstr_sec['size']]
relplt = e.by_name['.rel.plt']


def sym_name(i):
    raw = d[dynsym_sec['off'] + i * dynsym_sec['entsize']:
            dynsym_sec['off'] + (i + 1) * dynsym_sec['entsize']]
    st_name = struct.unpack('<I', raw[:4])[0]
    end = strdata.find(b'\0', st_name)
    return strdata[st_name:end].decode('latin1')


rels = []
for i in range(relplt['size'] // relplt['entsize']):
    raw = d[relplt['off'] + i * relplt['entsize']:relplt['off'] + (i + 1) * relplt['entsize']]
    r_offset, r_info = struct.unpack('<II', raw)
    rels.append((r_offset, sym_name(r_info >> 8), r_info & 0xff))

print("first 8 rel.plt:", [(hex(o), n, t) for o, n, t in rels[:8]])
plt_base = e.by_name['.plt']['addr'] + 0x14
for idx in [65]:
    stub = plt_base + idx * 12
    print(f"stub index {idx} @0x{stub:x} -> {rels[idx]}")
print("total rels", len(rels))
print("all imported symbols:")
print(sorted(set(n for _, n, _ in rels)))
