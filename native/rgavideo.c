/*
 * libjsapi_rgavideo.so —— 用 FFmpeg 软件解码替代 softvideo 的视频解码链路。
 *
 * 设计要点（与 softvideo 的 JS 信号式 API 不同，改为 JS 轮询取帧，避免跨线程调用 QuickJS）：
 *   rgav.setBuffer(arrayBuffer, w, h)   // JS 提供的 RGBA 目标缓冲（ImageData.data.buffer）
 *   rgav.start(url)                     // 启动解码线程
 *   rgav.readFrame()                    // 有新帧则拷入 JS 缓冲并返回 1，否则 0
 *   rgav.stop()
 *   rgav.info() -> {width,height,duration}
 *   rgav.error() -> string
 *
 * 音频不在这里处理：由现有 /api/audio?variant=remux + softvideo 并行播放。
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <pthread.h>
#include <unistd.h>
#include <time.h>
#include <fcntl.h>
#include <errno.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <dlfcn.h>

/* ---- RGA（硬件 2D）YUV->BGRA + 缩放 ----
 * ABI 已用独立探针在真机验证（rga_api version 1.9.3_[0]，blit ret=0），
 * 结构体前段布局 fd/virAddr/phyAddr/hnd/format/rect{xoffset,yoffset,width,height,wstride,hstride,format,size}。
 * 结构体按 4096 字节容忍缓冲分配，避免不同小版本尾部字段差异造成越界。
 * 任何环节失败都静默回退 sws_scale。 */
#define RGA_FMT_YUV420P   (0x0b << 8)
#define RGA_FMT_BGRA8888  (0x03 << 8)

struct rga_dma_heap_data {
    uint64_t len;
    uint32_t fd;
    uint32_t fd_flags;
    uint64_t heap_flags;
};
#define RGA_DMA_HEAP_IOC_ALLOC _IOWR('H', 0x0, struct rga_dma_heap_data)

/* dma-buf cache 同步（FAQ A2.21：用 fd 访问时 CPU 前后必须同步 cache，否则花屏） */
struct rga_dma_buf_sync { uint64_t flags; };
#define RGA_DMA_BUF_IOCTL_SYNC  _IOW('b', 2, struct rga_dma_buf_sync)
#define RGA_SYNC_READ  (1UL << 0)
#define RGA_SYNC_WRITE (1UL << 1)
#define RGA_SYNC_START (0UL << 2)
#define RGA_SYNC_END   (1UL << 2)

static void rga_dma_sync(int fd, uint64_t flags) {
    struct rga_dma_buf_sync s;
    s.flags = flags;
    if (fd >= 0) ioctl(fd, RGA_DMA_BUF_IOCTL_SYNC, &s);
}

typedef struct {
    int xoffset, yoffset, width, height, wstride, hstride, format, size;
} rga_rect_t;

typedef struct {
    int fd;
    void *virAddr;
    void *phyAddr;
    unsigned hnd;
    int format;
    rga_rect_t rect;
} rga_info_head_t;

#include "quickjs.h"

#include <libavformat/avformat.h>
#include <libavcodec/avcodec.h>
#include <libswscale/swscale.h>

extern void registerCModuleLoader(const char *module_name,
                                  JSModuleDef *(*init_func)(JSContext *ctx, const char *name));

/* 帧环形缓冲槽位数：输出对齐显示区后每槽仅 ~210KB(306x172x4)，
 * 6 槽共 ~1.26MB（比旧 3x921KB=2.76MB 更省），但抖动余量从 100ms 提到 200ms。 */
#define RING_SLOTS 6

typedef struct {
    char *url;
    int out_w, out_h;
    uint8_t *jsbuf;
    size_t jsbuf_size;
    /* 3 帧环形缓冲：解码线程可以比 JS 渲染线程领先 1~2 帧，
     * 吸收主线程抖动（GC/音频回调/系统调度），避免单缓冲下周期性丢帧造成卡顿。 */
    uint8_t *ring[RING_SLOTS];
    size_t slot_size;
    int ring_head;   /* 生产者下次写入位置 */
    int ring_count;  /* 已填充帧数（消费者取走时减少） */

    pthread_t th;
    pthread_mutex_t mu;
    int thread_started;
    volatile int stop_flag;
    volatile int finished;
    volatile int sync_ready;   /* 首帧已就绪且 JS 已放行：readFrame 才开始出帧 */
    volatile int resume_req;   /* JS 调用了 resume()（只表示请求放行，不等同于首帧就绪） */
    double resume_offset;      /* 起播时跳过视频内容的前 N 秒，用于对齐已在播放的音频 */
    volatile int paused;       /* 暂停：解码线程原地等待，readFrame 不出帧 */
    volatile int unpause_req;  /* 恢复：把暂停时长补偿给播放时间轴 */
    double unpause_delta;
    double pause_started;
    volatile int adj_req;      /* JS 请求动态校正（音频位置追帧） */
    double adj_delta;          /* >0 视频内容需要前进(跳帧)，<0 需要等待 */
    double skip_until;         /* 跳帧目标内容时间（秒） */
    volatile int primed;       /* 首帧已解码进 back buffer */
    double last_t0_reset;      /* 追帧自愈：最近一次重置 t0 的时刻 */
    double last_io_time;       /* 最近一次 I/O 活跃时刻（用于超时中断） */

    int src_w, src_h;
    int pix_fmt;        /* 源像素格式：用于判断 4:2:0 子采样 */
    int cover;          /* 0=适应(整帧装入 out 框) 1=铺满(等比放大后居中裁剪) */
    int scale_algo;     /* sws 缩放核：0=FAST_BILINEAR 1=AREA 2=BILINEAR 3=POINT */
    int rga_use;        /* 本次播放是否走 RGA（0=回退 sws） */
    int rga_src_fd, rga_dst_fd;
    void *rga_src, *rga_dst;
    size_t rga_src_size, rga_dst_size;
    int rga_dst_stride;
    int sws_src_w, sws_src_h;  /* 送进 sws 的源尺寸（裁剪后） */
    int crop_x, crop_y;        /* 源图裁剪原点 */
    double duration;
    double position;
    char err[256];
} RgaPlayer;

static RgaPlayer g;

static double now_sec(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (double)ts.tv_sec + (double)ts.tv_nsec / 1e9;
}

static int decode_interrupt_cb(void *opaque) {
    RgaPlayer *p = (RgaPlayer *)opaque;
    if (!p) return 0;
    if (p->stop_flag) return 1;
    if (p->last_io_time > 0.0) {
        if (now_sec() - p->last_io_time > 8.0) {
            return 1;
        }
    }
    return 0;
}

static void set_err(RgaPlayer *p, const char *fmt, int code) {
    snprintf(p->err, sizeof(p->err), fmt, code);
}

/* 把一帧 YUV 转 BGRA 后放入环形缓冲（满则丢弃该帧，保持节奏）。 */
static void push_frame(RgaPlayer *p, struct SwsContext *sws, const AVFrame *frm, double pts) {
    /* 先在锁内预订一个空槽，转换放到锁外做：sws_scale 约 2~4ms，持锁会让
     * JS 侧 readFrame 的 memcpy 一起等（双向阻塞），是旧实现卡顿的来源之一。 */
    int slot = -1;
    pthread_mutex_lock(&p->mu);
    if (p->ring_count < RING_SLOTS) {
        slot = p->ring_head;
    }
    pthread_mutex_unlock(&p->mu);
    if (slot >= 0) {
        uint8_t *dst[4] = { p->ring[slot], NULL, NULL, NULL };
        int dst_stride[4] = { p->out_w * 4, 0, 0, 0 };
        /* 铺满模式：源指针挪到裁剪原点（4:2:0 色度平面按 2 取整偏移） */
        const uint8_t *src[4] = { frm->data[0], frm->data[1], frm->data[2], frm->data[3] };
        if (p->crop_x || p->crop_y) {
            int sub = (p->pix_fmt == AV_PIX_FMT_YUV420P || p->pix_fmt == AV_PIX_FMT_YUVJ420P) ? 2 : 1;
            for (int i = 0; i < 3; i++) {
                int s = (i == 0) ? 1 : sub;
                if (src[i]) {
                    src[i] += (size_t)(p->crop_y / s) * (size_t)frm->linesize[i] + (size_t)(p->crop_x / s);
                }
            }
        }
        sws_scale(sws, src, frm->linesize,
                  0, p->sws_src_h, dst, dst_stride);
        pthread_mutex_lock(&p->mu);
        p->ring_head = (p->ring_head + 1) % RING_SLOTS;
        p->ring_count++;
        p->position = pts;
        pthread_mutex_unlock(&p->mu);
    } else {
        pthread_mutex_lock(&p->mu);
        p->position = pts;
        pthread_mutex_unlock(&p->mu);
    }
}

/* ---------------- RGA 运行时 ---------------- */
static void *g_rga_lib;
static int (*g_rga_init)(void);
static int (*g_rga_blit)(void *, void *, void *);
static int g_rga_available;
static int g_rga_enabled = 1;

static int rga_heap_alloc(size_t len, void **addr) {
    const char *heap = "/dev/rk_dma_heap/rk-dma-heap-cma";
    int hf = open(heap, O_RDWR | O_CLOEXEC);
    if (hf < 0) return -1;
    struct rga_dma_heap_data d;
    memset(&d, 0, sizeof(d));
    d.len = len;
    d.fd_flags = O_RDWR | O_CLOEXEC;
    if (ioctl(hf, RGA_DMA_HEAP_IOC_ALLOC, &d) < 0) {
        close(hf);
        return -1;
    }
    close(hf);
    void *p = mmap(NULL, len, PROT_READ | PROT_WRITE, MAP_SHARED, d.fd, 0);
    if (p == MAP_FAILED) {
        close(d.fd);
        return -1;
    }
    *addr = p;
    return (int)d.fd;
}

static void rga_global_init(void) {
    if (g_rga_lib) return;
    g_rga_lib = dlopen("librga.so", RTLD_NOW);
    if (!g_rga_lib) g_rga_lib = dlopen("/usr/lib/librga.so", RTLD_NOW);
    if (!g_rga_lib) return;
    g_rga_init = (int (*)(void))dlsym(g_rga_lib, "c_RkRgaInit");
    g_rga_blit = (int (*)(void *, void *, void *))dlsym(g_rga_lib, "c_RkRgaBlit");
    if (!g_rga_blit) return;
    if (g_rga_init && g_rga_init() != 0) return;
    g_rga_available = 1;
}

static void rga_release(RgaPlayer *p) {
    if (p->rga_src) { munmap(p->rga_src, p->rga_src_size); p->rga_src = NULL; }
    if (p->rga_dst) { munmap(p->rga_dst, p->rga_dst_size); p->rga_dst = NULL; }
    if (p->rga_src_fd >= 0) { close(p->rga_src_fd); p->rga_src_fd = -1; }
    if (p->rga_dst_fd >= 0) { close(p->rga_dst_fd); p->rga_dst_fd = -1; }
    p->rga_use = 0;
}

/* 按源/输出尺寸准备 dma 缓冲；任何一步失败即回退 sws */
static int rga_prepare(RgaPlayer *p) {
    if (!g_rga_available || !g_rga_enabled) return 0;
    if (p->pix_fmt != AV_PIX_FMT_YUV420P && p->pix_fmt != AV_PIX_FMT_YUVJ420P) return 0;
    if (p->src_w <= 0 || p->src_h <= 0 || p->out_w <= 0 || p->out_h <= 0) return 0;
    /* BGRA_8888 的 width stride 无对齐要求（官方对齐表），可直接用 out_w，省掉逐行打包 */
    int stride = p->out_w;
    size_t ssize = (size_t)p->src_w * p->src_h * 3 / 2;
    size_t dsize = (size_t)stride * p->out_h * 4;
    if (p->rga_src && p->rga_src_size == ssize && p->rga_dst_stride == stride && p->rga_dst_size == dsize) {
        p->rga_use = 1;
        return 1;
    }
    rga_release(p);
    p->rga_src_fd = -1;
    p->rga_dst_fd = -1;
    p->rga_src_fd = rga_heap_alloc(ssize, &p->rga_src);
    if (p->rga_src_fd < 0) return 0;
    p->rga_dst_fd = rga_heap_alloc(dsize, &p->rga_dst);
    if (p->rga_dst_fd < 0) {
        rga_release(p);
        return 0;
    }
    p->rga_src_size = ssize;
    p->rga_dst_size = dsize;
    p->rga_dst_stride = stride;
    p->rga_use = 1;
    return 1;
}

/* 一帧：AVFrame(YUV420P) --memcpy--> dma 源 --RGA--> dma 目标 --打包--> 环槽 */
static void push_frame_rga(RgaPlayer *p, const AVFrame *frm, double pts) {
    int slot = -1;
    pthread_mutex_lock(&p->mu);
    if (p->ring_count < RING_SLOTS) slot = p->ring_head;
    pthread_mutex_unlock(&p->mu);
    if (slot >= 0) {
        rga_dma_sync(p->rga_src_fd, RGA_SYNC_START | RGA_SYNC_WRITE);
        uint8_t *d = (uint8_t *)p->rga_src;
        int w = p->src_w, h = p->src_h, cw = w / 2, ch = h / 2;
        int i;
        for (i = 0; i < h; i++) memcpy(d + (size_t)i * w, frm->data[0] + (size_t)i * frm->linesize[0], w);
        size_t off = (size_t)w * h;
        for (i = 0; i < ch; i++) memcpy(d + off + (size_t)i * cw, frm->data[1] + (size_t)i * frm->linesize[1], cw);
        off += (size_t)cw * ch;
        for (i = 0; i < ch; i++) memcpy(d + off + (size_t)i * cw, frm->data[2] + (size_t)i * frm->linesize[2], cw);

        rga_dma_sync(p->rga_src_fd, RGA_SYNC_END | RGA_SYNC_WRITE);

        unsigned char sbuf[4096], dbuf[4096];
        memset(sbuf, 0, sizeof(sbuf));
        memset(dbuf, 0, sizeof(dbuf));
        rga_info_head_t *si = (rga_info_head_t *)sbuf;
        rga_info_head_t *di = (rga_info_head_t *)dbuf;
        si->fd = p->rga_src_fd;
        si->virAddr = p->rga_src;
        si->format = RGA_FMT_YUV420P;
        si->rect.xoffset = p->crop_x;
        si->rect.yoffset = p->crop_y;
        si->rect.width = p->sws_src_w;
        si->rect.height = p->sws_src_h;
        si->rect.wstride = w;
        si->rect.hstride = h;
        si->rect.format = RGA_FMT_YUV420P;
        si->rect.size = (int)p->rga_src_size;
        di->fd = p->rga_dst_fd;
        di->virAddr = p->rga_dst;
        di->format = RGA_FMT_BGRA8888;
        di->rect.width = p->out_w;
        di->rect.height = p->out_h;
        di->rect.wstride = p->rga_dst_stride;
        di->rect.hstride = p->out_h;
        di->rect.format = RGA_FMT_BGRA8888;
        di->rect.size = (int)p->rga_dst_size;

        int ret = g_rga_blit(si, di, NULL);
        if (ret != 0) {
            /* RGA 失败：永久回退 sws，避免每帧重试拖慢播放 */
            snprintf(p->err, sizeof(p->err), "rga_blit=%d", ret);
            p->rga_use = 0;
            rga_release(p);
            pthread_mutex_lock(&p->mu);
            p->position = pts;
            pthread_mutex_unlock(&p->mu);
            return;
        }

        /* 环槽是紧凑打包（out_w*4 步长），dma 目标是 16 像素对齐步长，逐行搬 */
        uint8_t *slotp = p->ring[slot];
        int row = p->out_w * 4, srow = p->rga_dst_stride * 4;
        rga_dma_sync(p->rga_dst_fd, RGA_SYNC_START | RGA_SYNC_READ);
        if (row == srow) {
            memcpy(slotp, p->rga_dst, (size_t)row * p->out_h);
        } else {
            for (i = 0; i < p->out_h; i++)
                memcpy(slotp + (size_t)i * row, (uint8_t *)p->rga_dst + (size_t)i * srow, row);
        }
        rga_dma_sync(p->rga_dst_fd, RGA_SYNC_END | RGA_SYNC_READ);

        pthread_mutex_lock(&p->mu);
        p->ring_head = (p->ring_head + 1) % RING_SLOTS;
        p->ring_count++;
        p->position = pts;
        pthread_mutex_unlock(&p->mu);
    } else {
        pthread_mutex_lock(&p->mu);
        p->position = pts;
        pthread_mutex_unlock(&p->mu);
    }
}

static void *decode_main(void *arg) {
    RgaPlayer *p = (RgaPlayer *)arg;
    AVFormatContext *fmt = NULL;
    AVCodecContext *dec = NULL;
    struct SwsContext *sws = NULL;
    AVPacket *pkt = NULL;
    AVFrame *frm = NULL;
    int vst = -1;
    int ret;

    avformat_network_init();
    fmt = avformat_alloc_context();
    if (fmt) {
        fmt->interrupt_callback.callback = decode_interrupt_cb;
        fmt->interrupt_callback.opaque = p;
    }
    /* 收紧探测预算：默认 probesize/analyzeduration 会为找流信息多读上百 KB，
     * 在弱网/低码率流上直接表现为起播 primed 要 3s+（实测 3425ms vs 本地文件 400ms）。 */
    AVDictionary *opts = NULL;
    av_dict_set(&opts, "probesize", "131072", 0);
    av_dict_set(&opts, "analyzeduration", "131072", 0);
    p->last_io_time = now_sec();
    ret = avformat_open_input(&fmt, p->url, NULL, &opts);
    av_dict_free(&opts);
    p->last_io_time = now_sec();
    if (ret < 0) {
        set_err(p, "open_input=%d", ret);
        goto done;
    }
    if ((ret = avformat_find_stream_info(fmt, NULL)) < 0) {
        set_err(p, "stream_info=%d", ret);
        goto done;
    }
    vst = av_find_best_stream(fmt, AVMEDIA_TYPE_VIDEO, -1, -1, NULL, 0);
    if (vst < 0) {
        set_err(p, "no_video=%d", vst);
        goto done;
    }
    {
        AVCodecParameters *par = fmt->streams[vst]->codecpar;
        const AVCodec *codec = avcodec_find_decoder(par->codec_id);
        if (!codec) {
            set_err(p, "no_decoder=%d", par->codec_id);
            goto done;
        }
        dec = avcodec_alloc_context3(codec);
        if (!dec || avcodec_parameters_to_context(dec, par) < 0) {
            set_err(p, "codec_ctx=%d", -1);
            goto done;
        }
        dec->thread_count = 1;
        if ((ret = avcodec_open2(dec, codec, NULL)) < 0) {
            set_err(p, "codec_open=%d", ret);
            goto done;
        }
        p->src_w = dec->width;
        p->src_h = dec->height;
        p->pix_fmt = (int)dec->pix_fmt;
    }
    pthread_mutex_lock(&p->mu);
    p->duration = fmt->duration > 0 ? (double)fmt->duration / AV_TIME_BASE : 0.0;
    pthread_mutex_unlock(&p->mu);

    pkt = av_packet_alloc();
    frm = av_frame_alloc();
    /* 铺满(cover)模式：按 out 框宽高比在源图上居中裁剪后再缩放，
     * 这样「铺满」是真正的等比填充，而不是 CSS scale(1) 只见左上角。 */
    p->sws_src_w = p->src_w;
    p->sws_src_h = p->src_h;
    p->crop_x = 0;
    p->crop_y = 0;
    if (p->cover && p->out_w > 0 && p->out_h > 0 && p->src_w > 0 && p->src_h > 0) {
        double sxf = (double)p->out_w / (double)p->src_w;
        double syf = (double)p->out_h / (double)p->src_h;
        double s = (sxf > syf) ? sxf : syf;
        int cw = (int)((double)p->out_w / s + 0.5);
        int ch = (int)((double)p->out_h / s + 0.5);
        int sub = (dec->pix_fmt == AV_PIX_FMT_YUV420P || dec->pix_fmt == AV_PIX_FMT_YUVJ420P) ? 2 : 1;
        if (cw > p->src_w) cw = p->src_w;
        if (ch > p->src_h) ch = p->src_h;
        cw = (cw / sub) * sub;
        ch = (ch / sub) * sub;
        p->crop_x = ((p->src_w - cw) / 2 / sub) * sub;
        p->crop_y = ((p->src_h - ch) / 2 / sub) * sub;
        p->sws_src_w = cw;
        p->sws_src_h = ch;
    }
    rga_prepare(p);
    int sws_flags = SWS_FAST_BILINEAR;
    if (p->scale_algo == 1) sws_flags = SWS_AREA;   /* 专为降采样设计，通常比双线性便宜 */
    else if (p->scale_algo == 2) sws_flags = SWS_BILINEAR;
    else if (p->scale_algo == 3) sws_flags = SWS_POINT;
    sws = sws_getContext(p->sws_src_w, p->sws_src_h, dec->pix_fmt,
                         p->out_w, p->out_h, AV_PIX_FMT_BGRA,
                         sws_flags, NULL, NULL, NULL);
    if (!pkt || !frm || !sws) {
        set_err(p, "alloc=%d", -3);
        goto done;
    }

    {
        AVRational tb = fmt->streams[vst]->time_base;
        int64_t start_ts = AV_NOPTS_VALUE;
        double t0 = 0.0;
        while (!p->stop_flag) {
            /* 暂停：解码线程原地等待（不读流、不推进时间轴）。 */
            while (p->paused && !p->stop_flag) {
                usleep(5000);
            }
            if (p->stop_flag) {
                break;
            }
            p->last_io_time = now_sec();
            ret = av_read_frame(fmt, pkt);
            p->last_io_time = now_sec();
            if (ret < 0) {
                break;
            }
            if (pkt->stream_index != vst) {
                av_packet_unref(pkt);
                continue;
            }
            if (avcodec_send_packet(dec, pkt) < 0) {
                av_packet_unref(pkt);
                continue;
            }
            av_packet_unref(pkt);
            while (!p->stop_flag && avcodec_receive_frame(dec, frm) == 0) {
                double pts = 0.0;
                int64_t ts = frm->best_effort_timestamp;
                if (ts != AV_NOPTS_VALUE) {
                    if (start_ts == AV_NOPTS_VALUE) {
                        start_ts = ts;
                    } else {
                        pts = (double)(ts - start_ts) * av_q2d(tb);
                    }
                }
                /* 同步门控：首帧必须先解码进 back buffer 并等到 JS 的 resume() 请求，
                 * 再以「此刻」作为内容 0 点开始按 PTS 播放，实现音视频 0 点对齐。
                 * 注意：JS 的 resume 可能先于首帧到达，所以这里只看 primed，不看 sync_ready。 */
                if (!p->primed) {
                    if (p->rga_use) push_frame_rga(p, frm, pts);
                    else push_frame(p, sws, frm, pts);
                    p->primed = 1;
                    {
                        double waited = 0.0;
                        while (!p->resume_req && !p->stop_flag && waited < 4.0) {
                            usleep(2000);
                            waited += 0.002;
                        }
                    }
                    if (p->stop_flag) {
                        av_frame_unref(frm);
                        break;
                    }
                    p->sync_ready = 1;
                    t0 = now_sec() - pts - p->resume_offset;
                    p->last_t0_reset = now_sec();
                    av_frame_unref(frm);
                    continue;
                }
                /* 恢复播放：把暂停的时长补回时间轴，内容从中断处继续。 */
                if (p->unpause_req) {
                    p->unpause_req = 0;
                    t0 += p->unpause_delta;
                    p->last_t0_reset = now_sec();
                }
                /* 动态对齐：JS 用音频播放位置与视频内容位置比较后调用 adjust(delta)。
                 * delta>0 表示音频更靠前，视频需要跳过 delta 秒内容追上去；delta<0 表示视频要等一等。 */
                if (p->adj_req) {
                    double d = p->adj_delta;
                    p->adj_req = 0;
                    if (d > 1.0) d = 1.0;
                    if (d < -1.0) d = -1.0;
                    /* 阈值曾是 ±0.02：JS 发的 -0.020「刹车」恰好不满足 d < -0.02，等于从没执行过。
                     * 改为 -0.005 让 20~30ms 级刹车可用；单次负向钳到 -0.2s，避免长 nanosleep 定格。 */
                    if (d > 0.02) {
                        p->skip_until = p->position + d;
                        t0 -= d;
                    } else if (d < -0.005) {
                        if (d < -0.2) d = -0.2;
                        t0 += (-d);
                    }
                    p->last_t0_reset = now_sec();
                }
                if (p->skip_until > 0.0) {
                    if (pts < p->skip_until - 1e-6) {
                        pthread_mutex_lock(&p->mu);
                        p->position = pts;
                        pthread_mutex_unlock(&p->mu);
                        av_frame_unref(frm);
                        continue;
                    }
                    p->skip_until = 0.0;
                }
                /* 内容时间落后超过 80ms：丢弃该帧（不做 RGBA 转换、不显示），快速追回实时；
                 * 否则 30fps 内容在渲染节奏不匹配时会持续落后，表现为音频越来越超前。 */
                {
                    double now = now_sec();
                    double target = t0 + pts;
                    if (now - target > 0.08) {
                        /* 自愈兜底：异常情况下若持续落后超过 1.5s（如 t0 建立时机异常），
                         * 把内容 0 点重置到现在，避免永久黑屏只出音频。 */
                        if (now - p->last_t0_reset > 1.5) {
                            t0 = now - pts;
                            p->last_t0_reset = now;
                        }
                        pthread_mutex_lock(&p->mu);
                        p->position = pts;
                        pthread_mutex_unlock(&p->mu);
                        av_frame_unref(frm);
                        continue;
                    }
                    if (target > now + 0.001) {
                        double d = target - now;
                        struct timespec sl;
                        sl.tv_sec = (time_t)d;
                        sl.tv_nsec = (long)((d - (double)sl.tv_sec) * 1e9);
                        nanosleep(&sl, NULL);
                    }
                }
                /* 环形缓冲已满（渲染端落后）时等一等，最多 ~40ms；仍满则由 push_frame 丢帧保节奏。 */
                {
                    int wait_ms = 0;
                    while (!p->stop_flag && wait_ms < 40) {
                        pthread_mutex_lock(&p->mu);
                        int full = p->ring_count >= 3;
                        pthread_mutex_unlock(&p->mu);
                        if (!full) break;
                        usleep(2000);
                        wait_ms += 2;
                    }
                }
                if (p->stop_flag) {
                    av_frame_unref(frm);
                    break;
                }
                if (p->rga_use) push_frame_rga(p, frm, pts);
                else push_frame(p, sws, frm, pts);
                av_frame_unref(frm);
            }
        }
    }

done:
    if (sws) sws_freeContext(sws);
    if (pkt) av_packet_free(&pkt);
    if (frm) av_frame_free(&frm);
    if (dec) avcodec_free_context(&dec);
    if (fmt) avformat_close_input(&fmt);
    p->finished = 1;
    if (p->err[0] == 0 && !p->stop_flag) {
        snprintf(p->err, sizeof(p->err), "eof");
    }
    return NULL;
}

static void player_stop(RgaPlayer *p) {
    p->stop_flag = 1;
    p->sync_ready = 1; /* 释放可能正在等待 resume 的解码线程 */
    p->resume_req = 1;
    if (p->thread_started) {
        pthread_join(p->th, NULL);
        p->thread_started = 0;
    }
    rga_release(p);
    pthread_mutex_lock(&p->mu);
    for (int i = 0; i < RING_SLOTS; i++) {
        free(p->ring[i]);
        p->ring[i] = NULL;
    }
    p->slot_size = 0;
    p->ring_head = 0;
    p->ring_count = 0;
    pthread_mutex_unlock(&p->mu);
    if (p->url) {
        free(p->url);
        p->url = NULL;
    }
    p->finished = 0;
}

/* ---------------- JS 接口 ---------------- */

static JSValue js_setBuffer(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    size_t size = 0;
    int w = 0, h = 0;
    uint8_t *ptr;
    if (argc < 3) {
        return JS_ThrowTypeError(ctx, "setBuffer(buf, w, h)");
    }
    JS_ToInt32(ctx, &w, argv[1]);
    JS_ToInt32(ctx, &h, argv[2]);
    ptr = JS_GetArrayBuffer(ctx, &size, argv[0]);
    if (!ptr || w <= 0 || h <= 0) {
        return JS_ThrowTypeError(ctx, "invalid buffer");
    }
    if ((size_t)w * (size_t)h * 4 > size) {
        return JS_ThrowTypeError(ctx, "buffer too small: %d x %d > %d", w, h, (int)size);
    }
    /* JS 的 stop() 是异步的（等解码线程退出要几十~几百 ms），紧接着起播时线程可能仍在跑。
     * 早期实现直接抛错，表现为「原生播放失败，回退 softvideo」。这里改为内部先 stop 再设置。 */
    if (g.thread_started) {
        player_stop(&g);
    }
    pthread_mutex_lock(&g.mu);
    g.jsbuf = ptr;
    g.jsbuf_size = size;
    g.out_w = w;
    g.out_h = h;
    pthread_mutex_unlock(&g.mu);
    return JS_NewInt32(ctx, 1);
}

static JSValue js_start(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    const char *url;
    size_t len = 0;
    if (argc < 1) {
        return JS_ThrowTypeError(ctx, "start(url)");
    }
    url = JS_ToCStringLen2(ctx, &len, argv[0], 0);
    if (!url) {
        return JS_ThrowTypeError(ctx, "bad url");
    }
    player_stop(&g);
    memset(g.err, 0, sizeof(g.err));
    g.url = strdup(url);
    JS_FreeCString(ctx, url);
    if (!g.url) {
        return JS_ThrowTypeError(ctx, "oom");
    }
    if (g.out_w <= 0 || g.out_h <= 0) {
        g.out_w = 640;
        g.out_h = 360;
    }
    g.slot_size = (size_t)g.out_w * (size_t)g.out_h * 4;
    for (int i = 0; i < RING_SLOTS; i++) {
        g.ring[i] = (uint8_t *)malloc(g.slot_size);
        if (!g.ring[i]) {
            for (int j = 0; j < i; j++) {
                free(g.ring[j]);
                g.ring[j] = NULL;
            }
            g.slot_size = 0;
            return JS_ThrowTypeError(ctx, "oom ring");
        }
    }
    g.ring_head = 0;
    g.ring_count = 0;
    g.stop_flag = 0;
    g.finished = 0;
    g.sync_ready = 0;
    g.primed = 0;
    g.resume_req = 0;
    g.resume_offset = 0;
    g.adj_req = 0;
    g.adj_delta = 0.0;
    g.skip_until = 0.0;
    g.paused = 0;
    g.unpause_req = 0;
    g.unpause_delta = 0.0;
    g.pause_started = 0.0;
    g.last_t0_reset = now_sec();
    if (pthread_create(&g.th, NULL, decode_main, &g) != 0) {
        return JS_ThrowTypeError(ctx, "pthread_create failed");
    }
    g.thread_started = 1;
    return JS_NewInt32(ctx, 1);
}

static JSValue js_readFrame(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    int got = 0;
    pthread_mutex_lock(&g.mu);
    if (!g.paused && g.sync_ready && g.ring_count > 0 && g.jsbuf && g.jsbuf_size >= g.slot_size) {
        int tail = (g.ring_head - g.ring_count + RING_SLOTS) % RING_SLOTS;
        memcpy(g.jsbuf, g.ring[tail], g.slot_size);
        g.ring_count--;
        got = 1;
    }
    pthread_mutex_unlock(&g.mu);
    return JS_NewInt32(ctx, got);
}

static JSValue js_stop(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    player_stop(&g);
    return JS_NewInt32(ctx, 1);
}

static JSValue js_pause(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    if (!g.paused) {
        g.paused = 1;
        g.pause_started = now_sec();
    }
    return JS_NewInt32(ctx, 1);
}

static JSValue js_unpause(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    if (g.paused) {
        g.paused = 0;
        g.unpause_delta = now_sec() - g.pause_started;
        g.unpause_req = 1;
    }
    return JS_NewInt32(ctx, 1);
}

/* JS 在音频位置回调时调用：放行视频。可选参数 offset（秒）= 视频内容需要跳过的开头长度，
 * 用于对齐「已经开始播放的音频」与「从 0 开始的视频」。 */
static JSValue js_resume(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    double off = 0.0;
    if (argc >= 1) {
        if (JS_ToFloat64(ctx, &off, argv[0]) != 0 || !(off >= 0.0) || off > 30.0) {
            off = 0.0;
        }
    }
    g.resume_offset = off;
    /* 只记录「请求放行」；真正开播要等解码线程拿到首帧（primed），避免竞态导致黑屏。 */
    g.resume_req = 1;
    return JS_NewInt32(ctx, 1);
}

/* 动态对齐：JS 传入 delta 秒（音频位置 - 视频位置）。>0 视频跳帧追上音频，<0 视频等待音频。 */
static JSValue js_adjust(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    double d = 0.0;
    if (argc >= 1) {
        if (JS_ToFloat64(ctx, &d, argv[0]) != 0) {
            d = 0.0;
        }
    }
    if (d > 2.0) d = 2.0;
    if (d < -2.0) d = -2.0;
    g.adj_delta = d;
    g.adj_req = 1;
    return JS_NewInt32(ctx, 1);
}

static JSValue js_info(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    JSValue obj = JS_NewObject(ctx);
    int w, h, fin, primed;
    double dur, pos;
    pthread_mutex_lock(&g.mu);
    w = g.src_w;
    h = g.src_h;
    dur = g.duration;
    pos = g.position;
    fin = g.finished;
    primed = g.primed;
    pthread_mutex_unlock(&g.mu);
    JS_SetPropertyStr(ctx, obj, "width", JS_NewInt32(ctx, w));
    JS_SetPropertyStr(ctx, obj, "height", JS_NewInt32(ctx, h));
    JS_SetPropertyStr(ctx, obj, "duration", JS_NewFloat64(ctx, dur));
    JS_SetPropertyStr(ctx, obj, "position", JS_NewFloat64(ctx, pos));
    JS_SetPropertyStr(ctx, obj, "finished", JS_NewInt32(ctx, fin));
    JS_SetPropertyStr(ctx, obj, "primed", JS_NewInt32(ctx, primed));
    return obj;
}

static JSValue js_error(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    return JS_NewStringLen(ctx, g.err, strlen(g.err));
}

static JSValue js_duration(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    double dur;
    pthread_mutex_lock(&g.mu);
    dur = g.duration;
    pthread_mutex_unlock(&g.mu);
    return JS_NewFloat64(ctx, dur);
}

static JSValue js_position(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    double pos;
    pthread_mutex_lock(&g.mu);
    pos = g.position;
    pthread_mutex_unlock(&g.mu);
    return JS_NewFloat64(ctx, pos);
}

/* setCropMode(0|1)：0=适应（整帧装入输出框），1=铺满（等比放大后居中裁剪）。
 * 必须在 start() 之前调用，与 setBuffer 一样只在空闲时设置。 */
static JSValue js_setCropMode(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    int mode = 0;
    if (argc >= 1) {
        JS_ToInt32(ctx, &mode, argv[0]);
    }
    pthread_mutex_lock(&g.mu);
    if (g.thread_started) {
        pthread_mutex_unlock(&g.mu);
        return JS_ThrowTypeError(ctx, "cannot setCropMode while running");
    }
    g.cover = mode ? 1 : 0;
    pthread_mutex_unlock(&g.mu);
    return JS_NewInt32(ctx, 1);
}

/* setRGAEnabled(0|1)：RGA 总开关（默认开）。库不可用或 blit 失败会自动回退 sws */
static JSValue js_setRGAEnabled(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    int on = 1;
    if (argc >= 1) JS_ToInt32(ctx, &on, argv[0]);
    pthread_mutex_lock(&g.mu);
    g_rga_enabled = on ? 1 : 0;
    pthread_mutex_unlock(&g.mu);
    return JS_NewInt32(ctx, g_rga_available);
}

/* rgaAvailable()：返回 RGA 是否可用（1/0），用于日志与 A/B */
static JSValue js_rgaAvailable(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    return JS_NewInt32(ctx, g_rga_available ? 1 : 0);
}

/* setScaleAlgo(n)：0=FAST_BILINEAR 1=AREA(降采样推荐) 2=BILINEAR 3=POINT，须在 start() 前调用 */
static JSValue js_setScaleAlgo(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    int algo = 0;
    if (argc >= 1) {
        JS_ToInt32(ctx, &algo, argv[0]);
    }
    pthread_mutex_lock(&g.mu);
    if (g.thread_started) {
        pthread_mutex_unlock(&g.mu);
        return JS_ThrowTypeError(ctx, "cannot setScaleAlgo while running");
    }
    g.scale_algo = algo;
    pthread_mutex_unlock(&g.mu);
    return JS_NewInt32(ctx, 1);
}

static int js_module_init(JSContext *ctx, JSModuleDef *m) {
    JSValue obj = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, obj, "setBuffer", JS_NewCFunction2(ctx, js_setBuffer, "setBuffer", 3, JS_CFUNC_generic, 0));
    JS_SetPropertyStr(ctx, obj, "start", JS_NewCFunction2(ctx, js_start, "start", 1, JS_CFUNC_generic, 0));
    JS_SetPropertyStr(ctx, obj, "readFrame", JS_NewCFunction2(ctx, js_readFrame, "readFrame", 0, JS_CFUNC_generic, 0));
    JS_SetPropertyStr(ctx, obj, "setCropMode", JS_NewCFunction2(ctx, js_setCropMode, "setCropMode", 1, JS_CFUNC_generic, 0));
    JS_SetPropertyStr(ctx, obj, "setScaleAlgo", JS_NewCFunction2(ctx, js_setScaleAlgo, "setScaleAlgo", 1, JS_CFUNC_generic, 0));
    JS_SetPropertyStr(ctx, obj, "setRGAEnabled", JS_NewCFunction2(ctx, js_setRGAEnabled, "setRGAEnabled", 1, JS_CFUNC_generic, 0));
    JS_SetPropertyStr(ctx, obj, "rgaAvailable", JS_NewCFunction2(ctx, js_rgaAvailable, "rgaAvailable", 0, JS_CFUNC_generic, 0));
    JS_SetPropertyStr(ctx, obj, "stop", JS_NewCFunction2(ctx, js_stop, "stop", 0, JS_CFUNC_generic, 0));
    JS_SetPropertyStr(ctx, obj, "pause", JS_NewCFunction2(ctx, js_pause, "pause", 0, JS_CFUNC_generic, 0));
    JS_SetPropertyStr(ctx, obj, "unpause", JS_NewCFunction2(ctx, js_unpause, "unpause", 0, JS_CFUNC_generic, 0));
    JS_SetPropertyStr(ctx, obj, "resume", JS_NewCFunction2(ctx, js_resume, "resume", 0, JS_CFUNC_generic, 0));
    JS_SetPropertyStr(ctx, obj, "adjust", JS_NewCFunction2(ctx, js_adjust, "adjust", 0, JS_CFUNC_generic, 0));
    JS_SetPropertyStr(ctx, obj, "info", JS_NewCFunction2(ctx, js_info, "info", 0, JS_CFUNC_generic, 0));
    JS_SetPropertyStr(ctx, obj, "error", JS_NewCFunction2(ctx, js_error, "error", 0, JS_CFUNC_generic, 0));
    JS_SetPropertyStr(ctx, obj, "duration", JS_NewCFunction2(ctx, js_duration, "duration", 0, JS_CFUNC_generic, 0));
    JS_SetPropertyStr(ctx, obj, "position", JS_NewCFunction2(ctx, js_position, "position", 0, JS_CFUNC_generic, 0));
    JS_SetModuleExport(ctx, m, "default", obj);
    return 0;
}

static JSModuleDef *rgav_loader(JSContext *ctx, const char *name) {
    JSModuleDef *m = JS_NewCModule(ctx, name, js_module_init);
    if (!m) {
        return NULL;
    }
    JS_AddModuleExport(ctx, m, "default");
    return m;
}

__attribute__((visibility("default"))) void custom_init_jsapis(void) {
    pthread_mutex_init(&g.mu, NULL);
    rga_global_init();
    registerCModuleLoader("rgavideo", rgav_loader);
}

__attribute__((visibility("default"))) int jsapi_check_unload(void) {
    return g.thread_started ? 0 : 1;
}
