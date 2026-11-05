package main

// 听视频（audio-only）ALSA 直出。
//
// 背景：听视频模式下厂商播放器那条管线仍会解码一路黑帧视频。设备实测整机 CPU 13%，
// 其中约 4.5% 花在这条没用的视频管线上。这里改成 daemon 自己起一个 ffmpeg，把 DASH
// 音轨直接写进 ALSA，绕开厂商播放器。
//
// 设备约束（实测）：
//   - ALSA 只有 hw:0,0 可用。`-f alsa default` 报 "Invalid value for card"，
//     因为 /etc/asound.conf 的 softvol 绑在 card1，而本机只有 card0。
//   - ALSA 独占：第二个进程 open 会报 "Device or resource busy"。所以本文件只保留一个
//     全局 ffmpeg 实例；start 后若 <400ms 就退出，按 stderr 判断是不是 busy，busy 回 409，
//     让前端回退厂商播放器。
//   - 音量不在这里处理：volume.go 的 volumeSyncLoop 每 100ms 把 vctl 共享内存里的系统音量
//     镜像到 card0 的 "DAC LINEOUT Volume"（实测 system 50 ↔ DAC 15），ffmpeg 直出同样受控。
//
// 接口：
//   GET /api/audio/alsa?cmd=start&bvid=BV...&pos=SEC   起播（重复 start 先停旧的）
//   GET /api/audio/alsa?cmd=stop
//   GET /api/audio/alsa?cmd=pause
//   GET /api/audio/alsa?cmd=resume
//   GET /api/audio/alsa?cmd=seek&pos=SEC
//   GET /api/audio/alsa/status                         播放状态（解析 ffmpeg -progress 的 out_time）
//
// pause 的实现是「记下位置 → 杀掉进程」，resume 再带 -ss 重起。不用 SIGSTOP 的原因：
// ffmpeg 是长连接读 CDN，挂起一分钟以上上游必超时；且 -re 在恢复后会追帧（音频会抢播）。

import (
	"bufio"
	"bytes"
	"context"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

const alsaDevice = "hw:0,0"

// alsaStartProbe：start 后等待「早失败」的窗口。ALSA 被占时 ffmpeg 会立刻退出。
const alsaStartProbe = 400 * time.Millisecond

type alsaPlayer struct {
	mu      sync.Mutex
	cmd     *exec.Cmd
	cancel  context.CancelFunc
	gen     int // 代号：每次 start/stop 自增，用来丢弃过期 goroutine 的状态回写
	bvid    string
	baseMs  int64 // seek 起点（毫秒）
	outMs   int64 // ffmpeg 报的 out_time（毫秒，相对 seek 起点）
	durMs   int64
	playing bool
	paused  bool
	pid     int
	lastErr string
}

var alsaPl = &alsaPlayer{}

// alsaPidFile 记录当前直出 ffmpeg 的进程组 leader pid。
// ffmpeg 以 Setpgid 独立进程组运行，daemon 非正常退出（空闲 os.Exit、kill -9、崩溃）时
// 它不会跟着死，会一直占着 hw:0,0，新 daemon 只能拿到 busy（前端回退厂商播放器，仍然无声）。
// 这里在启动时按 pidfile 兜底回收；所有读写都在 p.mu 内完成，避免 start/stop 交错写错。
const alsaPidFile = "/userdisk/bili_alsa.pid"

func writeAlsaPidFile(pid int) {
	if pid <= 0 {
		return
	}
	if err := os.WriteFile(alsaPidFile, []byte(strconv.Itoa(pid)), 0o600); err != nil {
		log.Printf("[ALSA] write %s failed: %v", alsaPidFile, err)
	}
}

func removeAlsaPidFile() {
	if err := os.Remove(alsaPidFile); err != nil && !os.IsNotExist(err) {
		log.Printf("[ALSA] remove %s failed: %v", alsaPidFile, err)
	}
}

// reapStaleAlsa 在 daemon 启动时回收上一个实例留下的 ffmpeg（见 alsaPidFile 注释）。
func reapStaleAlsa() {
	b, err := os.ReadFile(alsaPidFile)
	if err != nil {
		return
	}
	pid, perr := strconv.Atoi(strings.TrimSpace(string(b)))
	if perr != nil || pid <= 0 {
		log.Printf("[ALSA] invalid pidfile %s (%q), removing", alsaPidFile, strings.TrimSpace(string(b)))
		removeAlsaPidFile()
		return
	}
	cmdline, cerr := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/cmdline")
	if cerr != nil {
		removeAlsaPidFile() // 进程早已不在
		return
	}
	// pid 可能已被系统复用：只杀确认是 ffmpeg 的进程
	line := firstLine(strings.ReplaceAll(string(cmdline), "\x00", " "))
	if !strings.Contains(line, "ffmpeg") {
		log.Printf("[ALSA] stale pid %d is not ffmpeg (%q), skip kill", pid, line)
		removeAlsaPidFile()
		return
	}
	if kerr := syscall.Kill(-pid, syscall.SIGKILL); kerr != nil {
		if kerr2 := syscall.Kill(pid, syscall.SIGKILL); kerr2 != nil {
			log.Printf("[ALSA] reap stale ffmpeg pid=%d failed: %v / %v", pid, kerr, kerr2)
			return
		}
	}
	log.Printf("[ALSA] reaped stale ffmpeg pid=%d left by previous daemon", pid)
	removeAlsaPidFile()
}

// stopLocked 停掉当前实例并清空播放状态（保留 gen 自增）。调用方需持锁。
func (p *alsaPlayer) stopLocked() {
	p.gen++
	if p.cancel != nil {
		p.cancel()
	}
	if p.cmd != nil && p.cmd.Process != nil {
		_ = p.cmd.Process.Kill()
	}
	p.cmd, p.cancel, p.pid = nil, nil, 0
	p.bvid = ""
	p.baseMs, p.outMs, p.durMs = 0, 0, 0
	p.playing, p.paused = false, false
	removeAlsaPidFile()
}

func (p *alsaPlayer) stop() {
	p.mu.Lock()
	was := p.playing || p.paused
	p.stopLocked()
	p.lastErr = ""
	p.mu.Unlock()
	if was {
		log.Printf("[ALSA] stopped")
	}
}

// pause 记下当前位置后杀掉进程；resume 用 -ss 从该位置重起。
func (p *alsaPlayer) pause() {
	p.mu.Lock()
	if !p.playing {
		p.mu.Unlock()
		return
	}
	bvid, posMs, durMs := p.bvid, p.baseMs+p.outMs, p.durMs
	p.stopLocked()
	p.bvid, p.baseMs, p.outMs, p.durMs = bvid, posMs, 0, durMs
	p.paused = true
	p.mu.Unlock()
	log.Printf("[ALSA] pause %s at %.1fs", bvid, float64(posMs)/1000)
}

func (p *alsaPlayer) resume() (int, map[string]interface{}) {
	p.mu.Lock()
	bvid, posMs, paused := p.bvid, p.baseMs+p.outMs, p.paused
	playing := p.playing
	p.mu.Unlock()
	if playing {
		return http.StatusOK, p.snapshot()
	}
	if !paused || bvid == "" {
		return http.StatusConflict, map[string]interface{}{"ok": false, "error": "not paused"}
	}
	return p.start(bvid, float64(posMs)/1000.0)
}

func (p *alsaPlayer) seek(posSec float64) (int, map[string]interface{}) {
	p.mu.Lock()
	bvid := p.bvid
	active := p.playing || p.paused
	p.mu.Unlock()
	if !active || bvid == "" {
		return http.StatusConflict, map[string]interface{}{"ok": false, "error": "not started"}
	}
	return p.start(bvid, posSec)
}

func (p *alsaPlayer) snapshot() map[string]interface{} {
	p.mu.Lock()
	defer p.mu.Unlock()
	posMs := p.baseMs + p.outMs
	resp := map[string]interface{}{
		"ok":      true,
		"playing": p.playing,
		"paused":  p.paused,
		"pos":     float64(posMs) / 1000.0,
		"dur":     float64(p.durMs) / 1000.0,
		"pos_ms":  posMs,
		"dur_ms":  p.durMs,
		"pid":     p.pid,
		"bvid":    p.bvid,
		"device":  alsaDevice,
	}
	if p.lastErr != "" {
		resp["error"] = p.lastErr
	}
	return resp
}

// start 起（或重起）单实例 ffmpeg。返回 HTTP 状态码 + 响应体：
// 200 起播成功 / 400 参数错 / 409 ALSA 被占（前端应回退厂商播放器）/ 502 解析或启动失败。
func (p *alsaPlayer) start(bvid string, posSec float64) (int, map[string]interface{}) {
	if bvid == "" || !validBVID(bvid) {
		return http.StatusBadRequest, map[string]interface{}{"ok": false, "error": "invalid or missing bvid"}
	}
	if posSec < 0 {
		posSec = 0
	}
	if _, err := os.Stat(FFmpegPath); err != nil {
		return http.StatusServiceUnavailable, map[string]interface{}{"ok": false, "error": "ffmpeg not available"}
	}

	// 音轨解析走 resolveAudio：只挑 AAC（30232>30216>30280），已排掉 Dolby/Hi-Res FLAC。
	// 先解析再停旧实例：解析失败（网络/无 AAC）时不要把人正在听的那路掐掉。
	au, err := resolveAudio(bvid)
	if err != nil {
		log.Printf("[ALSA] resolve audio failed for %s: %v", bvid, err)
		return http.StatusBadGateway, map[string]interface{}{"ok": false, "error": "audio: " + err.Error()}
	}
	durMs := int64(0)
	if meta, merr := resolveMeta(bvid); merr == nil {
		durMs = int64(meta.duration) * 1000
	}

	p.mu.Lock()
	p.stopLocked() // 重复 start 先停旧的
	gen := p.gen
	p.lastErr = ""
	p.mu.Unlock()

	ctx, cancel := context.WithCancel(context.Background())
	args := []string{
		"-hide_banner", "-loglevel", "error", "-nostdin",
		"-progress", "pipe:1", "-nostats",
		"-user_agent", UserAgent,
		"-referer", BiliReferer,
	}
	if c := loadCookie(); c != "" {
		args = append(args, "-headers", "Cookie: "+c+"\r\n")
	}
	args = append(args, "-re")
	if posSec > 0 {
		args = append(args, "-ss", strconv.FormatFloat(posSec, 'f', 3, 64))
	}
	args = append(args,
		"-i", au.url,
		"-vn",
		"-f", "alsa", alsaDevice,
	)

	// 与 audio remux 用同一套 launcher：有 /usr/bin/chrt 时以 SCHED_FIFO 49 运行
	// （进程绝大部分时间阻塞在 ALSA 写，实时优先级不会饿死别的线程）。
	cmd := execFFmpegCommand(ctx, args)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		cancel()
		return http.StatusInternalServerError, map[string]interface{}{"ok": false, "error": "ffmpeg pipe: " + err.Error()}
	}
	if err := cmd.Start(); err != nil {
		cancel()
		log.Printf("[ALSA] ffmpeg start failed for %s: %v", bvid, err)
		return http.StatusBadGateway, map[string]interface{}{"ok": false, "error": "ffmpeg start: " + err.Error()}
	}

	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()

	// 早失败探测：ALSA 独占，被占时 ffmpeg 立刻以 "Device or resource busy" 退出。
	select {
	case werr := <-done:
		msg := firstLine(stderr.String())
		if msg == "" && werr != nil {
			msg = werr.Error()
		}
		cancel()
		busy := strings.Contains(strings.ToLower(msg), "busy")
		code := http.StatusBadGateway
		if busy {
			code = http.StatusConflict
		}
		log.Printf("[ALSA] %s failed to open %s (busy=%v): %s", bvid, alsaDevice, busy, msg)
		return code, map[string]interface{}{
			"ok": false, "alsa_busy": busy, "device": alsaDevice, "error": msg,
		}
	case <-time.After(alsaStartProbe):
	}

	p.mu.Lock()
	if p.gen != gen {
		// 期间被另一次 start/stop 抢先：放弃这次，避免两个实例抢 ALSA
		p.mu.Unlock()
		cancel()
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
		return http.StatusConflict, map[string]interface{}{"ok": false, "error": "superseded by another start"}
	}
	p.cmd, p.cancel, p.bvid = cmd, cancel, bvid
	p.baseMs, p.outMs, p.durMs = int64(posSec*1000), 0, durMs
	p.playing, p.paused, p.pid, p.lastErr = true, false, cmd.Process.Pid, ""
	writeAlsaPidFile(cmd.Process.Pid) // 与状态赋值同锁，避免被并发的 start/stop 覆盖成旧 pid
	p.mu.Unlock()

	go p.readProgress(stdout, gen)
	go func() {
		werr := <-done
		p.mu.Lock()
		if p.gen == gen {
			p.playing = false
			p.cmd, p.cancel, p.pid = nil, nil, 0
			removeAlsaPidFile()
			if werr != nil && ctx.Err() == nil {
				p.lastErr = firstLine(stderr.String())
			}
			// 自然播完：把位置对齐到总长
			if p.durMs > 0 && p.baseMs+p.outMs >= p.durMs-500 {
				p.outMs = p.durMs - p.baseMs
			}
		}
		p.mu.Unlock()
		cancel()
	}()

	log.Printf("[ALSA] start %s at %.1fs -> %s pid=%d dur=%.1fs", bvid, posSec, alsaDevice, cmd.Process.Pid, float64(durMs)/1000)
	return http.StatusOK, p.snapshot()
}

// readProgress 解析 `-progress pipe:1` 的 key=value 流，只关心出流时间。
// 注意 ffmpeg 的 out_time_ms 打印的其实是微秒（历史遗留 bug），与 out_time_us 同义。
func (p *alsaPlayer) readProgress(r io.Reader, gen int) {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 4096), 64*1024)
	for sc.Scan() {
		k, v, ok := strings.Cut(sc.Text(), "=")
		if !ok || (k != "out_time_us" && k != "out_time_ms") {
			continue
		}
		us, err := strconv.ParseInt(v, 10, 64)
		if err != nil || us < 0 {
			continue
		}
		p.mu.Lock()
		if p.gen == gen {
			p.outMs = us / 1000
		}
		p.mu.Unlock()
	}
}

func firstLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		s = s[:i]
	}
	s = strings.TrimSpace(s)
	if len(s) > 300 {
		s = s[:300]
	}
	return s
}

func parsePosSeconds(s string) float64 {
	if s == "" {
		return 0
	}
	v, err := strconv.ParseFloat(s, 64)
	if err != nil || v < 0 {
		return 0
	}
	return v
}

// handleAudioAlsa 是 /api/audio/alsa 的入口：cmd=start|stop|pause|resume|seek|status。
func handleAudioAlsa(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	cmd := q.Get("cmd")
	if cmd == "" {
		cmd = "status"
	}
	switch cmd {
	case "start":
		code, resp := alsaPl.start(q.Get("bvid"), parsePosSeconds(q.Get("pos")))
		writeJSON(w, code, resp)
	case "stop":
		alsaPl.stop()
		writeJSON(w, http.StatusOK, alsaPl.snapshot())
	case "pause":
		alsaPl.pause()
		writeJSON(w, http.StatusOK, alsaPl.snapshot())
	case "resume":
		code, resp := alsaPl.resume()
		writeJSON(w, code, resp)
	case "seek":
		code, resp := alsaPl.seek(parsePosSeconds(q.Get("pos")))
		writeJSON(w, code, resp)
	case "status":
		writeJSON(w, http.StatusOK, alsaPl.snapshot())
	default:
		jsonError(w, "unknown cmd: "+cmd, http.StatusBadRequest)
	}
}

// handleAudioAlsaStatus 只读快照，前端 ~500ms 轮询一次（与 /api/stream/status 同风格）。
func handleAudioAlsaStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, alsaPl.snapshot())
}
