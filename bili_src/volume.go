package main

import (
	"encoding/json"
	"log"
	"net/http"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

const (
	VctlShmKey = 0x7663746c // 'vctl' SysV shared memory
	SYS_shmat  = 305
	SYS_shmdt  = 306
	SYS_shmget = 307
)

var (
	shmMemPtr       unsafe.Pointer
	shmOK           bool
	shmNextTry      time.Time
	shmAttempts     int
	lastAlsaVol     = -1
	volumeControlOK = false
)

// mapSysVolToHw 将 0~100 系统音量线性映射至 ALSA Control 23 (DAC LINEOUT Volume, 0~30)
func mapSysVolToHw(vol int) int {
	if vol <= 0 {
		return 0 // 静音
	}
	hw := int(float64(vol)*30.0/100.0 + 0.5)
	if hw < 1 {
		hw = 1
	}
	if hw > 30 {
		hw = 30
	}
	return hw
}

func initHardwareAudio() {
	vol := getSystemVolume()
	hwVal := mapSysVolToHw(vol)
	runTinymix("DAC LINEOUT Volume", strconv.Itoa(hwVal))
	log.Printf("[BiliDaemon] init hardware audio: DAC LINEOUT Volume = %d/30 (system volume %d%%)", hwVal, vol)
}

func runTinymix(args ...string) {
	full := append([]string{"-D", "0", "set"}, args...)
	cmd := exec.Command(TinymixPath, full...)
	if out, err := cmd.CombinedOutput(); err != nil {
		log.Printf("[BiliDaemon] tinymix %v failed: %v (%s)", args, err, strings.TrimSpace(string(out)))
	}
}

func initVolumeSharedMemory() {
	if shmMemPtr != nil {
		return
	}
	// ARM EABI: SYS_shmget = 307, SYS_shmat = 305
	shmid, _, err := syscall.Syscall(SYS_shmget, uintptr(VctlShmKey), 24, 0)
	if int(shmid) < 0 || err != 0 {
		log.Printf("[BiliDaemon] shmget failed (shmid=%d, err=%v)", int(shmid), err)
		return
	}
	raddr, _, err := syscall.Syscall(SYS_shmat, shmid, 0, 0x1000)
	if err != 0 || raddr == 0 || int(raddr) == -1 {
		log.Printf("[BiliDaemon] shmat failed (raddr=0x%x, err=%v)", raddr, err)
		return
	}
	ptrVal := raddr
	shmMemPtr = *(*unsafe.Pointer)(unsafe.Pointer(&ptrVal))
	shmOK = true
	log.Printf("[BiliDaemon] volume shared memory attached at %p", shmMemPtr)
}

// probeVolumeControl 探测 ALSA Control 23 (DAC LINEOUT Volume) 是否可用。
// 该控件控制喇叭硬件放大增益（0..30），用于与系统音量实时联动。
func probeVolumeControl() bool {
	for _, ctl := range []string{"DAC LINEOUT Volume", "23"} {
		out, _ := exec.Command(TinymixPath, "-D", "0", "get", ctl).CombinedOutput()
		text := strings.ToLower(string(out))
		if strings.Contains(text, "invalid mixer control") || strings.Contains(text, "error") {
			continue
		}
		if strings.ContainsAny(text, "0123456789") {
			return true
		}
	}
	return false
}

// volumeSyncLoop 保持与系统音量实时联动：100ms 轮询 vctl 共享内存，变化时写入 DAC LINEOUT Volume (0..30)
func volumeSyncLoop() {
	volumeControlOK = probeVolumeControl()
	if !volumeControlOK {
		log.Printf("[BiliDaemon] no writable master volume control, rely on HAL vctl (read-only)")
	} else {
		log.Printf("[BiliDaemon] hardware volume control active on DAC LINEOUT Volume (0..30)")
	}
	interval := 100 * time.Millisecond
	if !volumeControlOK {
		interval = 2 * time.Second
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for range ticker.C {
		vol, ok := readSystemVolume()
		if !ok || vol == lastAlsaVol {
			continue
		}
		lastAlsaVol = vol
		if !volumeControlOK {
			continue
		}
		hwVal := mapSysVolToHw(vol)
		runTinymix("DAC LINEOUT Volume", strconv.Itoa(hwVal))
		log.Printf("[BiliDaemon] volume sync: %d%% -> DAC LINEOUT %d/30", vol, hwVal)
	}
}

func readSystemVolume() (int, bool) {
	if shmMemPtr == nil {
		if !shmOK && time.Now().Before(shmNextTry) {
			return 0, false
		}
		initVolumeSharedMemory()
		if shmMemPtr == nil {
			if shmAttempts < 6 {
				shmAttempts++
			}
			shmNextTry = time.Now().Add(time.Duration(shmAttempts) * 5 * time.Second)
			log.Printf("[BiliDaemon] volume shm unavailable, retry in %v", time.Duration(shmAttempts)*5*time.Second)
			return 0, false
		}
		shmOK = true
	}
	spkVol := *(*uint32)(unsafe.Add(shmMemPtr, 4))
	if spkVol > 100 {
		spkVol = 50
	}
	return int(spkVol), true
}

func getSystemVolume() int {
	vol, ok := readSystemVolume()
	if !ok {
		return 50
	}
	return vol
}

func handleVolume(w http.ResponseWriter, r *http.Request) {
	setVal := r.URL.Query().Get("set")
	if setVal != "" {
		if v, err := strconv.Atoi(setVal); err == nil {
			if v < 0 {
				v = 0
			}
			if v > 100 {
				v = 100
			}
			hw := mapSysVolToHw(v)
			runTinymix("DAC LINEOUT Volume", strconv.Itoa(hw))
			log.Printf("[BiliDaemon] /api/volume manual set: %d%% -> DAC LINEOUT %d/30", v, hw)
		}
	}
	sysVol := getSystemVolume()
	hwVol := mapSysVolToHw(sysVol)
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"system_volume": sysVol,
		"hw_volume":     hwVol,
		"hw_control":    "DAC LINEOUT Volume",
		"hw_range":      "0-30",
	})
}
