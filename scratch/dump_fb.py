import subprocess
import os
from PIL import Image

subprocess.run(['adb', 'shell', 'dd if=/dev/fb0 of=/tmp/fb0.raw count=1 bs=220160 status=none'])
subprocess.run(['adb', 'pull', '/tmp/fb0.raw', 'fb0_test.raw'])

if os.path.exists('fb0_test.raw'):
    with open('fb0_test.raw', 'rb') as f:
        raw = f.read(220160)
    
    # 640 lines, 172 pixels per line, 2 bytes per pixel (RGB565 LE)
    # Convert to RGB888
    pixels = bytearray(640 * 172 * 3)
    p_idx = 0
    for i in range(0, 220160, 2):
        val = raw[i] | (raw[i+1] << 8)
        r = ((val >> 11) & 0x1F) * 255 // 31
        g = ((val >> 5) & 0x3F) * 255 // 63
        b = (val & 0x1F) * 255 // 31
        pixels[p_idx] = r
        pixels[p_idx+1] = g
        pixels[p_idx+2] = b
        p_idx += 3
        
    img = Image.frombytes('RGB', (172, 640), bytes(pixels))
    img_rot = img.rotate(270, expand=True)
    img_rot.save('screen_status_now.png')
    print('Saved screen_status_now.png size:', img_rot.size)
