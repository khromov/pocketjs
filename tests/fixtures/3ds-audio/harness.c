/* platforms/3ds/audio.c against a fake NDSP (tests/3ds-audio.test.ts).
 *
 * The fake follows libctru 2.7.0's channel rules: ndspChnWaveBufAdd queues a
 * buffer, ndspChnWaveBufClear and ndspChnReset mark every queued buffer DONE,
 * a paused channel consumes nothing, and buffers finish in queue order. The
 * DSP reads a SHADOW of each linear allocation that only DSP_FlushDataCache
 * updates, so a frame copied but never flushed reaches the output as 0xEE
 * bytes and the byte comparisons fail. Every buffer added is checked against
 * its ring: inside it, frame-aligned, at most WAVEBUF_FRAMES long, starting
 * on the ALIGN_FRAMES grain, and flushed.
 *
 * Modes: suite (default), transcript, nofirmware, initfail, nomemory. */
#include <math.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "3ds.h"
#include "../../../platforms/3ds/audio.h"

#if !defined(SPEC_RING_FRAMES) || !defined(SPEC_MAX_STREAMS) || !defined(SPEC_MAX_CHANNELS) || !defined(SPEC_RATES)
#error "tests/3ds-audio.test.ts passes the contracts/spec/audio.ts constants"
#endif
_Static_assert(POCKET_3DS_AUDIO_RING_FRAMES == SPEC_RING_FRAMES, "AUDIO_RING_FRAMES");
_Static_assert(POCKET_3DS_AUDIO_MAX_STREAMS == SPEC_MAX_STREAMS, "AUDIO_MAX_STREAMS");
_Static_assert(POCKET_3DS_AUDIO_MAX_CHANNELS == SPEC_MAX_CHANNELS, "AUDIO_MAX_CHANNELS");
static const uint32_t spec_rates[] = {SPEC_RATES};

#define RING POCKET_3DS_AUDIO_RING_FRAMES
#define FIRST POCKET_3DS_AUDIO_FIRST_CHANNEL
#define ALIGN POCKET_3DS_AUDIO_ALIGN_FRAMES
#define CHECK(cond)                                                                    \
  do {                                                                                 \
    if (!(cond)) {                                                                     \
      fprintf(stderr, "%s:%d: CHECK failed: %s\n", __FILE__, __LINE__, #cond);         \
      abort();                                                                         \
    }                                                                                  \
  } while (0)

// ---------------------------------------------------------------------------
// linear memory with a DSP-side shadow
// ---------------------------------------------------------------------------

typedef struct {
  uint8_t *real, *shadow;
  size_t size;
  bool live;
} Allocation;
static Allocation allocations[16];
static unsigned allocation_calls, flushes;
static unsigned linear_budget = 1000;

void *linearMemAlign(size_t size, size_t alignment) {
  CHECK(alignment >= 0x80 && (alignment & (alignment - 1)) == 0);
  allocation_calls++;
  if (linear_budget == 0) return NULL;
  linear_budget--;
  for (unsigned i = 0; i < 16; i++) {
    if (allocations[i].live) continue;
    size_t rounded = (size + alignment - 1) / alignment * alignment;
    allocations[i].real = aligned_alloc(alignment, rounded);
    allocations[i].shadow = malloc(size);
    CHECK(allocations[i].real != NULL && allocations[i].shadow != NULL);
    memset(allocations[i].real, 0x5A, size);
    memset(allocations[i].shadow, 0xEE, size);
    allocations[i].size = size;
    allocations[i].live = true;
    return allocations[i].real;
  }
  CHECK(!"allocation table full");
  return NULL;
}

void linearFree(void *mem) {
  for (unsigned i = 0; i < 16; i++) {
    if (!allocations[i].live || allocations[i].real != mem) continue;
    free(allocations[i].real);
    free(allocations[i].shadow);
    allocations[i].live = false;
    return;
  }
  CHECK(!"linearFree of memory linearMemAlign did not return");
}

static unsigned live_allocations(void) {
  unsigned n = 0;
  for (unsigned i = 0; i < 16; i++) n += allocations[i].live ? 1u : 0u;
  return n;
}

static Allocation *allocation_of(const void *address, size_t bytes) {
  const uint8_t *p = address;
  for (unsigned i = 0; i < 16; i++) {
    Allocation *a = &allocations[i];
    if (a->live && p >= a->real && p <= a->real + a->size && bytes <= (size_t)(a->real + a->size - p)) return a;
  }
  CHECK(!"range outside every linear allocation");
  return NULL;
}

Result DSP_FlushDataCache(const void *address, u32 size) {
  Allocation *a = allocation_of(address, size);
  size_t offset = (size_t)((const uint8_t *)address - a->real);
  memcpy(a->shadow + offset, address, size);
  flushes++;
  return 0;
}

// ---------------------------------------------------------------------------
// the fake DSP
// ---------------------------------------------------------------------------

typedef struct {
  bool paused;
  u16 format;
  float rate;
  int interp;
  float mix[12];
  ndspWaveBuf *queue[POCKET_3DS_AUDIO_WAVEBUFS];
  unsigned count;
  u32 played; /* frames of queue[0] already consumed */
  unsigned adds, clears, resets, ring_end_adds, max_count;
  unsigned idle_adds; /* adds to a channel that held no buffer */
  uint8_t *out; /* every consumed byte, in order */
  size_t out_len, out_cap;
} FakeChannel;
static FakeChannel dsp[24];
static uint32_t touched;
static bool strict_alignment = true;
static Result init_result;
static int refs, inits, exits;
static ndspOutputMode output_mode = NDSP_OUTPUT_MONO;

static FakeChannel *touch(int id) {
  CHECK(id >= 0 && id < 24);
  touched |= 1u << id;
  return &dsp[id];
}

Result ndspInit(void) {
  inits++;
  if (R_SUCCEEDED(init_result)) refs++;
  return init_result;
}

void ndspExit(void) {
  exits++;
  CHECK(refs > 0);
  refs--;
}

void ndspSetOutputMode(ndspOutputMode mode) { output_mode = mode; }

static void clear_queue(FakeChannel *c) {
  for (unsigned i = 0; i < c->count; i++) c->queue[i]->status = NDSP_WBUF_DONE;
  c->count = 0;
  c->played = 0;
}

void ndspChnReset(int id) {
  FakeChannel *c = touch(id);
  clear_queue(c);
  c->paused = false;
  c->format = NDSP_FORMAT_PCM16;
  c->rate = 1.0f;
  c->interp = 0;
  memset(c->mix, 0, sizeof c->mix);
  c->mix[0] = c->mix[1] = 1.0f;
  c->resets++;
}

void ndspChnWaveBufClear(int id) {
  FakeChannel *c = touch(id);
  clear_queue(c);
  c->clears++;
}

void ndspChnSetPaused(int id, bool paused) { touch(id)->paused = paused; }
void ndspChnSetFormat(int id, u16 format) { touch(id)->format = format; }
void ndspChnSetInterp(int id, ndspInterpType type) { touch(id)->interp = (int)type; }
void ndspChnSetRate(int id, float rate) { touch(id)->rate = rate; }
void ndspChnSetMix(int id, float mix[12]) { memcpy(touch(id)->mix, mix, sizeof dsp[id].mix); }

void ndspChnWaveBufAdd(int id, ndspWaveBuf *buf) {
  FakeChannel *c = touch(id);
  CHECK(id >= (int)FIRST && id < (int)(FIRST + POCKET_3DS_AUDIO_MAX_STREAMS));
  CHECK(buf->nsamples > 0 && buf->nsamples <= POCKET_3DS_AUDIO_WAVEBUF_FRAMES);
  CHECK(buf->status == NDSP_WBUF_FREE || buf->status == NDSP_WBUF_DONE);
  CHECK(!buf->looping && buf->adpcm_data == NULL);
  unsigned channels = c->format & 3u;
  CHECK(channels == 1 || channels == 2);
  size_t frame_bytes = 2u * channels, bytes = buf->nsamples * frame_bytes;
  Allocation *ring = allocation_of(buf->data_vaddr, bytes);
  size_t offset = (size_t)((const uint8_t *)buf->data_vaddr - ring->real);
  /* Inside the stream's ring, which never wraps inside one buffer. */
  CHECK(offset % frame_bytes == 0);
  CHECK(offset + bytes <= (size_t)RING * frame_bytes);
  if (offset + bytes == (size_t)RING * frame_bytes) c->ring_end_adds++;
  if (strict_alignment) CHECK(offset % (ALIGN * frame_bytes) == 0);
  /* Written back from the cache before NDSP sees it. */
  CHECK(memcmp(ring->real + offset, ring->shadow + offset, bytes) == 0);
  CHECK(c->count < POCKET_3DS_AUDIO_WAVEBUFS);
  if (c->count == 0) c->idle_adds++;
  buf->status = NDSP_WBUF_QUEUED;
  buf->next = NULL;
  c->queue[c->count++] = buf;
  if (c->count > c->max_count) c->max_count = c->count;
  c->adds++;
}

static void output(FakeChannel *c, const uint8_t *bytes, size_t length) {
  if (c->out_len + length > c->out_cap) {
    c->out_cap = (c->out_len + length) * 2 + 64;
    c->out = realloc(c->out, c->out_cap);
    CHECK(c->out != NULL);
  }
  memcpy(c->out + c->out_len, bytes, length);
  c->out_len += length;
}

/* The DSP plays `frames` frames of channel `id` (fewer when it runs dry). */
static u32 consume(int id, u32 frames) {
  FakeChannel *c = &dsp[id];
  u32 total = 0;
  while (frames > 0 && c->count > 0 && !c->paused) {
    ndspWaveBuf *wave = c->queue[0];
    wave->status = NDSP_WBUF_PLAYING;
    size_t frame_bytes = 2u * (c->format & 3u);
    u32 take = wave->nsamples - c->played;
    if (take > frames) take = frames;
    Allocation *ring = allocation_of(wave->data_vaddr, wave->nsamples * frame_bytes);
    size_t offset = (size_t)((const uint8_t *)wave->data_vaddr - ring->real) + c->played * frame_bytes;
    output(c, ring->shadow + offset, take * frame_bytes);
    c->played += take;
    frames -= take;
    total += take;
    if (c->played == wave->nsamples) {
      wave->status = NDSP_WBUF_DONE;
      memmove(c->queue, c->queue + 1, (c->count - 1) * sizeof c->queue[0]);
      c->count--;
      c->played = 0;
    }
  }
  return total;
}

static void forget_output(void) {
  for (unsigned i = 0; i < 24; i++) dsp[i].out_len = 0;
}

// ---------------------------------------------------------------------------
// guest-side helpers
// ---------------------------------------------------------------------------

typedef struct {
  int32_t handle;
  int channel;
  uint32_t channels;
  uint8_t *sent; /* every accepted byte, in order */
  size_t sent_len, sent_cap;
} Track;

static uint32_t noise_state = 0x2545f491u;
static uint8_t noise_byte(void) {
  uint32_t x = noise_state;
  x ^= x << 13;
  x ^= x >> 17;
  x ^= x << 5;
  noise_state = x;
  return (uint8_t)(x >> 7);
}

static Track open_track(uint32_t rate, uint32_t channels) {
  Track t = {0};
  t.handle = pocket_3ds_audio_create_stream(rate, channels);
  CHECK(t.handle >= 0);
  t.channel = (int)(FIRST + ((unsigned)t.handle & 7u));
  t.channels = channels;
  return t;
}

/* Write `frames` frames plus `extra` stray bytes from a buffer starting at an
 * odd address; record what the module accepted. */
static int32_t send(Track *t, uint32_t frames, size_t extra) {
  size_t frame_bytes = 2u * t->channels, length = frames * frame_bytes + extra;
  uint8_t *storage = malloc(length + 1);
  CHECK(storage != NULL);
  uint8_t *bytes = storage + 1;
  for (size_t i = 0; i < length; i++) bytes[i] = noise_byte();
  int32_t accepted = pocket_3ds_audio_write_pcm(t->handle, bytes, length);
  CHECK(accepted >= 0 && (uint32_t)accepted <= frames);
  size_t taken = (size_t)accepted * frame_bytes;
  if (t->sent_len + taken > t->sent_cap) {
    t->sent_cap = (t->sent_len + taken) * 2 + 64;
    t->sent = realloc(t->sent, t->sent_cap);
    CHECK(t->sent != NULL);
  }
  memcpy(t->sent + t->sent_len, bytes, taken);
  t->sent_len += taken;
  free(storage);
  return accepted;
}

static void played_all(const Track *t) {
  if (dsp[t->channel].out_len != t->sent_len)
    fprintf(stderr, "channel %d played %zu bytes of %zu sent\n", t->channel, dsp[t->channel].out_len, t->sent_len);
  CHECK(dsp[t->channel].out_len == t->sent_len);
  CHECK(memcmp(dsp[t->channel].out, t->sent, t->sent_len) == 0);
}

static void close_track(Track *t) {
  pocket_3ds_audio_destroy_stream(t->handle);
  free(t->sent);
  memset(t, 0, sizeof *t);
}

static char event[POCKET_3DS_AUDIO_EVENT_BYTES];
static const char *next_event(void) {
  return pocket_3ds_audio_poll(event, sizeof event) ? event : NULL;
}

static void expect(const char *format, ...) {
  char wanted[POCKET_3DS_AUDIO_EVENT_BYTES];
  va_list args;
  va_start(args, format);
  vsnprintf(wanted, sizeof wanted, format, args);
  va_end(args);
  const char *got = next_event();
  if (got == NULL || strcmp(got, wanted) != 0) {
    fprintf(stderr, "expected event %s, got %s\n", wanted, got ? got : "(none)");
    abort();
  }
}

static void expect_none(void) {
  const char *got = next_event();
  if (got != NULL) {
    fprintf(stderr, "expected no event, got %s\n", got);
    abort();
  }
}

static void drain(void) {
  while (next_event() != NULL) {}
}

static void rebind(void) {
  char error[160] = {0};
  CHECK(pocket_3ds_audio_bind(error, sizeof error));
  forget_output();
}

#define UNDERRUN "{\"t\":\"underrun\",\"h\":%d}"
#define ENDED "{\"t\":\"ended\",\"h\":%d}"
#define CREDIT "{\"t\":\"credit\",\"h\":%d,\"free\":%u}"

// ---------------------------------------------------------------------------
// suite
// ---------------------------------------------------------------------------

static void lifecycle(void) {
  char error[160] = {0};
  CHECK(!pocket_3ds_audio_ready() && !pocket_3ds_audio_bound());
  CHECK(!pocket_3ds_audio_bind(error, sizeof error));
  CHECK(strcmp(error, "audio: NDSP was not started") == 0);
  CHECK(pocket_3ds_audio_create_stream(44100, 2) == -1);
  pocket_3ds_audio_service();
  CHECK(!pocket_3ds_audio_poll(event, sizeof event));
  CHECK(touched == 0 && inits == 0 && allocation_calls == 0);

  CHECK(pocket_3ds_audio_start());
  CHECK(pocket_3ds_audio_start());
  CHECK(inits == 1 && refs == 1 && output_mode == NDSP_OUTPUT_STEREO && pocket_3ds_audio_ready());
  CHECK(pocket_3ds_audio_bind(error, sizeof error) && pocket_3ds_audio_bound());
  CHECK(live_allocations() == POCKET_3DS_AUDIO_MAX_STREAMS);
  for (unsigned i = 0; i < 16; i++) {
    if (!allocations[i].live) continue;
    CHECK(allocations[i].size == (size_t)RING * 2 * sizeof(int16_t));
    CHECK((uintptr_t)allocations[i].real % 0x80 == 0);
  }
  /* The rings outlive a guest. */
  rebind();
  CHECK(allocation_calls == POCKET_3DS_AUDIO_MAX_STREAMS && live_allocations() == POCKET_3DS_AUDIO_MAX_STREAMS);
  char text[96];
  pocket_3ds_audio_describe(text, sizeof text);
  CHECK(strcmp(text, "audio: dsp ok, 0/4 streams, 0 underruns") == 0);
  printf("ok lifecycle\n");
}

static void rates_and_format(void) {
  rebind();
  for (unsigned r = 0; r < sizeof spec_rates / sizeof spec_rates[0]; r++) {
    for (uint32_t channels = 1; channels <= SPEC_MAX_CHANNELS; channels++) {
      int32_t h = pocket_3ds_audio_create_stream(spec_rates[r], channels);
      CHECK(h >= 0);
      int c = (int)(FIRST + ((unsigned)h & 7u));
      CHECK(dsp[c].rate == (float)spec_rates[r]);
      CHECK(dsp[c].format == (channels == 2 ? NDSP_FORMAT_STEREO_PCM16 : NDSP_FORMAT_MONO_PCM16));
      CHECK(dsp[c].interp == NDSP_INTERP_LINEAR && dsp[c].paused);
      CHECK(dsp[c].mix[0] == 1.0f && dsp[c].mix[1] == 1.0f && dsp[c].mix[2] == 0.0f && dsp[c].mix[11] == 0.0f);
      pocket_3ds_audio_destroy_stream(h);
    }
  }
  const uint32_t refused_rates[] = {48000, 32000, 32728, 8000, 0, 44101, 22051, 11024, 96000, 0xFFFFFFFFu};
  for (unsigned i = 0; i < sizeof refused_rates / sizeof refused_rates[0]; i++)
    CHECK(pocket_3ds_audio_create_stream(refused_rates[i], 1) == -1);
  const uint32_t refused_channels[] = {0, 3, 8, 0xFFFFFFFFu};
  for (unsigned i = 0; i < sizeof refused_channels / sizeof refused_channels[0]; i++)
    CHECK(pocket_3ds_audio_create_stream(22050, refused_channels[i]) == -1);
  printf("ok rates and format\n");
}

static void handles(void) {
  rebind();
  int32_t h[POCKET_3DS_AUDIO_MAX_STREAMS];
  for (unsigned i = 0; i < POCKET_3DS_AUDIO_MAX_STREAMS; i++) {
    h[i] = pocket_3ds_audio_create_stream(22050, 1);
    CHECK(h[i] > 0 && ((unsigned)h[i] & 7u) == i && (h[i] >> 3) >= 1);
  }
  CHECK(pocket_3ds_audio_create_stream(22050, 1) == -1);
  unsigned clears = dsp[FIRST + 1].clears;
  pocket_3ds_audio_destroy_stream(h[1]);
  CHECK(dsp[FIRST + 1].clears == clears + 1 && dsp[FIRST + 1].paused);
  int32_t again = pocket_3ds_audio_create_stream(11025, 1);
  CHECK(((unsigned)again & 7u) == 1 && (again >> 3) == (h[1] >> 3) + 1);
  /* The stale handle names nothing: no writes, no state, no events. */
  uint8_t pcm[64] = {0};
  CHECK(pocket_3ds_audio_write_pcm(h[1], pcm, sizeof pcm) == 0);
  pocket_3ds_audio_play(h[1]);
  CHECK(dsp[FIRST + 1].paused);
  pocket_3ds_audio_set_volume(h[1], 0.25);
  CHECK(dsp[FIRST + 1].mix[0] == 1.0f);
  pocket_3ds_audio_end_stream(h[1]);
  pocket_3ds_audio_stop(h[1]);
  pocket_3ds_audio_pause(h[1]);
  pocket_3ds_audio_destroy_stream(h[1]);
  CHECK(pocket_3ds_audio_write_pcm(again, pcm, sizeof pcm) == 32);
  const int32_t bogus[] = {-1, -8, (1 << 3) | 4, (1 << 3) | 5, (1 << 3) | 7, (h[0] >> 3 << 3) + 8, INT32_MIN};
  for (unsigned i = 0; i < sizeof bogus / sizeof bogus[0]; i++)
    CHECK(pocket_3ds_audio_write_pcm(bogus[i], pcm, sizeof pcm) == 0);
  pocket_3ds_audio_service();
  expect_none();
  printf("ok handles and refusals\n");
}

static void partial_writes(void) {
  rebind();
  Track mono = open_track(22050, 1);
  CHECK(send(&mono, 20000, 0) == (int32_t)RING);
  CHECK(send(&mono, 10, 0) == 0);
  expect_none(); /* the guest's mirror is 0 and so is the ring */
  Track stereo = open_track(44100, 2);
  CHECK(send(&stereo, 10, 3) == 10); /* 43 bytes: 10 frames, the rest ignored */
  uint8_t two[2] = {1, 2};
  CHECK(pocket_3ds_audio_write_pcm(stereo.handle, two, 2) == 0);
  CHECK(pocket_3ds_audio_write_pcm(stereo.handle, two, 1) == 0);
  CHECK(pocket_3ds_audio_write_pcm(stereo.handle, NULL, 0) == 0);
  Track odd = open_track(11025, 1);
  CHECK(send(&odd, 10, 1) == 10); /* 21 bytes: 10 frames */
  /* Every accepted byte plays, in order, from the odd-addressed sources. */
  pocket_3ds_audio_play(mono.handle);
  pocket_3ds_audio_end_stream(mono.handle);
  pocket_3ds_audio_play(stereo.handle);
  pocket_3ds_audio_end_stream(stereo.handle);
  pocket_3ds_audio_play(odd.handle);
  pocket_3ds_audio_end_stream(odd.handle);
  CHECK(consume(mono.channel, RING) == RING);
  CHECK(consume(stereo.channel, 100) == 10);
  CHECK(consume(odd.channel, 100) == 10);
  pocket_3ds_audio_service();
  played_all(&mono);
  played_all(&stereo);
  played_all(&odd);
  expect(ENDED, mono.handle);
  expect(CREDIT, mono.handle, RING);
  expect(ENDED, stereo.handle);
  expect(CREDIT, stereo.handle, RING);
  expect(ENDED, odd.handle);
  expect(CREDIT, odd.handle, RING);
  expect_none();
  close_track(&mono);
  close_track(&stereo);
  close_track(&odd);
  printf("ok partial writes\n");
}

/* streams.rs's regression: the guest writes k, the DSP plays k before the
 * guest polls. The credit must still arrive, once, at the full ring. */
static void credit_after_full_drain(void) {
  rebind();
  Track t = open_track(22050, 1);
  CHECK(send(&t, 1024, 0) == 1024);
  pocket_3ds_audio_play(t.handle);
  expect_none();
  CHECK(consume(t.channel, 1024) == 1024);
  pocket_3ds_audio_service();
  expect(UNDERRUN, t.handle);
  expect(CREDIT, t.handle, RING);
  expect_none();
  pocket_3ds_audio_service();
  expect_none();
  /* Credit follows the frames the DSP finished, a buffer at a time. */
  CHECK(send(&t, 4096, 0) == 4096);
  expect_none();
  CHECK(consume(t.channel, 1500) == 1500);
  pocket_3ds_audio_service();
  expect(CREDIT, t.handle, RING - 4096 + 1024);
  expect_none();
  close_track(&t);
  printf("ok credit\n");
}

static void event_order(void) {
  rebind();
  Track a = open_track(22050, 1), b = open_track(44100, 2), c = open_track(11025, 1);
  CHECK(send(&a, 1024, 0) == 1024 && send(&b, 2048, 0) == 2048 && send(&c, 512, 0) == 512);
  pocket_3ds_audio_play(a.handle);
  pocket_3ds_audio_play(b.handle);
  pocket_3ds_audio_play(c.handle);
  pocket_3ds_audio_end_stream(a.handle);
  CHECK(consume(a.channel, 1024) == 1024);
  CHECK(consume(b.channel, 1024) == 1024);
  CHECK(consume(c.channel, 512) == 512);
  pocket_3ds_audio_service();
  /* Slot order; within a slot ended, then underrun, then credit; one a call. */
  expect(ENDED, a.handle);
  expect(CREDIT, a.handle, RING);
  expect(CREDIT, b.handle, RING - 1024);
  expect(UNDERRUN, c.handle);
  expect(CREDIT, c.handle, RING);
  expect_none();
  expect_none();
  /* A too-small buffer leaves the event pending. */
  CHECK(consume(b.channel, 1024) == 1024);
  pocket_3ds_audio_service();
  char tiny[8];
  CHECK(!pocket_3ds_audio_poll(tiny, sizeof tiny));
  expect(UNDERRUN, b.handle);
  expect(CREDIT, b.handle, RING);
  expect_none();
  /* Unpolled edges of one stream: ended before underrun before credit. */
  CHECK(send(&c, 512, 0) == 512);
  CHECK(consume(c.channel, 512) == 512);
  pocket_3ds_audio_service();
  pocket_3ds_audio_end_stream(c.handle);
  pocket_3ds_audio_service();
  expect(ENDED, c.handle);
  expect(UNDERRUN, c.handle);
  expect(CREDIT, c.handle, RING);
  expect_none();
  close_track(&a);
  close_track(&b);
  close_track(&c);
  printf("ok event order\n");
}

static void underrun_edges(void) {
  rebind();
  Track t = open_track(22050, 1);
  CHECK(send(&t, 2048, 0) == 2048);
  pocket_3ds_audio_play(t.handle);
  CHECK(consume(t.channel, 4096) == 2048);
  pocket_3ds_audio_service();
  expect(UNDERRUN, t.handle);
  expect(CREDIT, t.handle, RING);
  expect_none();
  /* One event per starved episode. */
  pocket_3ds_audio_service();
  CHECK(consume(t.channel, 100) == 0);
  pocket_3ds_audio_service();
  expect_none();
  /* Data reaching the DSP ends the episode. */
  CHECK(send(&t, 1024, 0) == 1024);
  expect_none();
  CHECK(consume(t.channel, 1024) == 1024);
  pocket_3ds_audio_service();
  expect(UNDERRUN, t.handle);
  expect(CREDIT, t.handle, RING);
  expect_none();
  /* Fewer frames than the grain go to the idle DSP and end the episode; the
   * PSP mixer plays them too. */
  CHECK(send(&t, 10, 0) == 10);
  pocket_3ds_audio_service();
  expect_none();
  CHECK(consume(t.channel, 100) == 10);
  pocket_3ds_audio_service();
  expect(UNDERRUN, t.handle);
  expect(CREDIT, t.handle, RING);
  expect_none();
  /* Playing an empty stream underruns once, as on the PSP. */
  Track empty = open_track(44100, 1);
  pocket_3ds_audio_play(empty.handle);
  pocket_3ds_audio_service();
  pocket_3ds_audio_service();
  expect(UNDERRUN, empty.handle);
  expect_none();
  /* A paused stream never underruns. */
  Track paused = open_track(44100, 2);
  CHECK(send(&paused, 1024, 0) == 1024);
  pocket_3ds_audio_play(paused.handle);
  pocket_3ds_audio_pause(paused.handle);
  pocket_3ds_audio_service();
  expect_none();
  pocket_3ds_audio_play(paused.handle);
  CHECK(consume(paused.channel, 1024) == 1024);
  pocket_3ds_audio_pause(paused.handle);
  pocket_3ds_audio_service();
  expect(CREDIT, paused.handle, RING);
  expect_none();
  played_all(&paused);
  /* play, then write, in one guest turn: no underrun, as on the sim. */
  Track late = open_track(11025, 2);
  pocket_3ds_audio_play(late.handle);
  CHECK(send(&late, 1024, 0) == 1024);
  pocket_3ds_audio_service();
  expect_none();
  close_track(&late);
  close_track(&t);
  close_track(&empty);
  close_track(&paused);
  printf("ok underrun\n");
}

static void ended_edges(void) {
  rebind();
  Track t = open_track(22050, 1);
  CHECK(send(&t, 1500, 0) == 1500);
  pocket_3ds_audio_play(t.handle);
  pocket_3ds_audio_end_stream(t.handle);
  CHECK(consume(t.channel, 4000) == 1500);
  pocket_3ds_audio_service();
  CHECK(dsp[t.channel].paused);
  expect(ENDED, t.handle);
  expect(CREDIT, t.handle, RING);
  expect_none();
  pocket_3ds_audio_service();
  expect_none();
  played_all(&t);
  /* An ended stream is paused: written frames wait for play, and the next
   * buffer starts on the grain again (the mock checks every start). */
  CHECK(send(&t, 1024, 0) == 1024);
  CHECK(consume(t.channel, 1024) == 0);
  pocket_3ds_audio_play(t.handle);
  pocket_3ds_audio_end_stream(t.handle);
  CHECK(consume(t.channel, 1024) == 1024);
  pocket_3ds_audio_service();
  expect(ENDED, t.handle);
  expect(CREDIT, t.handle, RING);
  played_all(&t);
  /* No ended while paused. */
  CHECK(send(&t, 1024, 0) == 1024);
  pocket_3ds_audio_play(t.handle);
  pocket_3ds_audio_pause(t.handle);
  pocket_3ds_audio_end_stream(t.handle);
  CHECK(consume(t.channel, 1024) == 0);
  pocket_3ds_audio_service();
  expect_none();
  pocket_3ds_audio_play(t.handle);
  CHECK(consume(t.channel, 1024) == 1024);
  pocket_3ds_audio_service();
  expect(ENDED, t.handle);
  expect(CREDIT, t.handle, RING);
  expect_none();
  /* endStream on a playing empty stream ends it, without an underrun. */
  pocket_3ds_audio_play(t.handle);
  pocket_3ds_audio_end_stream(t.handle);
  pocket_3ds_audio_service();
  expect(ENDED, t.handle);
  expect_none();
  played_all(&t);
  close_track(&t);
  printf("ok ended\n");
}

static void stop_and_pause(void) {
  rebind();
  Track t = open_track(44100, 2);
  CHECK(send(&t, 4096, 0) == 4096);
  pocket_3ds_audio_play(t.handle);
  CHECK(consume(t.channel, 1500) == 1500);
  pocket_3ds_audio_service();
  expect(CREDIT, t.handle, RING - 4096 + 1024);
  unsigned clears = dsp[t.channel].clears;
  pocket_3ds_audio_stop(t.handle);
  CHECK(dsp[t.channel].clears == clears + 1 && dsp[t.channel].count == 0 && dsp[t.channel].paused);
  pocket_3ds_audio_service();
  expect(CREDIT, t.handle, RING);
  expect_none();
  CHECK(memcmp(dsp[t.channel].out, t.sent, 1500 * 4) == 0);
  /* After stop the ring is empty: new frames play from their first byte. */
  forget_output();
  t.sent_len = 0;
  CHECK(send(&t, RING, 0) == (int32_t)RING);
  pocket_3ds_audio_play(t.handle);
  pocket_3ds_audio_end_stream(t.handle);
  CHECK(consume(t.channel, RING) == RING);
  played_all(&t);
  pocket_3ds_audio_service();
  drain();

  /* Pause holds the DSP's buffers; frames written while paused wait. */
  forget_output();
  t.sent_len = 0;
  pocket_3ds_audio_stop(t.handle);
  CHECK(send(&t, 2048, 0) == 2048);
  pocket_3ds_audio_play(t.handle);
  CHECK(consume(t.channel, 512) == 512);
  pocket_3ds_audio_pause(t.handle);
  CHECK(dsp[t.channel].paused && consume(t.channel, 512) == 0);
  unsigned adds = dsp[t.channel].adds;
  CHECK(send(&t, 1024, 0) == 1024);
  pocket_3ds_audio_service();
  CHECK(dsp[t.channel].adds == adds);
  expect_none();
  pocket_3ds_audio_play(t.handle);
  CHECK(dsp[t.channel].adds > adds && !dsp[t.channel].paused);
  CHECK(consume(t.channel, 4096) == 2560);
  played_all(&t);
  close_track(&t);
  printf("ok stop and pause\n");
}

static void ring_bounds(void) {
  rebind();
  Track t = open_track(44100, 2);
  unsigned ends = dsp[t.channel].ring_end_adds;
  CHECK(send(&t, 10000, 0) == 10000);
  pocket_3ds_audio_play(t.handle);
  CHECK(consume(t.channel, 6000) == 6000);
  pocket_3ds_audio_service();
  expect(CREDIT, t.handle, RING - 10000 + 5 * 1024);
  /* The idle DSP took all 10000 frames, so this copy starts 48 frames on, at
   * the grain. It wraps the ring end; the buffers stop at it. */
  CHECK(send(&t, 10000, 0) == 10000);
  /* Full: 20000 written, 48 skipped, 5 * 1024 played. */
  CHECK(send(&t, 5000, 0) == (int32_t)(RING - (20048 - 5 * 1024)));
  pocket_3ds_audio_end_stream(t.handle);
  for (int i = 0; i < 100 && consume(t.channel, 997) > 0; i++) pocket_3ds_audio_service();
  pocket_3ds_audio_service();
  CHECK(dsp[t.channel].ring_end_adds > ends);
  played_all(&t);
  drain();
  close_track(&t);
  printf("ok ring bounds\n");
}

static void coalescing(void) {
  rebind();
  Track t = open_track(44100, 1);
  FakeChannel *c = &dsp[t.channel];
  pocket_3ds_audio_play(t.handle);
  unsigned adds = c->adds;
  /* The idle DSP takes every frame. */
  CHECK(send(&t, 128, 0) == 128);
  CHECK(c->adds == adds + 1 && c->queue[0]->nsamples == 128);
  /* Under 2 * MIN_WAVEBUF_FRAMES with the DSP, every whole grain goes out. */
  CHECK(send(&t, 300, 0) == 300);
  CHECK(c->adds == adds + 2 && c->queue[1]->nsamples == 256);
  /* With 384 frames queued, 44 pending frames wait for a grain. */
  CHECK(send(&t, 10, 0) == 10);
  CHECK(c->adds == adds + 2);
  CHECK(send(&t, 200, 0) == 200);
  CHECK(c->adds == adds + 3 && c->queue[2]->nsamples == 192);
  /* With 576 frames queued, 62 pending frames wait for MIN_WAVEBUF_FRAMES. */
  CHECK(send(&t, 100, 0) == 100);
  CHECK(c->adds == adds + 3);
  CHECK(send(&t, 100, 0) == 100);
  CHECK(c->adds == adds + 4 && c->queue[3]->nsamples == 256);
  /* endStream releases the 6 held frames while the DSP still plays. */
  pocket_3ds_audio_end_stream(t.handle);
  CHECK(c->adds == adds + 5 && c->queue[4]->nsamples == 6);
  CHECK(consume(t.channel, 2000) == 838);
  played_all(&t);
  pocket_3ds_audio_service();
  drain();
  close_track(&t);
  printf("ok coalescing\n");
}

/* streams.rs's mixer plays every frame written: a tail shorter than the grain
 * plays without endStream once the DSP holds nothing, and the copy after it
 * starts on the grain again (the mock checks every start). */
static void sub_grain_tail(void) {
  rebind();
  Track t = open_track(11025, 1);
  CHECK(send(&t, 40, 0) == 40);
  pocket_3ds_audio_play(t.handle);
  CHECK(consume(t.channel, 1000) == 40);
  pocket_3ds_audio_service();
  expect(UNDERRUN, t.handle);
  expect(CREDIT, t.handle, RING);
  expect_none();
  played_all(&t);
  close_track(&t);
  forget_output();

  Track s = open_track(22050, 2);
  CHECK(send(&s, 1000, 0) == 1000);
  pocket_3ds_audio_play(s.handle);
  CHECK(dsp[s.channel].count == 1 && dsp[s.channel].queue[0]->nsamples == 1000);
  CHECK(consume(s.channel, 500) == 500);
  /* The next copy skips to frame 1024: the 24 frames between count as used
   * until the 1000-frame buffer retires. */
  CHECK(send(&s, 300, 0) == 300);
  CHECK(dsp[s.channel].count == 2 && dsp[s.channel].queue[1]->nsamples == 256);
  pocket_3ds_audio_service();
  expect(CREDIT, s.handle, RING - 1324);
  expect_none();
  CHECK(consume(s.channel, 2000) == 756);
  /* The DSP ran dry: the 44 held frames go out at the next service. */
  pocket_3ds_audio_service();
  expect(CREDIT, s.handle, RING - 44);
  expect_none();
  CHECK(consume(s.channel, 2000) == 44);
  pocket_3ds_audio_service();
  expect(UNDERRUN, s.handle);
  expect(CREDIT, s.handle, RING);
  expect_none();
  played_all(&s);
  /* A whole ring after the skip still fits, and plays in order. */
  CHECK(send(&s, RING, 0) == (int32_t)RING);
  pocket_3ds_audio_end_stream(s.handle);
  while (consume(s.channel, 997) > 0) pocket_3ds_audio_service();
  pocket_3ds_audio_service();
  expect(ENDED, s.handle);
  expect(CREDIT, s.handle, RING);
  expect_none();
  played_all(&s);
  close_track(&s);
  printf("ok sub-grain tail\n");
}

static void tiny_writes(void) {
  rebind();
  /* 300 writes of 1..13 frames while the DSP plays. */
  Track t = open_track(11025, 1);
  unsigned adds = dsp[t.channel].adds;
  pocket_3ds_audio_play(t.handle);
  uint32_t total = 0;
  for (unsigned i = 0; i < 300; i++) {
    uint32_t frames = 1 + (i * 7u) % 13u;
    CHECK(send(&t, frames, 0) == (int32_t)frames);
    total += frames;
    if (i % 5 == 4) {
      consume(t.channel, 23);
      pocket_3ds_audio_service();
    }
  }
  pocket_3ds_audio_end_stream(t.handle);
  while (consume(t.channel, 1000) > 0) pocket_3ds_audio_service();
  pocket_3ds_audio_service();
  played_all(&t);
  CHECK(t.sent_len == (size_t)total * 2);
  /* A buffer shorter than the grain takes the last copied frames: one after
   * endStream, and at most one a time the DSP ran dry. */
  CHECK(dsp[t.channel].adds - adds <= total / ALIGN + 1 + dsp[t.channel].idle_adds);
  bool ended = false;
  for (const char *e = next_event(); e != NULL; e = next_event()) {
    char wanted[64];
    snprintf(wanted, sizeof wanted, ENDED, t.handle);
    if (strcmp(e, wanted) == 0) {
      CHECK(!ended);
      ended = true;
    }
  }
  CHECK(ended);
  close_track(&t);

  /* 300 writes with the DSP stopped: the buffers run out, the rest waits. */
  forget_output();
  Track full = open_track(44100, 2);
  pocket_3ds_audio_play(full.handle);
  dsp[full.channel].paused = true; /* the DSP stalls; the module still plays */
  for (unsigned i = 0; i < 300; i++) send(&full, 55, 0);
  /* The first 55 frames went to the idle DSP and the next copy starts at the
   * grain, 9 frames on; those stay used while the DSP stalls. */
  CHECK(full.sent_len == (size_t)(RING - 9) * 4);
  CHECK(dsp[full.channel].max_count == POCKET_3DS_AUDIO_WAVEBUFS);
  dsp[full.channel].paused = false;
  pocket_3ds_audio_end_stream(full.handle);
  while (consume(full.channel, 4000) > 0) pocket_3ds_audio_service();
  pocket_3ds_audio_service();
  played_all(&full);
  drain();
  close_track(&full);
  printf("ok tiny writes\n");
}

static void volume(void) {
  rebind();
  Track t = open_track(22050, 1);
  const double in[] = {0.5, -1.0, 2.0, NAN, INFINITY, -INFINITY, 0.0, 1.0};
  const float want[] = {0.5f, 0.0f, 1.0f, 0.0f, 1.0f, 0.0f, 0.0f, 1.0f};
  for (unsigned i = 0; i < sizeof in / sizeof in[0]; i++) {
    pocket_3ds_audio_set_volume(t.handle, in[i]);
    CHECK(dsp[t.channel].mix[0] == want[i] && dsp[t.channel].mix[1] == want[i]);
    for (unsigned k = 2; k < 12; k++) CHECK(dsp[t.channel].mix[k] == 0.0f);
  }
  close_track(&t);
  printf("ok volume\n");
}

static void destroy_and_reset(void) {
  rebind();
  Track t = open_track(22050, 1);
  CHECK(send(&t, 1024, 0) == 1024);
  pocket_3ds_audio_play(t.handle);
  CHECK(consume(t.channel, 1024) == 1024);
  pocket_3ds_audio_service();
  /* Its pending underrun and credit die with it. */
  int slot = t.channel;
  pocket_3ds_audio_destroy_stream(t.handle);
  CHECK(dsp[slot].count == 0 && dsp[slot].paused);
  expect_none();
  Track again = open_track(44100, 2);
  CHECK(again.channel == slot);
  expect_none();
  close_track(&again);
  free(t.sent);

  Track all[POCKET_3DS_AUDIO_MAX_STREAMS];
  for (unsigned i = 0; i < POCKET_3DS_AUDIO_MAX_STREAMS; i++) {
    all[i] = open_track(22050, 1 + i % 2);
    CHECK(send(&all[i], 3000, 0) == 3000);
    pocket_3ds_audio_play(all[i].handle);
    consume(all[i].channel, 100);
  }
  pocket_3ds_audio_reset();
  CHECK(!pocket_3ds_audio_bound());
  for (unsigned i = 0; i < POCKET_3DS_AUDIO_MAX_STREAMS; i++) {
    CHECK(dsp[all[i].channel].count == 0 && dsp[all[i].channel].paused);
    CHECK(pocket_3ds_audio_write_pcm(all[i].handle, (const uint8_t *)"abcd", 4) == 0);
    free(all[i].sent);
  }
  pocket_3ds_audio_service();
  CHECK(!pocket_3ds_audio_poll(event, sizeof event));
  CHECK(pocket_3ds_audio_create_stream(22050, 1) == -1);
  /* The next guest's handles never repeat this guest's. */
  rebind();
  int32_t next = pocket_3ds_audio_create_stream(22050, 1);
  CHECK(next >= 0 && next != all[0].handle);
  CHECK(pocket_3ds_audio_write_pcm(all[0].handle, (const uint8_t *)"abcd", 4) == 0);
  pocket_3ds_audio_destroy_stream(next);
  printf("ok destroy and reset\n");
}

/* createWavPlayer (framework/src/audio-api.ts) at a 30 Hz presentation:
 * service before each guest frame, the guest drains events into its mirror
 * and writes up to 4096 frames. The DSP plays rate/30 frames a frame. */
static void guest_pump(uint32_t rate, uint32_t channels) {
  rebind();
  uint32_t total = rate * 3, cursor = 0, free_mirror = RING, frame = 0;
  size_t frame_bytes = 2u * channels;
  uint8_t *track = malloc(total * frame_bytes);
  CHECK(track != NULL);
  for (size_t i = 0; i < total * frame_bytes; i++) track[i] = noise_byte();
  int32_t h = pocket_3ds_audio_create_stream(rate, channels);
  int c = (int)(FIRST + ((unsigned)h & 7u));
  bool pending_play = true, end_sent = false, playing = true;
  unsigned underruns = 0, endings = 0;
  for (; frame < 400 && endings == 0; frame++) {
    uint32_t want = (uint32_t)(((uint64_t)(frame + 1) * rate) / 30 - ((uint64_t)frame * rate) / 30);
    if (!pending_play) consume(c, want);
    pocket_3ds_audio_service();
    for (const char *e = next_event(); e != NULL; e = next_event()) {
      unsigned value;
      if (sscanf(e, "{\"t\":\"credit\",\"h\":%*d,\"free\":%u}", &value) == 1) free_mirror = value;
      else if (strstr(e, "underrun") != NULL) underruns++;
      else if (strstr(e, "ended") != NULL) endings++, playing = false;
    }
    if (!playing || cursor >= total) continue;
    uint32_t n = total - cursor;
    if (n > free_mirror) n = free_mirror;
    if (n > 4096) n = 4096;
    if (n > 0) {
      int32_t accepted = pocket_3ds_audio_write_pcm(h, track + cursor * frame_bytes, n * frame_bytes);
      CHECK(accepted >= 0);
      cursor += (uint32_t)accepted;
      free_mirror -= (uint32_t)accepted;
    }
    if (pending_play && cursor > 0) {
      pending_play = false;
      pocket_3ds_audio_play(h);
    }
    if (cursor >= total && !end_sent) {
      end_sent = true;
      pocket_3ds_audio_end_stream(h);
    }
  }
  CHECK(underruns == 0 && endings == 1);
  CHECK(frame <= total * 30 / rate + 4);
  CHECK(dsp[c].out_len == total * frame_bytes && memcmp(dsp[c].out, track, total * frame_bytes) == 0);
  pocket_3ds_audio_destroy_stream(h);
  free(track);
  printf("ok guest pump %u Hz x%u\n", (unsigned)rate, (unsigned)channels);
}

static void shutdown_checks(void) {
  char error[160] = {0};
  pocket_3ds_audio_shutdown();
  CHECK(exits == 1 && refs == 0 && live_allocations() == 0 && !pocket_3ds_audio_ready());
  CHECK(!pocket_3ds_audio_bind(error, sizeof error));
  CHECK(strcmp(error, "audio: NDSP was shut down") == 0);
  CHECK(!pocket_3ds_audio_start() && inits == 1);
  pocket_3ds_audio_shutdown();
  CHECK(exits == 1);
  /* Only the stream channels were ever touched; channel 0 is media.c's. */
  CHECK((touched & ~(((1u << POCKET_3DS_AUDIO_MAX_STREAMS) - 1u) << FIRST)) == 0);
  CHECK(dsp[0].adds == 0 && dsp[0].clears == 0 && dsp[0].resets == 0);
  printf("ok shutdown, channel 0 untouched\n");
}

static void suite(void) {
  lifecycle();
  rates_and_format();
  handles();
  partial_writes();
  credit_after_full_drain();
  event_order();
  underrun_edges();
  ended_edges();
  stop_and_pause();
  ring_bounds();
  coalescing();
  sub_grain_tail();
  tiny_writes();
  volume();
  destroy_and_reset();
  guest_pump(11025, 1);
  guest_pump(22050, 1);
  guest_pump(44100, 2);
  shutdown_checks();
  printf("3DS audio module verified\n");
}

// ---------------------------------------------------------------------------
// transcript: the exact event lines of a fresh process (gens start at 1)
// ---------------------------------------------------------------------------

static void line(void) {
  const char *e = next_event();
  printf("%s\n", e != NULL ? e : "-");
}

static void transcript(void) {
  CHECK(pocket_3ds_audio_start());
  rebind();
  Track a = open_track(22050, 1), b = open_track(44100, 2);
  send(&a, 1024, 0);
  send(&b, 2048, 0);
  pocket_3ds_audio_play(a.handle);
  pocket_3ds_audio_play(b.handle);
  pocket_3ds_audio_end_stream(a.handle);
  consume(a.channel, 1024);
  consume(b.channel, 1024);
  pocket_3ds_audio_service();
  line(); line(); line(); line();
  consume(b.channel, 1024);
  pocket_3ds_audio_service();
  line(); line(); line();
  consume(b.channel, 100);
  pocket_3ds_audio_service();
  line();
  send(&b, 1024, 0);
  line();
  consume(b.channel, 1024);
  pocket_3ds_audio_service();
  line(); line(); line();
  close_track(&a);
  Track c = open_track(11025, 1);
  send(&c, 64, 0);
  pocket_3ds_audio_play(c.handle);
  pocket_3ds_audio_pause(c.handle);
  pocket_3ds_audio_end_stream(c.handle);
  pocket_3ds_audio_service();
  line();
  pocket_3ds_audio_play(c.handle);
  consume(c.channel, 64);
  pocket_3ds_audio_service();
  line(); line(); line();
  close_track(&b);
  close_track(&c);
  pocket_3ds_audio_shutdown();
}

// ---------------------------------------------------------------------------
// start failures
// ---------------------------------------------------------------------------

static void failed_start(Result result, const char *message) {
  init_result = result;
  char error[160] = {0};
  CHECK(!pocket_3ds_audio_start());
  /* No retry: a later 0-to-1 init could overlap media.c's worker. */
  CHECK(!pocket_3ds_audio_start() && inits == 1 && refs == 0);
  CHECK(!pocket_3ds_audio_bind(error, sizeof error));
  CHECK(strcmp(error, message) == 0);
  char text[160];
  pocket_3ds_audio_describe(text, sizeof text);
  CHECK(strcmp(text, message) == 0);
  CHECK(pocket_3ds_audio_create_stream(22050, 1) == -1);
  CHECK(pocket_3ds_audio_write_pcm(8, (const uint8_t *)"abcd", 4) == 0);
  pocket_3ds_audio_play(8);
  pocket_3ds_audio_service();
  CHECK(!pocket_3ds_audio_poll(event, sizeof event));
  pocket_3ds_audio_reset();
  pocket_3ds_audio_shutdown();
  CHECK(exits == 0 && touched == 0 && allocation_calls == 0);
  printf("ok start failure: %s\n", message);
}

static void no_memory(void) {
  char error[160] = {0};
  CHECK(pocket_3ds_audio_start());
  linear_budget = 2;
  CHECK(!pocket_3ds_audio_bind(error, sizeof error) && !pocket_3ds_audio_bound());
  CHECK(strcmp(error, "audio: the stream rings need 256 KiB of linear memory") == 0);
  CHECK(pocket_3ds_audio_create_stream(22050, 1) == -1);
  linear_budget = 1000;
  CHECK(pocket_3ds_audio_bind(error, sizeof error));
  CHECK(live_allocations() == POCKET_3DS_AUDIO_MAX_STREAMS);
  pocket_3ds_audio_shutdown();
  CHECK(live_allocations() == 0 && exits == 1);
  printf("ok ring allocation failure\n");
}

int main(int argc, char **argv) {
  const char *mode = argc > 1 ? argv[1] : "suite";
  if (strcmp(mode, "suite") == 0) suite();
  else if (strcmp(mode, "transcript") == 0) transcript();
  else if (strcmp(mode, "nofirmware") == 0)
    failed_start((Result)0xD880A7FAu,
                 "audio: DSP firmware missing (sdmc:/3ds/dspfirm.cdc); dump it in Rosalina and restart");
  else if (strcmp(mode, "initfail") == 0) failed_start(-1, "audio: ndspInit failed (0xffffffff)");
  else if (strcmp(mode, "nomemory") == 0) no_memory();
  else return 2;
  for (unsigned i = 0; i < 24; i++) free(dsp[i].out);
  return 0;
}
