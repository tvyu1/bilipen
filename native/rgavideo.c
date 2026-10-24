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
    uint8_t *back;
    size_t back_size;

    pthread_t th;
    pthread_mutex_t mu;
    int thread_started;
    volatile int stop_flag;
    volatile int have_frame;
    volatile int finished;

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

static void set_err(RgaPlayer *p, const char *fmt, int code) {
    snprintf(p->err, sizeof(p->err), fmt, code);
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
    ret = avformat_open_input(&fmt, p->url, NULL, NULL);
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
    p->duration = fmt->duration > 0 ? (double)fmt->duration / AV_TIME_BASE : 0.0;

    pkt = av_packet_alloc();
    frm = av_frame_alloc();
    sws = sws_getContext(p->src_w, p->src_h, dec->pix_fmt,
                         p->out_w, p->out_h, AV_PIX_FMT_RGBA,
                         SWS_BILINEAR, NULL, NULL, NULL);
    if (!pkt || !frm || !sws) {
        set_err(p, "alloc=%d", -3);
        goto done;
    }

    {
        AVRational tb = fmt->streams[vst]->time_base;
        int64_t start_ts = AV_NOPTS_VALUE;
        double t0 = now_sec();
        while (!p->stop_flag) {
            ret = av_read_frame(fmt, pkt);
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
                {
                    double target = t0 + pts;
                    double now = now_sec();
                    if (target > now + 0.001) {
                        double d = target - now;
                        struct timespec sl;
                        sl.tv_sec = (time_t)d;
                        sl.tv_nsec = (long)((d - (double)sl.tv_sec) * 1e9);
                        nanosleep(&sl, NULL);
                    }
                }
                /* 消费者还没取走上一帧时等一等（最多 ~40ms，超时则丢帧保节奏） */
                {
                    int wait_ms = 0;
                    while (p->have_frame && !p->stop_flag && wait_ms < 40) {
                        usleep(2000);
                        wait_ms += 2;
                    }
                }
                if (p->stop_flag) {
                    av_frame_unref(frm);
                    break;
                }
                pthread_mutex_lock(&p->mu);
                {
                    uint8_t *dst[4] = { p->back, NULL, NULL, NULL };
                    int dst_stride[4] = { p->out_w * 4, 0, 0, 0 };
                    sws_scale(sws, (const uint8_t *const *)frm->data, frm->linesize,
                              0, p->src_h, dst, dst_stride);
                    p->have_frame = 1;
                    p->position = pts;
                }
                pthread_mutex_unlock(&p->mu);
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
    if (p->thread_started) {
        pthread_join(p->th, NULL);
        p->thread_started = 0;
    }
    pthread_mutex_lock(&p->mu);
    free(p->back);
    p->back = NULL;
    p->back_size = 0;
    p->have_frame = 0;
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
    g.back_size = (size_t)g.out_w * (size_t)g.out_h * 4;
    g.back = (uint8_t *)malloc(g.back_size);
    if (!g.back) {
        return JS_ThrowTypeError(ctx, "oom back");
    }
    g.stop_flag = 0;
    g.have_frame = 0;
    g.finished = 0;
    if (pthread_create(&g.th, NULL, decode_main, &g) != 0) {
        return JS_ThrowTypeError(ctx, "pthread_create failed");
    }
    g.thread_started = 1;
    return JS_NewInt32(ctx, 1);
}

static JSValue js_readFrame(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    int got = 0;
    pthread_mutex_lock(&g.mu);
    if (g.have_frame && g.jsbuf && g.back && g.jsbuf_size >= g.back_size) {
        memcpy(g.jsbuf, g.back, g.back_size);
        g.have_frame = 0;
        got = 1;
    }
    pthread_mutex_unlock(&g.mu);
    return JS_NewInt32(ctx, got);
}

static JSValue js_stop(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    player_stop(&g);
    return JS_NewInt32(ctx, 1);
}

static JSValue js_info(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    JSValue obj = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, obj, "width", JS_NewInt32(ctx, g.src_w));
    JS_SetPropertyStr(ctx, obj, "height", JS_NewInt32(ctx, g.src_h));
    JS_SetPropertyStr(ctx, obj, "duration", JS_NewFloat64(ctx, g.duration));
    JS_SetPropertyStr(ctx, obj, "position", JS_NewFloat64(ctx, g.position));
    JS_SetPropertyStr(ctx, obj, "finished", JS_NewInt32(ctx, g.finished));
    return obj;
}

static JSValue js_error(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    return JS_NewStringLen(ctx, g.err, strlen(g.err));
}

static JSValue js_duration(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    return JS_NewFloat64(ctx, g.duration);
}

static JSValue js_position(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    return JS_NewFloat64(ctx, g.position);
}

static int js_module_init(JSContext *ctx, JSModuleDef *m) {
    JSValue obj = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, obj, "setBuffer", JS_NewCFunction2(ctx, js_setBuffer, "setBuffer", 3, JS_CFUNC_generic, 0));
    JS_SetPropertyStr(ctx, obj, "start", JS_NewCFunction2(ctx, js_start, "start", 1, JS_CFUNC_generic, 0));
    JS_SetPropertyStr(ctx, obj, "readFrame", JS_NewCFunction2(ctx, js_readFrame, "readFrame", 0, JS_CFUNC_generic, 0));
    JS_SetPropertyStr(ctx, obj, "stop", JS_NewCFunction2(ctx, js_stop, "stop", 0, JS_CFUNC_generic, 0));
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
