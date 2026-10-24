import struct

target = struct.pack('<I', 0xa6965ba8)
with open('/proc/717/maps', 'r') as f:
    maps = f.readlines()

with open('/proc/717/mem', 'rb', 0) as mem:
    for line in maps:
        parts = line.split()
        perms = parts[1]
        if 'r' not in perms:
            continue
        addr_range = parts[0].split('-')
        start = int(addr_range[0], 16)
        end = int(addr_range[1], 16)
        if end - start > 20*1024*1024:
            continue
        try:
            mem.seek(start)
            data = mem.read(end - start)
            idx = 0
            while True:
                idx = data.find(target, idx)
                if idx == -1:
                    break
                print('Found pointer at:', hex(start + idx), 'in', line.strip())
                # print 32 bytes before and after
                ctx_start = max(0, idx - 16)
                ctx_end = min(len(data), idx + 32)
                print('   dump:', data[ctx_start:ctx_end].hex())
                idx += 4
        except Exception as e:
            pass
