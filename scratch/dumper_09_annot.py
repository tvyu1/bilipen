import struct
import re
import sys

import capstone

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
    rels.append((r_offset, sym_name(r_info >> 8)))

PLT0 = e.by_name['.plt']['addr'] + 0x14
plt_map = {}
for i, (off, name) in enumerate(rels):
    plt_map[PLT0 + 12 * i] = name


def sec_for_addr(a):
    for s in e.secs:
        if s['size'] and s['addr'] <= a < s['addr'] + s['size']:
            return s
    return None


def read_u32(a):
    s = sec_for_addr(a)
    if s is None:
        return None
    o = s['off'] + (a - s['addr'])
    if o + 4 > len(d):
        return None
    return struct.unpack('<I', d[o:o + 4])[0]


def annotate(addr, count):
    md = capstone.Cs(capstone.CS_ARCH_ARM, capstone.CS_MODE_ARM)
    text = e.by_name['.text']
    off = addr - text['addr'] + text['off']
    code = d[off:off + count * 4]
    for insn in md.disasm(code, addr):
        note = ''
        m, o = insn.mnemonic, insn.op_str
        # direct calls/branches
        mt = re.match(r'^(bl|blx|b|bx)$', m)
        if mt:
            tgt = int(o[1:], 16) if o.startswith('#') else None
            if tgt is not None:
                if tgt in plt_map:
                    note = '<' + plt_map[tgt] + '>'
                else:
                    note = f'func_0x{tgt:x}'
        # pc-relative literal load
        if m == 'ldr':
            mm = re.match(r'^(\w+), \[pc, #(0x[0-9a-f]+)\]$', o)
            if mm:
                imm = int(mm.group(2), 16)
                lit = insn.address + 8 + imm
                v = read_u32(lit)
                note = f'; lit@0x{lit:x} = 0x{v:x} ({v})' if v is not None else f'; lit@0x{lit:x}'
        print(f'0x{insn.address:06x}: {m:9s} {o:36s} {note}')


if __name__ == '__main__':
    addr = int(sys.argv[1], 0)
    n = int(sys.argv[2])
    annotate(addr, n)
