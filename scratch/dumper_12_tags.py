import re
import struct

import capstone

from dumper_elf import Elf

e = Elf()
d = e.data

md = capstone.Cs(capstone.CS_ARCH_ARM, capstone.CS_MODE_ARM)


def disasm_range(a, b):
    text = e.by_name['.text']
    off = a - text['addr'] + text['off']
    code = d[off:off + (b - a)]
    return list(md.disasm(code, a))


insns = disasm_range(0x7d8d4, 0x7ee50)
print(f'{len(insns)} instructions')

TAG_NAMES = {}


def call_target(op):
    m = re.match(r'^#(0x[0-9a-f]+)$', op)
    return int(m.group(1), 16) if m else None


plt_map = {}
# rebuild plt map
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


PLT0 = e.by_name['.plt']['addr'] + 0x14
for i in range(relplt['size'] // relplt['entsize']):
    raw = d[relplt['off'] + i * relplt['entsize']:relplt['off'] + (i + 1) * relplt['entsize']]
    _, r_info = struct.unpack('<II', raw)
    plt_map[PLT0 + 12 * i] = sym_name(r_info >> 8)

for idx, insn in enumerate(insns):
    m = insn.mnemonic
    if m in ('mov', 'movs', 'movw', 'movt') and re.search(r'r1, #0x[0-9a-f]+$', insn.op_str):
        imm = int(insn.op_str.split('#')[1], 16)
        if imm <= 0x40:
            # look ahead 4 insns for dbuf_putc call
            for j in range(idx + 1, min(idx + 5, len(insns))):
                if insns[j].mnemonic == 'bl':
                    t = call_target(insns[j].op_str)
                    if t is not None:
                        if plt_map.get(t) == 'dbuf_putc':
                            print(f"0x{insn.address:06x}: mov r1,#0x{imm:x}  -> dbuf_putc @0x{insns[j].address:x}")
                            # print next 3 after
                            for k in range(j + 1, min(j + 4, len(insns))):
                                ii = insns[k]
                                note = ''
                                if ii.mnemonic in ('bl', 'b'):
                                    tt = call_target(ii.op_str)
                                    if tt in plt_map:
                                        note = '<' + plt_map[tt] + '>'
                                    elif tt is not None:
                                        note = f'func_0x{tt:x}'
                                print(f"     0x{ii.address:06x}: {ii.mnemonic} {ii.op_str} {note}")
                        break
