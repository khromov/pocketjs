/* The audio module on NDSP (audio.h). All state below belongs to the main
 * thread. The one field another thread writes is ndspWaveBuf.status: NDSP's
 * thread (priority 0x18, on the application core like the main thread)
 * marks a buffer DONE after unlinking it from the channel's list, so a DONE
 * buffer may be refilled and queued again.
 *
 * Positions are absolute uint32 frame counts per stream:
 *
 *   done_pos <= queued_pos <= write_pos,   write_pos - done_pos <= RING_FRAMES
 *
 * [done, queued) is with NDSP, [queued, write) is copied but held, and the
 * guest's credit is RING_FRAMES - (write - done): ring space whose frames
 * the DSP has finished. RING_FRAMES divides 2^32, so `pos % RING_FRAMES` and
 * unsigned differences stay right when a position wraps. A buffer's span is
 * its frames plus the ring frames skipped after it so that the next copy
 * starts on the grain (realign); done advances by spans.
 *
 * The facts the PSP mixer thread publishes (streams.rs) are folded here by
 * observe(), once per frame from pocket_3ds_audio_service(). poll() only
 * reads them, so a guest turn sees the stream as of its last service; ops
 * inside the turn retire played buffers and queue frames, and raise no
 * edges. */
#include "audio.h"

#include <3ds.h>
#include <stdio.h>
#include <string.h>

#define MAX_STREAMS POCKET_3DS_AUDIO_MAX_STREAMS
#define RING_FRAMES POCKET_3DS_AUDIO_RING_FRAMES
#define MAX_CHANNELS POCKET_3DS_AUDIO_MAX_CHANNELS
#define WAVEBUFS POCKET_3DS_AUDIO_WAVEBUFS
#define WAVEBUF_FRAMES POCKET_3DS_AUDIO_WAVEBUF_FRAMES
#define MIN_WAVEBUF_FRAMES POCKET_3DS_AUDIO_MIN_WAVEBUF_FRAMES
#define ALIGN_FRAMES POCKET_3DS_AUDIO_ALIGN_FRAMES
/* A handle's generation keeps (generation << 3) | slot positive. */
#define MAX_GENERATION 0x0FFFFFFFu
#define RING_BYTES ((size_t)RING_FRAMES * MAX_CHANNELS * sizeof(int16_t))

_Static_assert(POCKET_3DS_AUDIO_FIRST_CHANNEL > 0 &&
                 POCKET_3DS_AUDIO_FIRST_CHANNEL + MAX_STREAMS <= 24,
               "NDSP has 24 channels and media.c plays on channel 0");
_Static_assert(MAX_STREAMS <= 8, "a handle carries its slot in three bits");
_Static_assert((RING_FRAMES & (RING_FRAMES - 1)) == 0, "RING_FRAMES must divide 2^32");
_Static_assert((WAVEBUFS & (WAVEBUFS - 1)) == 0, "WAVEBUFS must divide 2^32");
_Static_assert((ALIGN_FRAMES & (ALIGN_FRAMES - 1)) == 0 && WAVEBUF_FRAMES % ALIGN_FRAMES == 0 &&
                 MIN_WAVEBUF_FRAMES % ALIGN_FRAMES == 0 && RING_FRAMES % WAVEBUF_FRAMES == 0,
               "buffer bounds must fall on the alignment grain");
_Static_assert(ALIGN_FRAMES * sizeof(int16_t) >= 0x80, "a mono buffer starts on a 0x80-byte boundary");

typedef struct {
  int16_t *ring; /* RING_FRAMES frames of up to MAX_CHANNELS samples */
  uint32_t generation;
  uint32_t channels;
  uint32_t write_pos, queued_pos, done_pos;
  /* The free count the guest last saw: credit sets it, writes lower it. */
  uint32_t last_free;
  /* Wave buffers handed to NDSP and retired; waves[n % WAVEBUFS], whose
   * spans are spans[n % WAVEBUFS]. */
  uint32_t head, tail;
  bool live, playing, end_flagged, starved, underrun_edge, ended_edge;
  ndspWaveBuf waves[WAVEBUFS];
  uint32_t spans[WAVEBUFS];
} Stream;

static Stream streams[MAX_STREAMS];
static bool attempted, ready, bound;
static Result start_result;
static uint32_t underruns;

static int channel_of(unsigned slot) {
  return (int)(POCKET_3DS_AUDIO_FIRST_CHANNEL + slot);
}

static int32_t handle_of(unsigned slot, uint32_t generation) {
  return (int32_t)((generation << 3) | slot);
}

static Stream *stream_of(int32_t handle, unsigned *slot) {
  if (!bound || handle < 0) return NULL;
  unsigned index = (unsigned)handle & 7u;
  if (index >= MAX_STREAMS) return NULL;
  Stream *stream = &streams[index];
  if (!stream->live || stream->generation != ((uint32_t)handle >> 3)) return NULL;
  *slot = index;
  return stream;
}

static uint32_t align_up(uint32_t position) {
  return (position + ALIGN_FRAMES - 1u) & ~(ALIGN_FRAMES - 1u);
}

static uint32_t free_frames(const Stream *stream) {
  return RING_FRAMES - (stream->write_pos - stream->done_pos);
}

/* With no frame held, the next copy moves to the next grain boundary, so the
 * next buffer starts aligned. The skipped frames join the span of the last
 * buffer with NDSP, or, when NDSP holds none, done moves with them. */
static void realign(Stream *stream) {
  uint32_t position = align_up(stream->write_pos);
  if (stream->tail != stream->head)
    stream->spans[(stream->head - 1u) % WAVEBUFS] += position - stream->write_pos;
  else
    stream->done_pos = position;
  stream->write_pos = stream->queued_pos = position;
}

/* After ndspChnWaveBufClear or ndspChnReset, which mark every queued buffer
 * DONE: drop the unplayed frames. */
static void drop_queue(Stream *stream) {
  stream->tail = stream->head;
  stream->queued_pos = stream->done_pos = stream->write_pos;
  realign(stream);
}

/* NDSP marks buffers DONE in queue order. */
static void retire(Stream *stream) {
  while (stream->tail != stream->head) {
    ndspWaveBuf *wave = &stream->waves[stream->tail % WAVEBUFS];
    if (__atomic_load_n(&wave->status, __ATOMIC_ACQUIRE) != NDSP_WBUF_DONE) break;
    stream->done_pos += stream->spans[stream->tail % WAVEBUFS];
    stream->tail++;
  }
}

/* Hand copied frames to NDSP while the stream plays. Buffers end on the
 * grain and stop at the ring end; a tail shorter than MIN_WAVEBUF_FRAMES
 * waits while the DSP holds enough. endStream, or a DSP that holds nothing,
 * releases every frame, as streams.rs's mixer plays every frame written. */
static void queue(Stream *stream, unsigned slot) {
  bool release = stream->end_flagged || stream->tail == stream->head;
  while (stream->playing && stream->head - stream->tail < WAVEBUFS) {
    uint32_t pending = stream->write_pos - stream->queued_pos;
    if (pending == 0) return;
    uint32_t at = stream->queued_pos % RING_FRAMES;
    uint32_t frames = pending;
    if (frames > WAVEBUF_FRAMES) frames = WAVEBUF_FRAMES;
    if (frames > RING_FRAMES - at) frames = RING_FRAMES - at;
    if (!release) {
      uint32_t with_dsp = stream->queued_pos - stream->done_pos;
      if (pending < MIN_WAVEBUF_FRAMES && with_dsp >= 2u * MIN_WAVEBUF_FRAMES) return;
      /* Round the end down to the grain; nothing left means wait for more. */
      uint32_t end = (stream->queued_pos + frames) & ~(ALIGN_FRAMES - 1u);
      if (end - stream->queued_pos > frames || end == stream->queued_pos) return;
      frames = end - stream->queued_pos;
    }
    ndspWaveBuf *wave = &stream->waves[stream->head % WAVEBUFS];
    memset(wave, 0, sizeof *wave);
    wave->data_pcm16 = stream->ring + (size_t)at * stream->channels;
    wave->nsamples = frames;
    stream->spans[stream->head % WAVEBUFS] = frames;
    ndspChnWaveBufAdd(channel_of(slot), wave);
    stream->head++;
    stream->queued_pos += frames;
  }
}

/* The PSP mixer's facts, read from the buffer states: the DSP has nothing
 * queued, so a stream with endStream and an empty ring ended (auto-paused,
 * one ended event), and any other stream is starved (one underrun event per
 * starved episode; data reaching the DSP ends the episode). */
static void observe(Stream *stream, unsigned slot) {
  if (!stream->playing) return;
  if (stream->queued_pos != stream->done_pos) {
    stream->starved = false;
    return;
  }
  if (stream->end_flagged) {
    if (stream->write_pos != stream->done_pos) return;
    stream->playing = false;
    stream->end_flagged = false;
    stream->starved = false;
    stream->ended_edge = true;
    ndspChnSetPaused(channel_of(slot), true);
    return;
  }
  if (!stream->starved) {
    stream->starved = true;
    stream->underrun_edge = true;
    underruns++;
  }
}

static void silence(Stream *stream, unsigned slot) {
  ndspChnWaveBufClear(channel_of(slot));
  ndspChnSetPaused(channel_of(slot), true);
  drop_queue(stream);
}

static void set_mix(int channel, float volume) {
  float mix[12] = {0};
  mix[0] = mix[1] = volume;
  ndspChnSetMix(channel, mix);
}

static bool firmware_missing(Result result) {
  return R_MODULE(result) == RM_DSP && R_SUMMARY(result) == RS_NOTFOUND &&
         R_DESCRIPTION(result) == RD_NOT_FOUND;
}

static void unavailable(char *error, size_t error_length) {
  if (error == NULL || error_length == 0) return;
  if (!attempted)
    snprintf(error, error_length, "audio: NDSP was not started");
  else if (R_SUCCEEDED(start_result))
    snprintf(error, error_length, "audio: NDSP was shut down");
  else if (firmware_missing(start_result))
    snprintf(error, error_length,
             "audio: DSP firmware missing (sdmc:/3ds/dspfirm.cdc); dump it in Rosalina and restart");
  else
    snprintf(error, error_length, "audio: ndspInit failed (0x%08lx)", (unsigned long)(uint32_t)start_result);
}

// ---------------------------------------------------------------------------
// process lifetime
// ---------------------------------------------------------------------------

bool pocket_3ds_audio_start(void) {
  if (attempted) return ready;
  attempted = true;
  start_result = ndspInit();
  if (R_FAILED(start_result)) return false;
  ndspSetOutputMode(NDSP_OUTPUT_STEREO);
  ready = true;
  return true;
}

bool pocket_3ds_audio_ready(void) {
  return ready;
}

void pocket_3ds_audio_shutdown(void) {
  pocket_3ds_audio_reset();
  if (ready) {
    ndspExit();
    ready = false;
  }
  for (unsigned slot = 0; slot < MAX_STREAMS; slot++) {
    if (streams[slot].ring != NULL) linearFree(streams[slot].ring);
    streams[slot].ring = NULL;
  }
}

// ---------------------------------------------------------------------------
// per guest
// ---------------------------------------------------------------------------

bool pocket_3ds_audio_bind(char *error, size_t error_length) {
  pocket_3ds_audio_reset();
  if (!ready) {
    unavailable(error, error_length);
    return false;
  }
  for (unsigned slot = 0; slot < MAX_STREAMS; slot++) {
    if (streams[slot].ring == NULL) streams[slot].ring = linearMemAlign(RING_BYTES, 0x80);
    if (streams[slot].ring == NULL) {
      if (error != NULL && error_length > 0)
        snprintf(error, error_length, "audio: the stream rings need %u KiB of linear memory",
                 (unsigned)(RING_BYTES * MAX_STREAMS / 1024u));
      return false;
    }
  }
  bound = true;
  return true;
}

bool pocket_3ds_audio_bound(void) {
  return bound;
}

void pocket_3ds_audio_reset(void) {
  for (unsigned slot = 0; slot < MAX_STREAMS; slot++) {
    Stream *stream = &streams[slot];
    if (stream->live && ready) silence(stream, slot);
    stream->live = stream->playing = stream->end_flagged = stream->starved = false;
    stream->underrun_edge = stream->ended_edge = false;
  }
  bound = false;
}

void pocket_3ds_audio_service(void) {
  if (!bound) return;
  for (unsigned slot = 0; slot < MAX_STREAMS; slot++) {
    Stream *stream = &streams[slot];
    if (!stream->live) continue;
    retire(stream);
    queue(stream, slot);
    observe(stream, slot);
  }
}

// ---------------------------------------------------------------------------
// the spec's ops
// ---------------------------------------------------------------------------

int32_t pocket_3ds_audio_create_stream(uint32_t sample_rate, uint32_t channels) {
  if (!bound) return -1;
  if (sample_rate != 44100u && sample_rate != 22050u && sample_rate != 11025u) return -1;
  if (channels < 1u || channels > MAX_CHANNELS) return -1;
  unsigned slot = 0;
  while (slot < MAX_STREAMS && streams[slot].live) slot++;
  if (slot == MAX_STREAMS) return -1;
  Stream *stream = &streams[slot];
  int channel = channel_of(slot);
  /* Reset also marks a destroyed stream's buffers DONE. */
  ndspChnReset(channel);
  ndspChnSetPaused(channel, true);
  ndspChnSetInterp(channel, NDSP_INTERP_LINEAR);
  ndspChnSetRate(channel, (float)sample_rate);
  ndspChnSetFormat(channel, channels == 2u ? NDSP_FORMAT_STEREO_PCM16 : NDSP_FORMAT_MONO_PCM16);
  set_mix(channel, 1.0f);
  /* New frames land after the previous stream's: the DSP may read that
   * region until it takes the reset at its next frame. */
  uint32_t base = align_up(stream->write_pos);
  uint32_t generation = stream->generation >= MAX_GENERATION ? 1u : stream->generation + 1u;
  int16_t *ring = stream->ring;
  memset(stream, 0, sizeof *stream);
  stream->ring = ring;
  stream->generation = generation;
  stream->channels = channels;
  stream->write_pos = stream->queued_pos = stream->done_pos = base;
  stream->last_free = RING_FRAMES;
  stream->live = true;
  return handle_of(slot, generation);
}

void pocket_3ds_audio_destroy_stream(int32_t handle) {
  unsigned slot;
  Stream *stream = stream_of(handle, &slot);
  if (stream == NULL) return;
  silence(stream, slot);
  stream->live = stream->playing = false;
}

int32_t pocket_3ds_audio_write_pcm(int32_t handle, const uint8_t *bytes, size_t length) {
  unsigned slot;
  Stream *stream = stream_of(handle, &slot);
  if (stream == NULL || (bytes == NULL && length != 0)) return 0;
  retire(stream);
  if (stream->write_pos == stream->queued_pos) realign(stream);
  size_t frame_bytes = 2u * stream->channels;
  size_t frames = length / frame_bytes;
  uint32_t room = free_frames(stream);
  uint32_t accepted = frames < room ? (uint32_t)frames : room;
  if (accepted == 0) return 0;
  uint32_t at = stream->write_pos % RING_FRAMES;
  uint32_t first = accepted < RING_FRAMES - at ? accepted : RING_FRAMES - at;
  /* s16 LE is the ARM11's byte order. The DSP reads physical memory, so the
   * copied bytes are written back from the data cache before NDSP sees them. */
  int16_t *target = stream->ring + (size_t)at * stream->channels;
  memcpy(target, bytes, first * frame_bytes);
  DSP_FlushDataCache(target, (u32)(first * frame_bytes));
  if (accepted > first) {
    memcpy(stream->ring, bytes + first * frame_bytes, (accepted - first) * frame_bytes);
    DSP_FlushDataCache(stream->ring, (u32)((accepted - first) * frame_bytes));
  }
  stream->write_pos += accepted;
  /* streams.rs write_samples: the guest lowers its own mirror by what it
   * wrote, so this one does too; otherwise a ring that drains between two
   * polls reads as unchanged and the guest stops feeding. */
  stream->last_free = stream->last_free > accepted ? stream->last_free - accepted : 0;
  queue(stream, slot);
  /* Frames reaching the DSP end a starved episode; the next service raises
   * the edges, so a guest that plays and then writes in one turn sees no
   * underrun. */
  if (stream->queued_pos != stream->done_pos) stream->starved = false;
  return (int32_t)accepted;
}

void pocket_3ds_audio_play(int32_t handle) {
  unsigned slot;
  Stream *stream = stream_of(handle, &slot);
  if (stream == NULL) return;
  stream->starved = false;
  stream->playing = true;
  ndspChnSetPaused(channel_of(slot), false);
  queue(stream, slot);
}

/* Queued buffers stay with the paused channel; held frames stay held. */
void pocket_3ds_audio_pause(int32_t handle) {
  unsigned slot;
  Stream *stream = stream_of(handle, &slot);
  if (stream == NULL) return;
  stream->playing = false;
  ndspChnSetPaused(channel_of(slot), true);
}

void pocket_3ds_audio_stop(int32_t handle) {
  unsigned slot;
  Stream *stream = stream_of(handle, &slot);
  if (stream == NULL) return;
  stream->playing = stream->end_flagged = stream->starved = false;
  silence(stream, slot);
}

void pocket_3ds_audio_set_volume(int32_t handle, double volume) {
  unsigned slot;
  Stream *stream = stream_of(handle, &slot);
  if (stream == NULL) return;
  /* NaN and negative volumes are silence, as streams.rs's clamp gives. */
  float value = !(volume >= 0.0) ? 0.0f : volume > 1.0 ? 1.0f : (float)volume;
  set_mix(channel_of(slot), value);
}

void pocket_3ds_audio_end_stream(int32_t handle) {
  unsigned slot;
  Stream *stream = stream_of(handle, &slot);
  if (stream == NULL) return;
  stream->end_flagged = true;
  queue(stream, slot);
}

static bool emit(char *out, size_t capacity, const char *line, int length) {
  if (length < 0 || (size_t)length >= capacity) return false;
  memcpy(out, line, (size_t)length + 1u);
  return true;
}

bool pocket_3ds_audio_poll(char *out, size_t capacity) {
  if (!bound || out == NULL) return false;
  char line[POCKET_3DS_AUDIO_EVENT_BYTES];
  for (unsigned slot = 0; slot < MAX_STREAMS; slot++) {
    Stream *stream = &streams[slot];
    if (!stream->live) continue;
    long handle = (long)handle_of(slot, stream->generation);
    if (stream->ended_edge) {
      if (!emit(out, capacity, line, snprintf(line, sizeof line, "{\"t\":\"ended\",\"h\":%ld}", handle)))
        return false;
      stream->ended_edge = false;
      return true;
    }
    if (stream->underrun_edge) {
      if (!emit(out, capacity, line, snprintf(line, sizeof line, "{\"t\":\"underrun\",\"h\":%ld}", handle)))
        return false;
      stream->underrun_edge = false;
      return true;
    }
    uint32_t free_now = free_frames(stream);
    if (free_now != stream->last_free) {
      if (!emit(out, capacity, line,
                snprintf(line, sizeof line, "{\"t\":\"credit\",\"h\":%ld,\"free\":%lu}", handle,
                         (unsigned long)free_now)))
        return false;
      stream->last_free = free_now;
      return true;
    }
  }
  return false;
}

void pocket_3ds_audio_describe(char *out, size_t capacity) {
  if (out == NULL || capacity == 0) return;
  if (!ready) {
    char reason[128];
    unavailable(reason, sizeof reason);
    snprintf(out, capacity, "%s", reason);
    return;
  }
  unsigned live = 0;
  for (unsigned slot = 0; slot < MAX_STREAMS; slot++) live += streams[slot].live ? 1u : 0u;
  snprintf(out, capacity, "audio: dsp ok, %u/%u streams, %lu underruns", live, MAX_STREAMS,
           (unsigned long)underruns);
}
