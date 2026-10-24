with open("libjsapi_softvideo.so", "rb") as f:
    data = f.read()

# Let's search for setVideoInfo symbol offset
import re
# Look for ELF symbol table
# Or let's use arm-none-eabi-objdump or similar if available, or write a simple disassembler/read bytes
idx = data.find(b"setVideoInfo")
print("setVideoInfo name at:", idx)
