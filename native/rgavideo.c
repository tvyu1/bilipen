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

#include "quickjs.h"

#include <libavformat/avformat.h>
#include <libavcodec/avcodec.h>
#include <libswscale/swscale.h>

extern void registerCModuleLoader(const char *module_name,
                                  JSModuleDef *(*init_func)(JSContext *ctx, const char *name));

typedef struct {
    char *url;
    int out_w, out_h;
    uint8_t *jsbuf;
    size_t jsbuf_size;
    /* 3 帧环形缓冲：解码线程可以比 JS 渲染线程领先 1~2 帧，
     * 吸收主线程抖动（GC/音频回调/系统调度），避免单缓冲下周期性丢帧造成卡顿。 */
    uint8_t *ring[3];
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
    pthread_mutex_lock(&p->mu);
    if (p->ring_count < 3) {
        uint8_t *dst[4] = { p->ring[p->ring_head], NULL, NULL, NULL };
        int dst_stride[4] = { p->out_w * 4, 0, 0, 0 };
        sws_scale(sws, (const uint8_t *const *)frm->data, frm->linesize,
                  0, p->src_h, dst, dst_stride);
        p->ring_head = (p->ring_head + 1) % 3;
        p->ring_count++;
    }
    p->position = pts;
    pthread_mutex_unlock(&p->mu);
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
    p->last_io_time = now_sec();
    ret = avformat_open_input(&fmt, p->url, NULL, NULL);
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
    }
    pthread_mutex_lock(&p->mu);
    p->duration = fmt->duration > 0 ? (double)fmt->duration / AV_TIME_BASE : 0.0;
    pthread_mutex_unlock(&p->mu);

    pkt = av_packet_alloc();
    frm = av_frame_alloc();
    sws = sws_getContext(p->src_w, p->src_h, dec->pix_fmt,
                         p->out_w, p->out_h, AV_PIX_FMT_BGRA,
                         SWS_FAST_BILINEAR, NULL, NULL, NULL);
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
                    push_frame(p, sws, frm, pts);
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
                    if (d > 0.02) {
                        p->skip_until = p->position + d;
                        t0 -= d;
                    } else if (d < -0.02) {
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
                push_frame(p, sws, frm, pts);
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
    pthread_mutex_lock(&p->mu);
    for (int i = 0; i < 3; i++) {
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
    pthread_mutex_lock(&g.mu);
    if (g.thread_started) {
        pthread_mutex_unlock(&g.mu);
        return JS_ThrowTypeError(ctx, "cannot setBuffer while running");
    }
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
    for (int i = 0; i < 3; i++) {
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
        int tail = (g.ring_head - g.ring_count + 3) % 3;
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

static int js_module_init(JSContext *ctx, JSModuleDef *m) {
    JSValue obj = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, obj, "setBuffer", JS_NewCFunction2(ctx, js_setBuffer, "setBuffer", 3, JS_CFUNC_generic, 0));
    JS_SetPropertyStr(ctx, obj, "start", JS_NewCFunction2(ctx, js_start, "start", 1, JS_CFUNC_generic, 0));
    JS_SetPropertyStr(ctx, obj, "readFrame", JS_NewCFunction2(ctx, js_readFrame, "readFrame", 0, JS_CFUNC_generic, 0));
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
    registerCModuleLoader("rgavideo", rgav_loader);
}

__attribute__((visibility("default"))) int jsapi_check_unload(void) {
    return g.thread_started ? 0 : 1;
}
