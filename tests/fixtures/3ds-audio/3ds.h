/* The libctru surface platforms/3ds/audio.c uses, as libctru 2.7.0 declares
 * it (include/3ds/types.h, result.h, ndsp/ndsp.h, ndsp/channel.h,
 * services/dsp.h, allocator/linear.h). harness.c implements the functions
 * with a fake DSP. */
#ifndef POCKETJS_AUDIO_TEST_3DS_H
#define POCKETJS_AUDIO_TEST_3DS_H
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef uint8_t u8;
typedef uint16_t u16;
typedef uint32_t u32;
typedef int8_t s8;
typedef int16_t s16;
typedef int32_t s32;
typedef s32 Result;

#define R_SUCCEEDED(res) ((res) >= 0)
#define R_FAILED(res) ((res) < 0)
#define R_LEVEL(res) (((res) >> 27) & 0x1F)
#define R_SUMMARY(res) (((res) >> 21) & 0x3F)
#define R_MODULE(res) (((res) >> 10) & 0xFF)
#define R_DESCRIPTION(res) ((res) & 0x3FF)
enum { RL_PERMANENT = 27 };
enum { RS_NOTFOUND = 4 };
enum { RM_DSP = 41 };
enum { RD_NOT_FOUND = 0x3FF - 5 };

typedef enum { NDSP_OUTPUT_MONO = 0, NDSP_OUTPUT_STEREO = 1, NDSP_OUTPUT_SURROUND = 2 } ndspOutputMode;
typedef struct { u16 index; s16 history0; s16 history1; } ndspAdpcmData;
enum { NDSP_WBUF_FREE = 0, NDSP_WBUF_QUEUED = 1, NDSP_WBUF_PLAYING = 2, NDSP_WBUF_DONE = 3 };
typedef struct tag_ndspWaveBuf ndspWaveBuf;
struct tag_ndspWaveBuf {
  union {
    s8 *data_pcm8;
    s16 *data_pcm16;
    u8 *data_adpcm;
    const void *data_vaddr;
  };
  u32 nsamples;
  ndspAdpcmData *adpcm_data;
  u32 offset;
  bool looping;
  u8 status;
  u16 sequence_id;
  ndspWaveBuf *next;
};

enum { NDSP_ENCODING_PCM8 = 0, NDSP_ENCODING_PCM16, NDSP_ENCODING_ADPCM };
#define NDSP_CHANNELS(n) ((u32)(n) & 3)
#define NDSP_ENCODING(n) (((u32)(n) & 3) << 2)
enum {
  NDSP_FORMAT_MONO_PCM16 = NDSP_CHANNELS(1) | NDSP_ENCODING(NDSP_ENCODING_PCM16),
  NDSP_FORMAT_STEREO_PCM16 = NDSP_CHANNELS(2) | NDSP_ENCODING(NDSP_ENCODING_PCM16),
  NDSP_FORMAT_PCM16 = NDSP_FORMAT_MONO_PCM16,
};
typedef enum { NDSP_INTERP_POLYPHASE = 0, NDSP_INTERP_LINEAR = 1, NDSP_INTERP_NONE = 2 } ndspInterpType;

Result ndspInit(void);
void ndspExit(void);
void ndspSetOutputMode(ndspOutputMode mode);
void ndspChnReset(int id);
void ndspChnSetPaused(int id, bool paused);
void ndspChnSetFormat(int id, u16 format);
void ndspChnSetInterp(int id, ndspInterpType type);
void ndspChnSetRate(int id, float rate);
void ndspChnSetMix(int id, float mix[12]);
void ndspChnWaveBufClear(int id);
void ndspChnWaveBufAdd(int id, ndspWaveBuf *buf);
Result DSP_FlushDataCache(const void *address, u32 size);
void *linearMemAlign(size_t size, size_t alignment);
void linearFree(void *mem);
#endif
