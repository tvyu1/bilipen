package main

import (
	"fmt"
	"os"
	"syscall"
	"unsafe"
)

const (
	shmKey     = 0x7663746c
	SYS_shmat  = 305
	SYS_shmget = 307
)

func main() {
	shmid, _, errno := syscall.Syscall(SYS_shmget, uintptr(shmKey), 24, 0)
	if int(shmid) < 0 || errno != 0 {
		fmt.Printf("shmget failed shmid=%d errno=%v\n", int(shmid), errno)
		os.Exit(1)
	}
	addr, _, errno := syscall.Syscall(SYS_shmat, shmid, 0, 0x1000)
	if errno != 0 || addr == 0 || int(addr) == -1 {
		fmt.Printf("shmat failed addr=%#x errno=%v\n", addr, errno)
		os.Exit(1)
	}
	p := unsafe.Pointer(addr)
	for off := 0; off < 32; off += 4 {
		v := *(*uint32)(unsafe.Pointer(uintptr(p) + uintptr(off)))
		fmt.Printf("offset %2d (u32) = %d  (0x%08x)\n", off, v, v)
	}
}
