# -*- coding: utf-8 -*-
"""定位 libjsapi_softvideo.so 中 sws_getContext / sws_scale 的调用点，
用于确认软解输出尺寸是否来自 setVideoInfo（mWidth/mHeight）。"""
import struct
import capstone
from dumper_elf import Elf

e = Elf()
d = e.data

relplt = e.by_name.get('.rel.plt')
dynsym_sec = e.by_name['.dynsym']
dynstr = e.by_name['.dynstr']
strdata = d[dynstr['off']:dynstr['off'] + dynstr['size']]


def sym_name(i):
    raw = d[dynsym_sec['off'] + i * dynsym_sec['entsize']:
            dynsym_sec['off'] + (i + 1) * dynsym_sec['entsize']]
    st_name = struct.unpack('<I', raw[:4])[0]
    end = strdata.find(b'\0', st_name)
    return strdata[st_name:end].decode('latin1')


got = {}
for i in range(relplt['size'] // relplt['entsize']):
    raw = d[relplt['off'] + i * relplt['entsize']:relplt['off'] + (i + 1) * relplt['entsize']]
    r_offset, r_info = struct.unpack('<II', raw)
    got[r_offset] = sym_name(r_info >> 8)


def read32(a):
    for s in e.secs:
        if s['addr'] <= a < s['addr'] + s['size'] and s['type'] != 8:
            return struct.unpack('<I', d[s['off'] + (a - s['addr']):s['off'] + (a - s['addr']) + 4])[0]
    return None


def ror(v, r):
    r = (r * 2) % 32
    return ((v >> r) | (v << (32 - r))) & 0xffffffff if r else v


plt = e.by_name['.plt']
stubs = {}
addr = plt['addr'] + 0x14
while addr + 12 <= plt['addr'] + plt['size']:
    w0, w1, w2 = read32(addr), read32(addr + 4), read32(addr + 8)
    if w0 is None or (w0 & 0x0fff0000) != 0xe28f0000:
        addr += 4
        continue
    ip1 = addr + 8 + ror(w0 & 0xff, (w0 >> 8) & 0xf)
    ip2 = ip1 + (w1 & 0xfff)
    imm2 = w2 & 0xfff
    slot = (ip2 + imm2) if (w2 & (1 << 23)) else (ip2 - imm2)
    stubs[addr] = got.get(slot)
    addr += 12

for target_name in ('sws_getContext', 'sws_scale'):
    targets = [a for a, s in stubs.items() if s == target_name]
    print('PLT stubs for %s: %s' % (target_name, [hex(t) for t in targets]))
    if not targets:
        continue
    tset = set(targets)
    text = e.by_name['.text']
    tb = d[text['off']:text['off'] + text['size']]
    base = text['addr']
    md = capstone.Cs(capstone.CS_ARCH_ARM, capstone.CS_MODE_ARM)
    hits = []
    for i in range(0, len(tb) - 3, 4):
        w = struct.unpack_from('<I', tb, i)[0]
        if (w & 0xff000000) != 0xeb000000:
            continue
        imm = w & 0xffffff
        if imm & 0x800000:
            imm -= 0x1000000
        tgt = base + i + 8 + imm * 4
        if tgt in tset:
            hits.append(base + i)
    print('call sites:', [hex(h) for h in hits])
    for h in hits:
        print('--- around 0x%x ---' % h)
        start = max(base, h - 120)
        code = d[text['off'] + (start - base):text['off'] + (h + 4 - base)]
        for insn in md.disasm(code, start):
            print('   0x%x: %-8s %s' % (insn.address, insn.mnemonic, insn.op_str))
