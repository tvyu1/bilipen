import struct
import sys

from dumper_elf import Elf

e = Elf()
d = e.data

# sections
for s in e.secs:
    print(f"{s['name']:18s} addr=0x{s['addr']:08x} off=0x{s['off']:08x} size=0x{s['size']:08x} entsize={s['entsize']}")

relplt = e.by_name.get('.rel.plt')
dynsym_sec = e.by_name['.dynsym']
dynstr_sec = e.by_name['.dynstr']
strdata = d[dynstr_sec['off']:dynstr_sec['off'] + dynstr_sec['size']]


def sym_name(i):
    raw = d[dynsym_sec['off'] + i * dynsym_sec['entsize']:
            dynsym_sec['off'] + (i + 1) * dynsym_sec['entsize']]
    st_name = struct.unpack('<I', raw[:4])[0]
    end = strdata.find(b'\0', st_name)
    return strdata[st_name:end].decode('latin1')


got_slots = {}
for i in range(relplt['size'] // relplt['entsize']):
    raw = d[relplt['off'] + i * relplt['entsize']:relplt['off'] + (i + 1) * relplt['entsize']]
    r_offset, r_info = struct.unpack('<II', raw)
    symidx = r_info >> 8
    typ = r_info & 0xff
    got_slots[r_offset] = (sym_name(symidx), typ)

print(f"\n.rel.plt entries: {len(got_slots)}")
got_section = e.by_name.get('.got')
print('got', got_section)

# PLT stub resolution: stub at addr A: ip=(A+8)+0xc6000; slot = ip + imm -? 
# From disasm: add ip,pc,#0,#12 ; add ip,ip,#0xc6000 ; ldr pc,[ip,#0xa5c]!
# PC in ARM = addr+8. at first insn addr A -> ip=A+8; then +0xc6000; then pre-index add imm.
plt = e.by_name['.plt']
plt_addr = plt['addr']
plt_end = plt_addr + plt['size']
print(f"plt 0x{plt_addr:x}..0x{plt_end:x}")

addr = plt_addr + 0x14  # guess header 4 entries
idx = 0
result = {}
while addr + 12 <= plt_end:
    a0 = struct.unpack('<I', d[e.by_name['.text']['off']:]) if False else None
    # read via helper: map addr->file offset using section containing addr
    def read32(a):
        for s in e.secs:
            if s['addr'] <= a < s['addr'] + s['size'] and s['type'] != 8:
                return struct.unpack('<I', d[s['off'] + (a - s['addr']):s['off'] + (a - s['addr']) + 4])[0]
        return None
    w0 = read32(addr)
    w1 = read32(addr + 4)
    w2 = read32(addr + 8)
    if w0 is None or (w0 & 0x0fff0000) != 0xe28f0000:  # add ip,pc,...
        addr += 4
        continue
    rot = (w0 >> 8) & 0xf
    imm0 = w0 & 0xff
    def ror(v, r):
        r = (r * 2) % 32
        return ((v >> r) | (v << (32 - r))) & 0xffffffff if r else v
    ip1 = addr + 8 + ror(imm0, rot)
    imm1 = w1 & 0xfff
    ip2 = ip1 + imm1
    imm2 = w2 & 0xfff
    pre = bool(w2 & (1 << 24))
    add = bool(w2 & (1 << 23))
    up = bool(w2 & (1 << 23))
    slot = (ip2 + imm2) if up else (ip2 - imm2)
    result[addr] = (slot, got_slots.get(slot))
    addr += 12
    idx += 1

for a, (slot, sym) in sorted(result.items()):
    print(f"PLT 0x{a:x} -> GOT 0x{slot:x} -> {sym}")
