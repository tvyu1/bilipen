import struct
import capstone

DEFAULT_SO = 'libquickjs.so'


class Elf:
    def __init__(self, path=DEFAULT_SO):
        self.path = path
        self.data = open(path, 'rb').read()
        d = self.data
        self.e_shoff = struct.unpack('<I', d[32:36])[0]
        self.e_shentsize = struct.unpack('<H', d[46:48])[0]
        self.e_shnum = struct.unpack('<H', d[48:50])[0]
        self.e_shstrndx = struct.unpack('<H', d[50:52])[0]
        self.secs = []
        for i in range(self.e_shnum):
            h = d[self.e_shoff + i * self.e_shentsize:self.e_shoff + (i + 1) * self.e_shentsize]
            nm, ty, fl, ad, of, sz, lk, inf, al, es = struct.unpack('<10I', h)
            self.secs.append(dict(name_idx=nm, type=ty, flags=fl, addr=ad, off=of,
                                  size=sz, link=lk, info=inf, align=al, entsize=es))
        self.shstr = d[self.secs[self.e_shstrndx]['off']:
                       self.secs[self.e_shstrndx]['off'] + self.secs[self.e_shstrndx]['size']]
        for s in self.secs:
            s['name'] = self._str(self.shstr, s['name_idx'])
        self.by_name = {s['name']: s for s in self.secs}
        self.dynsym = {}
        self._parse_dynsym()

    def _str(self, blob, idx):
        e = blob.find(b'\0', idx)
        return blob[idx:e].decode('latin1')

    def _parse_dynsym(self):
        sym = self.by_name['.dynsym']
        st = self.by_name['.dynstr']
        strdata = self.data[st['off']:st['off'] + st['size']]
        n = sym['size'] // sym['entsize']
        for i in range(n):
            raw = self.data[sym['off'] + i * sym['entsize']:
                           sym['off'] + (i + 1) * sym['entsize']]
            st_name, st_value, st_size, st_info, st_other, st_shndx = struct.unpack('<IIIBBH', raw)
            name = self._str(strdata, st_name)
            if name:
                self.dynsym[name] = (st_value, st_size, st_info)

    def text_addr(self):
        return self.by_name['.text']['addr']

    def disasm(self, addr, count=40, thumb=False):
        md = capstone.Cs(capstone.CS_ARCH_ARM, capstone.CS_MODE_THUMB if thumb else capstone.CS_MODE_ARM)
        off = addr - self.by_name['.text']['addr'] + self.by_name['.text']['off']
        code = self.data[off:off + count * 4]
        out = []
        for insn in md.disasm(code, addr):
            out.append((insn.address, insn.mnemonic, insn.op_str, insn.size))
        return out

    def show(self, addr, count=40, thumb=False):
        for a, m, o, sz in self.disasm(addr, count, thumb):
            print(f'0x{a:08x}: {m:8s} {o}')


if __name__ == '__main__':
    e = Elf()
    print('text addr', hex(e.text_addr()))
    for n, v in sorted(e.dynsym.items()):
        if 'WriteObject' in n or 'ReadObject' in n or 'Eval' in n:
            print(f'{n}: 0x{v[0]:x} size={v[1]}')
