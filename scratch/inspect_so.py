import struct

with open('libjsapi_softvideo.so', 'rb') as f:
    data = f.read()

# Let's search for setVideoInfo and setImageDataBuffer
print('setVideoInfo:', data.find(b'setVideoInfo'))
print('setImageDataBuffer:', data.find(b'setImageDataBuffer'))
