with open("scratch/official_index.js.bin", "rb") as f:
    data = f.read()

# Let's search for getContext
pos = data.find(b"getContext")
print("pos of getContext:", pos)
# Let's see the atom indices in the QuickJS binary
