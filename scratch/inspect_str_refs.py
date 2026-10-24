with open("libjsapi_softvideo.so", "rb") as f:
    data = f.read()

# Let's inspect bytes in setVideoInfo (0xfeac to 0xfeac+760) and find all offsets to strings
import re
code = data[0xfeac:0xfeac+760]
strs = re.findall(b"[%a-zA-Z0-9_:./ -]{3,}", data[0xfeac-200:0xfeac+1500])
for s in strs:
    print(" ", s.decode('latin1'))
