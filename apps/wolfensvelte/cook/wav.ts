// apps/wolfensvelte/cook/wav.ts — WAV conversion for the asset cooker.
//
// The Wolfensvelte sound effects are 8-bit unsigned mono PCM at 7042 Hz. The
// PocketJS audio contract (contracts/spec/audio.ts) accepts 16-bit PCM at
// 44100/22050/11025 Hz only, so each effect is resampled to 11025 Hz s16 mono.

export interface Pcm {
  readonly sampleRate: number;
  /** Mono samples in -1..1. */
  readonly samples: Float32Array;
}

export function decodeWavAny(bytes: Uint8Array, label = "wav"): Pcm {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (off: number) => String.fromCharCode(bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3]);
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error(`${label}: not a RIFF/WAVE file`);
  let channels = 0;
  let sampleRate = 0;
  let bits = 0;
  let format = 0;
  let dataOff = -1;
  let dataLen = 0;
  for (let off = 12; off + 8 <= bytes.length; ) {
    const id = tag(off);
    const size = v.getUint32(off + 4, true);
    if (id === "fmt ") {
      format = v.getUint16(off + 8, true);
      channels = v.getUint16(off + 10, true);
      sampleRate = v.getUint32(off + 12, true);
      bits = v.getUint16(off + 22, true);
    } else if (id === "data") {
      dataOff = off + 8;
      dataLen = Math.min(size, bytes.length - dataOff);
    }
    off += 8 + size + (size & 1);
  }
  if (format !== 1) throw new Error(`${label}: only PCM WAVs are supported (format ${format})`);
  if (dataOff < 0) throw new Error(`${label}: WAV has no data chunk`);
  const bytesPerSample = bits >> 3;
  const frames = Math.floor(dataLen / (bytesPerSample * channels));
  const samples = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let acc = 0;
    for (let c = 0; c < channels; c++) {
      const p = dataOff + (i * channels + c) * bytesPerSample;
      if (bits === 8) acc += (bytes[p] - 128) / 128;
      else if (bits === 16) acc += v.getInt16(p, true) / 32768;
      else throw new Error(`${label}: ${bits}-bit WAV not supported`);
    }
    samples[i] = acc / channels;
  }
  return { sampleRate, samples };
}

/** Linear-interpolation resampler; adequate for 7 kHz effects going to 11 kHz. */
export function resample(pcm: Pcm, targetRate: number): Pcm {
  if (pcm.sampleRate === targetRate) return pcm;
  const ratio = pcm.sampleRate / targetRate;
  const frames = Math.floor(pcm.samples.length / ratio);
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, pcm.samples.length - 1);
    const t = pos - i0;
    out[i] = pcm.samples[i0] * (1 - t) + pcm.samples[i1] * t;
  }
  return { sampleRate: targetRate, samples: out };
}

export function encodeWav16Mono(pcm: Pcm): Uint8Array {
  const frames = pcm.samples.length;
  const out = new Uint8Array(44 + frames * 2);
  const v = new DataView(out.buffer);
  const put = (off: number, s: string) => {
    for (let i = 0; i < 4; i++) out[off + i] = s.charCodeAt(i);
  };
  put(0, "RIFF");
  v.setUint32(4, 36 + frames * 2, true);
  put(8, "WAVE");
  put(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, pcm.sampleRate, true);
  v.setUint32(28, pcm.sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  put(36, "data");
  v.setUint32(40, frames * 2, true);
  for (let i = 0; i < frames; i++) {
    const s = Math.max(-1, Math.min(1, pcm.samples[i]));
    v.setInt16(44 + i * 2, Math.round(s * 32767), true);
  }
  return out;
}
