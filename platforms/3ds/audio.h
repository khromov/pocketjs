/* The audio module (contracts/spec/audio.ts) on NDSP: up to four guest
 * streams, each on its own DSP channel at its source rate and format.
 *
 * Every function runs on the main thread. NDSP's own thread feeds the DSP
 * from the queued wave buffers; the main loop calls
 * pocket_3ds_audio_service() once per presented frame to retire played
 * buffers, queue held frames and record the underrun and ended facts, and
 * poll() turns those facts into the spec's JSON events. platforms/psp/audio/
 * src/streams.rs is the reference for every observable behaviour: handles,
 * refusals, writePcm's accepted-frame count, and event text and order.
 *
 * NDSP ownership: ndspInit and ndspExit are reference counted, but only the
 * caller that moves the count from 0 to 1 initializes and only the one that
 * moves it from 1 to 0 finalizes, and neither waits for the other.
 * pocket_3ds_audio_start() takes a reference before platforms/3ds/media.c's
 * worker exists, and pocket_3ds_audio_shutdown() drops it after that worker is
 * joined, so the worker's per-stream ndspInit/ndspExit only move the count
 * between 1 and 2. A failed start is not retried in the same process: a later
 * 0-to-1 init could overlap the worker's own. */
#ifndef POCKETJS_3DS_AUDIO_H
#define POCKETJS_3DS_AUDIO_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* contracts/spec/audio.ts: AUDIO_MAX_STREAMS, AUDIO_RING_FRAMES,
 * AUDIO_MAX_CHANNELS. tests/3ds-audio.test.ts compares them. */
#define POCKET_3DS_AUDIO_MAX_STREAMS 4u
#define POCKET_3DS_AUDIO_RING_FRAMES 16384u
#define POCKET_3DS_AUDIO_MAX_CHANNELS 2u

/* Stream slot n plays on NDSP channel FIRST_CHANNEL + n. media.c plays
 * companion video sound on channel 0. */
#define POCKET_3DS_AUDIO_FIRST_CHANNEL 8u
/* Wave buffers per stream. A buffer holds at most WAVEBUF_FRAMES frames,
 * starts on an ALIGN_FRAMES boundary of its ring and never crosses the ring
 * end. It ends on the boundary too, except a buffer that takes the last
 * copied frames after endStream or while the DSP holds no buffer: streams.rs
 * plays every frame written. While the DSP holds 2 * MIN_WAVEBUF_FRAMES or
 * more, frames are held until a buffer of MIN_WAVEBUF_FRAMES can be queued. */
#define POCKET_3DS_AUDIO_WAVEBUFS 64u
#define POCKET_3DS_AUDIO_WAVEBUF_FRAMES 1024u
#define POCKET_3DS_AUDIO_MIN_WAVEBUF_FRAMES 256u
#define POCKET_3DS_AUDIO_ALIGN_FRAMES 64u
/* Bytes poll() needs for its longest event and the terminator. */
#define POCKET_3DS_AUDIO_EVENT_BYTES 64u

/* Process lifetime. start() runs once, before media_start(); it returns false
 * when NDSP did not start (no sdmc:/3ds/dspfirm.cdc, for one), and every
 * later call returns the same answer. shutdown() runs after media_stop(): it
 * silences every stream, drops the NDSP reference and frees the rings. */
bool pocket_3ds_audio_start(void);
bool pocket_3ds_audio_ready(void);
void pocket_3ds_audio_shutdown(void);

/* Per guest. bind() resets the module, then mounts it for a guest whose
 * plan has audio.pcm: false (with error text) when NDSP did not start or the
 * rings (64 KiB of linear memory a stream, kept until shutdown) cannot be
 * allocated. reset() destroys every stream and unbinds; handles of an
 * earlier guest stay invalid because generations continue. */
bool pocket_3ds_audio_bind(char *error, size_t error_length);
bool pocket_3ds_audio_bound(void);
void pocket_3ds_audio_reset(void);

/* Once per presented frame, before the guest's frame. */
void pocket_3ds_audio_service(void);

/* The spec's ops. A handle is (generation << 3) | slot; -1 is a refusal (a
 * rate outside 44100/22050/11025, channels outside 1..2, four live streams,
 * or the module not bound). Ops on an unknown handle do nothing, and
 * write_pcm returns 0 for them. */
int32_t pocket_3ds_audio_create_stream(uint32_t sample_rate, uint32_t channels);
void pocket_3ds_audio_destroy_stream(int32_t handle);
/* Interleaved s16 LE frames in any alignment; a partial last frame is
 * ignored. Copies min(frames, free ring frames) before returning and
 * returns that count. */
int32_t pocket_3ds_audio_write_pcm(int32_t handle, const uint8_t *bytes, size_t length);
void pocket_3ds_audio_play(int32_t handle);
void pocket_3ds_audio_pause(int32_t handle);
void pocket_3ds_audio_stop(int32_t handle);
void pocket_3ds_audio_set_volume(int32_t handle, double volume);
void pocket_3ds_audio_end_stream(int32_t handle);
/* One event per call into out (POCKET_3DS_AUDIO_EVENT_BYTES suffice): slot
 * order, and per slot ended, then underrun, then credit. False when none is
 * pending (or out is too small; the event then stays pending). */
bool pocket_3ds_audio_poll(char *out, size_t capacity);

/* One line for the developer menu: NDSP state, live streams, underruns. */
void pocket_3ds_audio_describe(char *out, size_t capacity);

#endif
