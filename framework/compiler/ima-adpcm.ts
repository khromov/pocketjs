// framework/compiler/ima-adpcm.ts — build-time IMA ADPCM WAV encoder.
//
// Writes the second audio:wav.* shape contracts/spec/audio.ts accepts
// (audioFormat 0x11, 4 bits a sample, the Microsoft/DVI block layout), which
// framework/src/audio-api.ts decodeImaAdpcm expands block by block on the
// console. Each sample is quantized with the same shift-and-add rule the
// decoder expands, so the encoder's predictor tracks the decoder's exactly;
// a block header restarts the predictor from the true sample and carries the
// step index over from the previous block. A frame is 4 bits a channel, so a
// 16-bit PCM track shrinks to a little over a quarter of its size.

import { AUDIO_IMA_INDEX, AUDIO_IMA_STEP, AUDIO_WAV_FORMAT } from "../../contracts/spec/audio.ts";

/** Bytes a block per channel when the caller does not choose: 2041 frames a block. */
export const IMA_ADPCM_BLOCK_BYTES_PER_CHANNEL = 1024;

interface ChannelState {
  predictor: number;
  index: number;
}

/** Quantize `target` against `state` into a 4-bit code and advance the state as the decoder will. */
function encodeSample(target: number, state: ChannelState): number {
  const step = AUDIO_IMA_STEP[state.index]!;
  let diff = target - state.predictor;
  let code = 0;
  if (diff < 0) {
    code = 8;
    diff = -diff;
  }
  let delta = step >> 3;
  if (diff >= step) {
    code |= 4;
    diff -= step;
    delta += step;
  }
  if (diff >= step >> 1) {
    code |= 2;
    diff -= step >> 1;
    delta += step >> 1;
  }
  if (diff >= step >> 2) {
    code |= 1;
    delta += step >> 2;
  }
  let predictor = code & 8 ? state.predictor - delta : state.predictor + delta;
  if (predictor > 32767) predictor = 32767;
  else if (predictor < -32768) predictor = -32768;
  let index = state.index + AUDIO_IMA_INDEX[code]!;
  if (index < 0) index = 0;
  else if (index > 88) index = 88;
  state.predictor = predictor;
  state.index = index;
  return code;
}

/** Magnitudes the search tries on either side of the plain quantizer's. */
const REACH = 1;

/** The code the plain quantizer picks for `target` from (predictor, index). */
function greedyCode(target: number, predictor: number, index: number): number {
  const step = AUDIO_IMA_STEP[index]!;
  let diff = target - predictor;
  let code = 0;
  if (diff < 0) {
    code = 8;
    diff = -diff;
  }
  if (diff >= step) {
    code |= 4;
    diff -= step;
  }
  if (diff >= step >> 1) {
    code |= 2;
    diff -= step >> 1;
  }
  if (diff >= step >> 2) code |= 1;
  return code;
}

/**
 * Beam search over code sequences for `targets` (one channel of one block,
 * after its header sample): keeps the `width` decoder states with the least
 * squared error so far, extending each by the plain quantizer's magnitude, the
 * magnitudes REACH either side of it and, near zero, the other sign; paths
 * that reach the same (predictor, step index) merge. The plain quantizer picks each code for the sample in front of it;
 * the search gives up a little error now when the step-size adaptation it
 * buys pays back later (an attack after a quiet passage). Returns the codes
 * and advances `state` to the end state of the best path.
 */
function searchCodes(targets: Int32Array, state: ChannelState, width: number): Uint8Array {
  const steps = targets.length;
  const codes = new Uint8Array(steps);
  if (steps === 0) return codes;
  const most = width * (2 * REACH + 3);
  let pred = new Int32Array(width), idx = new Int32Array(width), err = new Float64Array(width);
  let nPred = new Int32Array(width), nIdx = new Int32Array(width), nErr = new Float64Array(width);
  pred[0] = state.predictor;
  idx[0] = state.index;
  let size = 1;
  const parent = new Uint16Array(steps * width), chosen = new Uint8Array(steps * width);
  const cPred = new Int32Array(most), cIdx = new Int32Array(most), cErr = new Float64Array(most);
  const cParent = new Uint16Array(most), cCode = new Uint8Array(most);
  const order = new Uint32Array(most);
  const slot = new Map<number, number>();
  for (let t = 0; t < steps; t++) {
    const target = targets[t]!;
    slot.clear();
    let count = 0;
    for (let j = 0; j < size; j++) {
      const p0 = pred[j]!, i0 = idx[j]!, e0 = err[j]!;
      const step = AUDIO_IMA_STEP[i0]!;
      const greedy = greedyCode(target, p0, i0);
      const magnitude = greedy & 7;
      // Magnitudes within REACH of the plain quantizer's, with its sign; near
      // zero also the other sign (a small step either way).
      for (let n = 0; n < 2 * REACH + 3; n++) {
        let m: number, sign: number;
        if (n <= 2 * REACH) {
          m = magnitude - REACH + n;
          sign = greedy & 8;
        } else {
          m = n - 2 * REACH - 1;
          sign = (greedy & 8) ^ 8;
          if (magnitude > REACH) break;
        }
        if (m < 0 || m > 7) continue;
        let delta = step >> 3;
        if (m & 4) delta += step;
        if (m & 2) delta += step >> 1;
        if (m & 1) delta += step >> 2;
        let p = sign ? p0 - delta : p0 + delta;
        if (p > 32767) p = 32767;
        else if (p < -32768) p = -32768;
        let i = i0 + AUDIO_IMA_INDEX[m]!;
        if (i < 0) i = 0;
        else if (i > 88) i = 88;
        const e = e0 + (target - p) * (target - p);
        const key = ((p + 32768) << 7) | i;
        const at = slot.get(key);
        if (at === undefined) {
          slot.set(key, count);
          cPred[count] = p;
          cIdx[count] = i;
          cErr[count] = e;
          cParent[count] = j;
          cCode[count] = sign | m;
          count++;
        } else if (e < cErr[at]!) {
          cErr[at] = e;
          cParent[at] = j;
          cCode[at] = sign | m;
        }
      }
    }
    for (let c = 0; c < count; c++) order[c] = c;
    if (count > width) order.subarray(0, count).sort((a, b) => cErr[a]! - cErr[b]!);
    size = Math.min(width, count);
    for (let k = 0; k < size; k++) {
      const c = order[k]!;
      nPred[k] = cPred[c]!;
      nIdx[k] = cIdx[c]!;
      nErr[k] = cErr[c]!;
      parent[t * width + k] = cParent[c]!;
      chosen[t * width + k] = cCode[c]!;
    }
    [pred, nPred] = [nPred, pred];
    [idx, nIdx] = [nIdx, idx];
    [err, nErr] = [nErr, err];
  }
  let best = 0;
  for (let k = 1; k < size; k++) if (err[k]! < err[best]!) best = k;
  state.predictor = pred[best]!;
  state.index = idx[best]!;
  for (let t = steps - 1, node = best; t >= 0; t--) {
    codes[t] = chosen[t * width + node]!;
    node = parent[t * width + node]!;
  }
  return codes;
}

export interface ImaAdpcmOptions {
  /** Bytes a block; whole 4-byte groups per channel after the headers. */
  blockAlign?: number;
  /** Beam width of the code search; 1 is the plain greedy quantizer. */
  search?: number;
}

/**
 * Encode interleaved s16 `samples` as a complete IMA ADPCM RIFF/WAVE file.
 * `blockAlign` must leave whole 4-byte groups per channel after the
 * 4-byte-per-channel headers. The last block stops after the 8-sample group
 * that holds the final frame; the `fact` chunk records the exact frame count.
 */
export function encodeImaAdpcmWav(
  samples: Int16Array,
  sampleRate: number,
  channels: number,
  options: ImaAdpcmOptions = {},
): Uint8Array {
  const blockAlign = options.blockAlign ?? IMA_ADPCM_BLOCK_BYTES_PER_CHANNEL * channels;
  const search = options.search ?? 1;
  const header = 4 * channels;
  if (channels < 1 || channels > 2) throw new Error(`ima-adpcm: ${channels} channels (1 or 2)`);
  if (blockAlign <= header || (blockAlign - header) % header !== 0 || blockAlign > 0xffff) {
    throw new Error(`ima-adpcm: block of ${blockAlign} bytes does not fit ${channels} channel(s)`);
  }
  const perBlock = ((blockAlign - header) * 2) / channels + 1;
  if (perBlock > 0xffff) throw new Error(`ima-adpcm: ${perBlock} samples a block do not fit the fmt field`);
  const frames = Math.floor(samples.length / channels);
  const blocks = Math.ceil(frames / perBlock);

  const chunks: Uint8Array[] = [];
  let dataLen = 0;
  const states: ChannelState[] = Array.from({ length: channels }, () => ({ predictor: 0, index: 0 }));
  for (let b = 0; b < blocks; b++) {
    const first = b * perBlock;
    const count = Math.min(perBlock, frames - first);
    const groups = Math.ceil((count - 1) / 8);
    const block = new Uint8Array(header + groups * header);
    for (let c = 0; c < channels; c++) {
      const state = states[c]!;
      state.predictor = samples[first * channels + c]!;
      const h = c * 4;
      block[h] = state.predictor & 0xff;
      block[h + 1] = (state.predictor >> 8) & 0xff;
      block[h + 2] = state.index;
      block[h + 3] = 0;
      const targets = new Int32Array(count - 1);
      for (let f = 1; f < count; f++) targets[f - 1] = samples[(first + f) * channels + c]!;
      const searched = search > 1 ? searchCodes(targets, state, search) : null;
      for (let g = 0; g < groups; g++) {
        const at = header + g * header + c * 4;
        for (let k = 0; k < 8; k++) {
          const frame = 1 + g * 8 + k;
          let code: number;
          if (frame < count && searched) code = searched[frame - 1]!;
          // Past the last frame the group is padded toward the predictor (code ~0).
          else code = encodeSample(frame < count ? targets[frame - 1]! : state.predictor, state);
          block[at + (k >> 1)] |= k & 1 ? code << 4 : code;
        }
      }
    }
    chunks.push(block);
    dataLen += block.length;
  }

  const fmtSize = 20;
  const total = 12 + (8 + fmtSize) + (8 + 4) + (8 + dataLen + (dataLen & 1));
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  const tag = (at: number, text: string) => {
    for (let i = 0; i < 4; i++) out[at + i] = text.charCodeAt(i);
  };
  tag(0, "RIFF");
  view.setUint32(4, total - 8, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  view.setUint32(16, fmtSize, true);
  view.setUint16(20, AUDIO_WAV_FORMAT.imaAdpcm, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, Math.round((sampleRate * blockAlign) / perBlock), true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 4, true);
  view.setUint16(36, 2, true); // cbSize
  view.setUint16(38, perBlock, true);
  tag(40, "fact");
  view.setUint32(44, 4, true);
  view.setUint32(48, frames, true);
  tag(52, "data");
  view.setUint32(56, dataLen, true);
  let at = 60;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}
