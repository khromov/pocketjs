// IMA ADPCM, the second audio:wav.* shape (contracts/spec/audio.ts): the
// build-time encoder (framework/compiler/ima-adpcm.ts) against the guest's
// block decoder (framework/src/audio-api.ts decodeImaAdpcm), the WavPlayer
// path through the sim sink, and, where ffmpeg is installed, an independent
// decoder (ffmpeg's adpcm_ima_wav) sample for sample.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeImaAdpcm, openWav, createWavPlayer, type WavStream } from "../framework/src/audio-api.ts";
import { encodeImaAdpcmWav } from "../framework/compiler/ima-adpcm.ts";
import { createSimAudioSink } from "../platforms/sim/audio.ts";

/** Deterministic music-like test signal: two tones, a sweep and noise. */
function signal(frames: number, channels: number, rate: number): Int16Array {
  const out = new Int16Array(frames * channels);
  let seed = 12345;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      seed = (seed * 1103515245 + 12345) >>> 0;
      const t = i / rate;
      const v =
        9000 * Math.sin(2 * Math.PI * (220 + 110 * c) * t) +
        5000 * Math.sin(2 * Math.PI * (440 + 300 * t) * t) +
        ((seed >>> 16) % 1200) - 600;
      out[i * channels + c] = Math.max(-32768, Math.min(32767, Math.round(v)));
    }
  }
  return out;
}

function snrDb(reference: Int16Array, decoded: Int16Array): number {
  let s = 0;
  let n = 0;
  for (let i = 0; i < reference.length; i++) {
    s += reference[i]! * reference[i]!;
    const e = reference[i]! - decoded[i]!;
    n += e * e;
  }
  return 10 * Math.log10(s / Math.max(1, n));
}

describe("IMA ADPCM WAV", () => {
  for (const channels of [1, 2]) {
    test(`round-trips ${channels} channel(s) with the exact frame count and a ~4:1 size`, () => {
      const frames = 11025 * 3 + 777; // a short last block
      const pcm = signal(frames, channels, 11025);
      const wav = encodeImaAdpcmWav(pcm, 11025, channels);
      expect(wav.length).toBeLessThan(pcm.byteLength / 3.8);
      const track = decodeImaAdpcm(wav);
      expect(track).toMatchObject({ sampleRate: 11025, channels, frames });
      const all = track.read(0, frames);
      expect(all.length).toBe(frames * channels);
      expect(snrDb(pcm, all)).toBeGreaterThan(20);
      // Every block restarts from the exact sample in its header.
      const perBlock = ((1024 * channels - 4 * channels) * 2) / channels + 1;
      for (let b = 0; b * perBlock < frames; b++) {
        for (let c = 0; c < channels; c++) expect(all[b * perBlock * channels + c]).toBe(pcm[b * perBlock * channels + c]);
      }
    });
  }

  test("any chunking of reads matches one read, across block boundaries", () => {
    const frames = 9000;
    const track = decodeImaAdpcm(encodeImaAdpcmWav(signal(frames, 2, 22050), 22050, 2, { blockAlign: 256 }));
    const whole = track.read(0, frames);
    const pieces: number[] = [];
    for (let f = 0, step = 1; f < frames; f += step, step = (step * 7 + 3) % 977 || 1) {
      pieces.push(...track.read(f, Math.min(step, frames - f)));
    }
    expect(Int16Array.from(pieces)).toEqual(new Int16Array(whole));
    // A read past the end stops at the last frame (the rest stays zero).
    expect(track.read(frames - 2, 10).subarray(0, 4)).toEqual(whole.subarray((frames - 2) * 2));
  });

  test("openWav picks the decoder from the fmt chunk", () => {
    const adpcm = openWav(encodeImaAdpcmWav(signal(100, 1, 44100), 44100, 1));
    expect("read" in adpcm).toBe(true);
    const pcmBytes = encodeImaAdpcmWav(signal(10, 1, 44100), 44100, 1); // reuse the header shape
    pcmBytes.set([1, 0], 20); // audioFormat 1 with 4 bits a sample: decodeWav refuses it
    expect(() => openWav(pcmBytes)).toThrow("16-bit PCM");
  });

  test("refuses what the contract refuses", () => {
    const good = () => encodeImaAdpcmWav(signal(3000, 1, 11025), 11025, 1);
    const bits = good();
    bits.set([8, 0], 34); // bitsPerSample 8
    expect(() => decodeImaAdpcm(bits)).toThrow("4-bit IMA ADPCM");
    const rate = good();
    new DataView(rate.buffer).setUint32(24, 8000, true);
    expect(() => decodeImaAdpcm(rate)).toThrow("not in");
    const declared = good();
    new DataView(declared.buffer).setUint16(38, 1000, true);
    expect(() => decodeImaAdpcm(declared)).toThrow("declares 1000");
    const index = good();
    index[60 + 2] = 89; // first block's step index
    expect(() => decodeImaAdpcm(index).read(0, 1)).toThrow("step index 89");
  });

  test("a WavPlayer streams it exactly as it streams the decoded PCM", () => {
    const frames = 22050 * 2 + 123;
    const bytes = encodeImaAdpcmWav(signal(frames, 1, 22050), 22050, 1);
    const run = (track: Parameters<ReturnType<typeof createWavPlayer>["loadPcm"]>[0]) => {
      const sink = createSimAudioSink();
      (globalThis as Record<string, unknown>).audio = sink.ns;
      try {
        const player = createWavPlayer();
        expect(player.loadPcm(track)).toBe(true);
        player.play();
        for (let t = 0; t < 200; t++) {
          player.pump();
          sink.tick();
        }
        player.pump();
        return { hash: sink.pcmHash(), consumed: sink.consumedFrames(), log: sink.log, playing: player.playing() };
      } finally {
        delete (globalThis as Record<string, unknown>).audio;
      }
    };
    const streamed = run(decodeImaAdpcm(bytes));
    const stream = decodeImaAdpcm(bytes) as WavStream;
    const decoded = run({ sampleRate: 22050, channels: 1, frames, data: stream.read(0, frames) });
    expect(streamed.consumed).toBe(frames);
    expect(streamed.playing).toBe(false);
    expect(streamed).toEqual(decoded);
  });

  test("the code search never does worse than the plain quantizer", () => {
    for (const channels of [1, 2]) {
      const frames = 11025 + 333;
      const pcm = signal(frames, channels, 11025);
      const snr = (search: number) =>
        snrDb(pcm, decodeImaAdpcm(encodeImaAdpcmWav(pcm, 11025, channels, { blockAlign: 256 * channels, search })).read(0, frames));
      const plain = snr(1);
      expect(snr(4)).toBeGreaterThanOrEqual(plain);
      expect(snr(16)).toBeGreaterThanOrEqual(snr(4) - 0.05);
    }
  });
});

const ffmpeg = Bun.which("ffmpeg");
describe.skipIf(!ffmpeg)("IMA ADPCM WAV against ffmpeg's decoder", () => {
  for (const [channels, blockAlign, search] of [[1, 1024, 1], [2, 2048, 1], [1, 260, 1], [1, 1024, 16], [2, 512, 8]] as const) {
    test(`${channels} channel(s), ${blockAlign}-byte blocks, search ${search}: identical samples`, () => {
      const frames = 22050 * 2 + 401;
      const wav = encodeImaAdpcmWav(signal(frames, channels, 22050), 22050, channels, { blockAlign, search });
      const dir = mkdtempSync(join(tmpdir(), "pocketjs-ima-"));
      try {
        writeFileSync(join(dir, "in.wav"), wav);
        const run = Bun.spawnSync([ffmpeg!, "-v", "error", "-i", join(dir, "in.wav"), "-f", "s16le", "-acodec", "pcm_s16le", join(dir, "out.raw")]);
        expect(run.exitCode).toBe(0);
        const raw = readFileSync(join(dir, "out.raw"));
        const theirs = new Int16Array(raw.buffer, raw.byteOffset, Math.floor(raw.length / 2));
        const ours = decodeImaAdpcm(wav).read(0, frames);
        expect(theirs.length).toBeGreaterThanOrEqual(ours.length);
        expect(theirs.subarray(0, ours.length)).toEqual(new Int16Array(ours));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
