// Audio module SDK — the thin guest-side algebra over the `audio` spec
// (contracts/spec/audio.ts). Framework-agnostic (no solid-js, no JSX): the
// same file serves ./audio, ./vue-vapor/audio and ./octane/audio.
//
// Layering (the tiles.ts shape, one level up):
//   WAV bytes in the app pak (audio:wav.<name>, raw-blob pak.json route)
//     -> openWav()                 guest-side RIFF parse, cold path, once:
//                                  a 16-bit PCM view (decodeWav) or an IMA
//                                  ADPCM block decoder (decodeImaAdpcm)
//     -> createWavPlayer()         credit-driven pump over the audio ops
//     -> globalThis.audio          the mounted module namespace (or absent)
//
// The player follows law 1: it mirrors its free-frame budget and cursor
// guest-side, so a frame's hot path is poll-drain + at most one writePcm —
// never a query. Hosts without the module (goldens, consoles today) leave
// `globalThis.audio` unset; every player call degrades to a silent no-op and
// the app's tick-driven UI is byte-identical either way.

import {
  AUDIO_IMA_INDEX,
  AUDIO_IMA_STEP,
  AUDIO_INPUT_SOURCE,
  AUDIO_MAX_CHANNELS,
  AUDIO_PAK_WAV_PREFIX,
  AUDIO_RATES,
  AUDIO_RING_FRAMES,
  AUDIO_WAV_FORMAT,
  type AudioInputSource,
} from "../../contracts/spec/audio.ts";
import { get as pakGet, hasPack } from "./pak.ts";

export {
  AUDIO_INPUT_RING_FRAMES,
  AUDIO_INPUT_SOURCE,
  AUDIO_RATES,
  AUDIO_RING_FRAMES,
} from "../../contracts/spec/audio.ts";
export type { AudioInputSource } from "../../contracts/spec/audio.ts";

/** The mounted audio namespace — one method per spec op (AUDIO_OP codes). */
export interface AudioOps {
  createStream(sampleRate: number, channels: number): number;
  destroyStream(handle: number): void;
  /** Interleaved s16 LE at the stream rate; BORROWED for the call. */
  writePcm(handle: number, pcm: ArrayBuffer): number;
  play(handle: number): void;
  pause(handle: number): void;
  stop(handle: number): void;
  setVolume(handle: number, volume: number): void;
  endStream(handle: number): void;
  poll(): string | undefined;
  /** audio.capture: absent on hosts without inputs. */
  openInput?(sampleRate: number, channels: number, source: number): number;
  readInput?(handle: number, pcm: ArrayBuffer): number;
  closeInput?(handle: number): void;
}

/** The audio module namespace, or null where the host doesn't mount one.
 *  A live lookup (not cached): hosts install `globalThis.audio` before eval
 *  and reset it per app load, exactly like `globalThis.ui`. */
export function audioHost(): AudioOps | null {
  const ns = (globalThis as { audio?: unknown }).audio;
  if (!ns || typeof ns !== "object") return null;
  return typeof (ns as AudioOps).createStream === "function" ? (ns as AudioOps) : null;
}

// ---------------------------------------------------------------------------
// WAV decode (the reference decoder for the audio:wav.* data contract)
// ---------------------------------------------------------------------------

export interface WavPcm {
  readonly sampleRate: number;
  readonly channels: number;
  /** Sample frames (samples per channel). */
  readonly frames: number;
  /** Interleaved s16, a view over the source bytes' data chunk. */
  readonly data: Int16Array;
}

/** QuickJS-safe u32 LE read (no TextDecoder, DataView handles alignment). */
function fourcc(v: DataView, off: number): number {
  return v.getUint32(off, true);
}

const RIFF = 0x46464952; // "RIFF"
const WAVE = 0x45564157; // "WAVE"
const FMT_ = 0x20746d66; // "fmt "
const FACT = 0x74636166; // "fact"
const DATA = 0x61746164; // "data"

/**
 * Parse a RIFF/WAVE file into PCM. Accepts exactly the spec shape — PCM
 * (format 1), 16-bit, 1..2 channels, rate in AUDIO_RATES — and throws on
 * anything else: an unplayable asset is a build mistake, not a runtime
 * condition to limp through.
 */
export function decodeWav(bytes: Uint8Array): WavPcm {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 44 || fourcc(v, 0) !== RIFF || fourcc(v, 8) !== WAVE) {
    throw new Error("audio: not a RIFF/WAVE file");
  }
  let sampleRate = 0;
  let channels = 0;
  let dataOff = -1;
  let dataLen = 0;
  // Chunk walk: WAVs in the wild carry LIST/fact/cue chunks between fmt and
  // data; skip anything unknown (chunks are word-aligned).
  for (let off = 12; off + 8 <= bytes.byteLength; ) {
    const id = fourcc(v, off);
    const size = v.getUint32(off + 4, true);
    if (id === FMT_) {
      const format = v.getUint16(off + 8, true);
      channels = v.getUint16(off + 10, true);
      sampleRate = v.getUint32(off + 12, true);
      const bits = v.getUint16(off + 22, true);
      if (format !== 1 || bits !== 16) {
        throw new Error(`audio: WAV must be 16-bit PCM (format ${format}, ${bits} bits)`);
      }
    } else if (id === DATA) {
      dataOff = off + 8;
      dataLen = Math.min(size, bytes.byteLength - dataOff);
    }
    off += 8 + size + (size & 1);
  }
  if (dataOff < 0) throw new Error("audio: WAV has no data chunk");
  if (channels < 1 || channels > AUDIO_MAX_CHANNELS) {
    throw new Error(`audio: WAV must be mono or stereo (${channels} channels)`);
  }
  if (!(AUDIO_RATES as readonly number[]).includes(sampleRate)) {
    throw new Error(`audio: WAV rate ${sampleRate} not in [${AUDIO_RATES.join(", ")}]`);
  }
  const bytesPerFrame = 2 * channels;
  const frames = Math.floor(dataLen / bytesPerFrame);
  // s16 needs 2-byte alignment; pak blobs are 16-aligned but the data chunk
  // offset inside the WAV may not be — copy in that (rare) case.
  const abs = bytes.byteOffset + dataOff;
  const data =
    abs % 2 === 0
      ? new Int16Array(bytes.buffer, abs, frames * channels)
      : new Int16Array(bytes.slice(dataOff, dataOff + frames * bytesPerFrame).buffer);
  return { sampleRate, channels, frames, data };
}

// ---------------------------------------------------------------------------
// IMA ADPCM (audioFormat 0x11): the second audio:wav.* shape, 4 bits a sample
// ---------------------------------------------------------------------------

/** A track that decodes on demand. */
export interface WavStream {
  readonly sampleRate: number;
  readonly channels: number;
  /** Sample frames (samples per channel). */
  readonly frames: number;
  /** Interleaved s16 for frames [frame, frame + count), in a new array. */
  read(frame: number, count: number): Int16Array;
}

/** What a WavPlayer plays: a PCM view or an on-demand decoder. */
export type WavTrack = WavPcm | WavStream;

// The expansion depends only on (step index, code): IMA_DELTA[(index << 4) |
// code] is the signed predictor change and IMA_NEXT the next step index, so a
// sample costs two table reads and a clamp in the interpreter.
const IMA_DELTA = new Int32Array(89 * 16);
const IMA_NEXT = new Uint8Array(89 * 16);
for (let index = 0; index < 89; index++) {
  const step = AUDIO_IMA_STEP[index]!;
  for (let code = 0; code < 16; code++) {
    let diff = step >> 3;
    if (code & 4) diff += step;
    if (code & 2) diff += step >> 1;
    if (code & 1) diff += step >> 2;
    IMA_DELTA[(index << 4) | code] = code & 8 ? -diff : diff;
    IMA_NEXT[(index << 4) | code] = Math.min(88, Math.max(0, index + AUDIO_IMA_INDEX[code]!));
  }
}

/**
 * Open an IMA ADPCM WAV (contracts/spec/audio.ts). Nothing is decoded here:
 * read() expands the blocks it touches into one block-sized cache, so a
 * sequential reader decodes every block once and the track's s16 form never
 * exists whole. The bytes are read in place (a pak view stays a view).
 */
export function decodeImaAdpcm(bytes: Uint8Array): WavStream {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 12 || fourcc(v, 0) !== RIFF || fourcc(v, 8) !== WAVE) {
    throw new Error("audio: not a RIFF/WAVE file");
  }
  let format = -1;
  let channels = 0;
  let sampleRate = 0;
  let blockAlign = 0;
  let bits = 0;
  let declaredPerBlock = -1;
  let factFrames = -1;
  let dataOff = -1;
  let dataLen = 0;
  for (let off = 12; off + 8 <= bytes.byteLength; ) {
    const id = fourcc(v, off);
    const size = v.getUint32(off + 4, true);
    if (id === FMT_ && size >= 16) {
      format = v.getUint16(off + 8, true);
      channels = v.getUint16(off + 10, true);
      sampleRate = v.getUint32(off + 12, true);
      blockAlign = v.getUint16(off + 20, true);
      bits = v.getUint16(off + 22, true);
      if (size >= 20 && v.getUint16(off + 24, true) >= 2) declaredPerBlock = v.getUint16(off + 26, true);
    } else if (id === FACT && size >= 4) {
      factFrames = v.getUint32(off + 8, true);
    } else if (id === DATA) {
      dataOff = off + 8;
      dataLen = Math.min(size, bytes.byteLength - dataOff);
    }
    off += 8 + size + (size & 1);
  }
  if (format !== AUDIO_WAV_FORMAT.imaAdpcm || bits !== 4) {
    throw new Error(`audio: not a 4-bit IMA ADPCM WAV (format ${format}, ${bits} bits)`);
  }
  if (dataOff < 0) throw new Error("audio: WAV has no data chunk");
  if (channels < 1 || channels > AUDIO_MAX_CHANNELS) {
    throw new Error(`audio: WAV must be mono or stereo (${channels} channels)`);
  }
  if (!(AUDIO_RATES as readonly number[]).includes(sampleRate)) {
    throw new Error(`audio: WAV rate ${sampleRate} not in [${AUDIO_RATES.join(", ")}]`);
  }
  const header = 4 * channels;
  if (blockAlign <= header || (blockAlign - header) % header !== 0) {
    throw new Error(`audio: IMA ADPCM block of ${blockAlign} bytes does not fit ${channels} channel(s)`);
  }
  const perBlock = ((blockAlign - header) * 2) / channels + 1;
  if (declaredPerBlock >= 0 && declaredPerBlock !== perBlock) {
    throw new Error(`audio: IMA ADPCM declares ${declaredPerBlock} samples a block, its layout holds ${perBlock}`);
  }
  // Frames the data chunk holds: whole blocks, plus a short last block's
  // header sample and its whole 4-byte groups.
  const whole = Math.floor(dataLen / blockAlign);
  const rest = dataLen - whole * blockAlign;
  const held = whole * perBlock + (rest >= header ? 1 + Math.floor((rest - header) / header) * 8 : 0);
  const frames = factFrames >= 0 ? Math.min(factFrames, held) : held;

  const cache = new Int16Array(perBlock * channels);
  // The cache holds the current block's frames [0, decoded); `predictors` and
  // `indexes` are each channel's decoder state at frame `decoded`. A read
  // extends the decode only to the frames it returns, so a sequential reader
  // pays per frame it plays (on the PSP a whole 2041-frame block in one read
  // would cost a frame-sized spike).
  let cached = -1;
  let decoded = 0;
  let groups = 0; // first group byte of the current block
  const predictors = new Int32Array(channels);
  const indexes = new Int32Array(channels);

  function openBlock(block: number): void {
    const start = dataOff + block * blockAlign;
    for (let c = 0; c < channels; c++) {
      const h = start + c * 4;
      const predictor = ((bytes[h]! | (bytes[h + 1]! << 8)) << 16) >> 16;
      const index = bytes[h + 2]!;
      if (index > 88) throw new Error(`audio: IMA ADPCM step index ${index} out of range`);
      cache[c] = predictor;
      predictors[c] = predictor;
      indexes[c] = index;
    }
    cached = block;
    decoded = 1;
    groups = start + header;
  }

  function decodeTo(target: number): void {
    if (channels === 1) {
      // Mono: the groups are consecutive, two samples a byte, low nibble first.
      let predictor = predictors[0]!;
      let index = indexes[0]!;
      for (let k = decoded; k < target; k++) {
        const j = k - 1;
        const byte = bytes[groups + (j >> 1)]!;
        const at = (index << 4) | (j & 1 ? byte >> 4 : byte & 15);
        predictor += IMA_DELTA[at]!;
        if (predictor > 32767) predictor = 32767;
        else if (predictor < -32768) predictor = -32768;
        index = IMA_NEXT[at]!;
        cache[k] = predictor;
      }
      predictors[0] = predictor;
      indexes[0] = index;
      decoded = target;
      return;
    }
    for (let c = 0; c < channels; c++) {
      let predictor = predictors[c]!;
      let index = indexes[c]!;
      const lane = groups + c * 4;
      for (let k = decoded; k < target; k++) {
        const j = k - 1; // sample j of this channel after the header
        const byte = bytes[lane + (j >> 3) * header + ((j & 7) >> 1)]!;
        const at = (index << 4) | (j & 1 ? byte >> 4 : byte & 15);
        predictor += IMA_DELTA[at]!;
        if (predictor > 32767) predictor = 32767;
        else if (predictor < -32768) predictor = -32768;
        index = IMA_NEXT[at]!;
        cache[k * channels + c] = predictor;
      }
      predictors[c] = predictor;
      indexes[c] = index;
    }
    decoded = target;
  }

  return {
    sampleRate,
    channels,
    frames,
    read(frame: number, count: number): Int16Array {
      const out = new Int16Array(count * channels);
      const end = Math.min(frame + count, frames);
      let f = frame;
      let o = 0;
      while (f < end) {
        const block = Math.floor(f / perBlock);
        if (block !== cached) openBlock(block);
        const first = f - block * perBlock;
        const n = Math.min(end - f, perBlock - first);
        if (first + n > decoded) decodeTo(first + n);
        out.set(cache.subarray(first * channels, (first + n) * channels), o);
        o += n * channels;
        f += n;
      }
      return out;
    },
  };
}

/** The `fmt ` audioFormat of a RIFF/WAVE file, or -1. */
function wavFormat(bytes: Uint8Array): number {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 12 || fourcc(v, 0) !== RIFF || fourcc(v, 8) !== WAVE) return -1;
  for (let off = 12; off + 8 <= bytes.byteLength; ) {
    const size = v.getUint32(off + 4, true);
    if (fourcc(v, off) === FMT_ && size >= 2) return v.getUint16(off + 8, true);
    off += 8 + size + (size & 1);
  }
  return -1;
}

/**
 * Open any audio:wav.* entry (the reference decoder for the data contract):
 * 16-bit PCM becomes a view (decodeWav), IMA ADPCM an on-demand decoder
 * (decodeImaAdpcm). Anything else throws.
 */
export function openWav(bytes: Uint8Array): WavTrack {
  return wavFormat(bytes) === AUDIO_WAV_FORMAT.imaAdpcm ? decodeImaAdpcm(bytes) : decodeWav(bytes);
}

/** Interleaved s16 for frames [frame, frame + count) of either track kind, in a new array. */
function trackFrames(track: WavTrack, frame: number, count: number): Int16Array {
  if ("read" in track) return track.read(frame, count);
  const ch = track.channels;
  return track.data.slice(frame * ch, (frame + count) * ch);
}

// ---------------------------------------------------------------------------
// WavPlayer — credit-driven pump, one track at a time
// ---------------------------------------------------------------------------

/** Cap on frames converted+written per pump: bounds the per-tick copy cost
 *  (4096 stereo frames = 16 KB) while refilling a draining ring in well under
 *  its ~740 ms capacity. */
const WRITE_CHUNK_FRAMES = 4096;

export interface WavPlayerStats {
  readonly underruns: number;
}

export interface WavPlayer {
  /** Load `audio:wav.<name>` from the pak (or pass an opened track directly:
   *  PCM from decodeWav, IMA ADPCM from decodeImaAdpcm, either from openWav).
   *  Destroys the previous track's stream. False if the module is absent,
   *  the pak entry is missing, or the stream was refused. */
  load(name: string): boolean;
  loadPcm(pcm: WavTrack): boolean;
  play(): void;
  pause(): void;
  toggle(): void;
  /** Pause, flush the ring and rewind to frame 0. */
  stop(): void;
  setVolume(volume: number): void;
  /** Call once per frame (from the app's onFrame): drains this tick's event
   *  batch and feeds the ring within the credit budget. */
  pump(): void;
  playing(): boolean;
  /** Best-effort played frames: written minus still-queued (mirror math). */
  positionFrames(): number;
  durationFrames(): number;
  stats(): WavPlayerStats;
  /** Destroy the stream and drop the track. */
  dispose(): void;
}

interface AudioEvent {
  t?: string;
  h?: number;
  free?: number;
}

/**
 * Every live player by stream handle. The module namespace has ONE event
 * queue, so whichever pump drains it must hand each fact to the stream it
 * names: a player that skipped the others' events dropped them, and a music
 * player pumped after three effect voices never saw its credits and starved.
 */
const players = new Map<number, (ev: AudioEvent) => void>();

function drainEvents(ns: AudioOps): void {
  for (let line = ns.poll(); line !== undefined; line = ns.poll()) {
    let ev: AudioEvent;
    try {
      ev = JSON.parse(line) as AudioEvent;
    } catch {
      continue; // a malformed event is a host bug; skip, don't wedge the pump
    }
    if (typeof ev.h !== "number") continue;
    const onEvent = players.get(ev.h);
    if (onEvent) onEvent(ev); // a stream dropped since the tick began has no owner
  }
}

export function createWavPlayer(): WavPlayer {
  let pcm: WavTrack | null = null;
  let handle = -1;
  let cursor = 0; // frames written so far
  let free = AUDIO_RING_FRAMES; // guest mirror of ring space (credit resets it)
  let isPlaying = false;
  // Credit discipline works both ways: the host's clock starts consuming the
  // moment the stream plays, so the player never opens the tap on an empty
  // ring — play() on an unfed track is deferred until pump()'s first write
  // (one tick later at most), which is what keeps a track switch from
  // opening with a spurious underrun.
  let pendingPlay = false;
  let ended = false; // endStream sent for this track
  let volume = 1;
  let underruns = 0;

  function onEvent(ev: AudioEvent): void {
    if (ev.t === "credit" && typeof ev.free === "number") free = ev.free;
    else if (ev.t === "underrun") underruns++;
    else if (ev.t === "ended") isPlaying = false;
  }

  function dropStream(): void {
    const ns = audioHost();
    if (handle >= 0) {
      players.delete(handle);
      if (ns) ns.destroyStream(handle);
    }
    handle = -1;
  }

  function loadPcm(next: WavTrack): boolean {
    dropStream();
    pcm = next;
    cursor = 0;
    free = AUDIO_RING_FRAMES;
    ended = false;
    pendingPlay = isPlaying; // fresh ring is empty: play after the first feed
    const ns = audioHost();
    if (!ns) return false;
    handle = ns.createStream(next.sampleRate, next.channels);
    if (handle < 0) return false;
    players.set(handle, onEvent);
    ns.setVolume(handle, volume);
    return true;
  }

  function play(): void {
    isPlaying = true;
    const ns = audioHost();
    if (!ns || handle < 0) return;
    if (cursor > 0) ns.play(handle);
    else pendingPlay = true; // pump() opens the tap after it pours
  }

  function pause(): void {
    isPlaying = false;
    pendingPlay = false;
    const ns = audioHost();
    if (ns && handle >= 0) ns.pause(handle);
  }

  return {
    load(name: string): boolean {
      if (!hasPack()) return false;
      let bytes: Uint8Array;
      try {
        bytes = pakGet(AUDIO_PAK_WAV_PREFIX + name);
      } catch {
        return false; // asset not shipped (e.g. a pakless legacy build)
      }
      return loadPcm(openWav(bytes));
    },
    loadPcm,
    play,
    pause,
    toggle(): void {
      if (isPlaying) pause();
      else play();
    },
    stop(): void {
      isPlaying = false;
      pendingPlay = false;
      cursor = 0;
      free = AUDIO_RING_FRAMES; // stop flushes the ring; credit will confirm
      ended = false;
      const ns = audioHost();
      if (ns && handle >= 0) ns.stop(handle);
    },
    setVolume(v: number): void {
      volume = v < 0 ? 0 : v > 1 ? 1 : v;
      const ns = audioHost();
      if (ns && handle >= 0) ns.setVolume(handle, volume);
    },
    pump(): void {
      const ns = audioHost();
      if (!ns || handle < 0 || !pcm) return;
      drainEvents(ns);
      if (!isPlaying || cursor >= pcm.frames) return;
      const want = Math.min(free, pcm.frames - cursor, WRITE_CHUNK_FRAMES);
      if (want > 0) {
        const slice = trackFrames(pcm, cursor, want);
        const accepted = ns.writePcm(handle, slice.buffer as ArrayBuffer);
        cursor += accepted;
        free -= accepted;
      }
      if (pendingPlay && cursor > 0) {
        pendingPlay = false;
        ns.play(handle);
      }
      if (cursor >= pcm.frames && !ended) {
        ended = true;
        ns.endStream(handle);
      }
    },
    playing: () => isPlaying,
    positionFrames(): number {
      const queued = AUDIO_RING_FRAMES - free;
      const played = cursor - queued;
      return played < 0 ? 0 : played;
    },
    durationFrames: () => (pcm ? pcm.frames : 0),
    stats: () => ({ underruns }),
    dispose(): void {
      dropStream();
      pcm = null;
      isPlaying = false;
    },
  };
}

// ---------------------------------------------------------------------------
// AudioInput — audio.capture, drained by the guest each tick
// ---------------------------------------------------------------------------

export interface AudioInput {
  readonly sampleRate: number;
  readonly channels: number;
  /** Copy the oldest captured frames into `into` (interleaved s16); returns
   *  the frames copied, 0 when nothing is waiting or the input is closed. */
  read(into: Int16Array): number;
  close(): void;
}

/** The host records from its inputs (audio.capture). */
export function audioCanCapture(): boolean {
  const ns = audioHost();
  return typeof ns?.openInput === "function" && typeof ns.readInput === "function" &&
    typeof ns.closeInput === "function";
}

/** Start recording `source`; null when the host lacks capture or refused the
 *  format or source. */
export function openAudioInput(
  source: AudioInputSource,
  sampleRate: number = AUDIO_RATES[1],
  channels = 1,
): AudioInput | null {
  const ns = audioHost();
  if (!ns || !audioCanCapture()) return null;
  if (!(AUDIO_RATES as readonly number[]).includes(sampleRate)) return null;
  if (channels < 1 || channels > AUDIO_MAX_CHANNELS) return null;
  const handle = ns.openInput!(sampleRate, channels, AUDIO_INPUT_SOURCE[source]);
  if (handle < 0) return null;
  let open = true;
  return {
    sampleRate,
    channels,
    read(into: Int16Array): number {
      if (!open) return 0;
      // The host fills a whole ArrayBuffer; a view into a larger buffer
      // reads through a scratch buffer of its own size.
      const whole = into.byteOffset === 0 && into.byteLength === into.buffer.byteLength;
      const target = whole ? into : new Int16Array(into.length);
      const frames = ns.readInput!(handle, target.buffer as ArrayBuffer);
      if (frames <= 0) return 0;
      if (!whole) into.set(target.subarray(0, frames * channels));
      return frames;
    },
    close(): void {
      if (!open) return;
      open = false;
      ns.closeInput!(handle);
    },
  };
}
