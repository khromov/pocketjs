// apps/svelte-shooter/gen-music.ts — synthesize the stage theme.
//
//   bun apps/svelte-shooter/gen-music.ts     # rewrites music/theme.wav
//
// One original loop, rendered deterministically from the tables below (no
// recordings, nothing downloaded): sixteen bars of A minor at 138 BPM,
// 22 050 Hz mono s16 (contracts/spec/audio.ts rates), 27.8 s, about 1.2 MB.
// The output is committed; pak.json splices it under audio:wav.theme for the
// targets whose profile carries audio.pcm, and the build never runs this.
//
// Layers, all per-sample with phase accumulators so pitch changes are
// click-free: a four-on-the-floor kick, a noise snare on two and four,
// sixteenth hats, an octave-jumping bass on the chord root, a pulse-wave
// arpeggio with a dotted-sixteenth echo, a detuned pad, and a lead that
// enters after a four-bar intro. The last bar leads back into the first, so
// the file loops without a fade.

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SAMPLE_RATE = 22_050;
const BPM = 138;
const BARS = 16;
const BEATS = BARS * 4;
const SECONDS = (BEATS * 60) / BPM;
const SAMPLES = Math.round(SAMPLE_RATE * SECONDS);
const OUT = join(dirname(fileURLToPath(import.meta.url)), "music");

// A minor: i VI III VII, then i VI III V. Bar -> [bass root, arp notes, pad triad] as MIDI.
interface Chord {
  root: number;
  arp: readonly number[];
  pad: readonly number[];
}
const AM: Chord = { root: 45, arp: [69, 72, 76, 81], pad: [57, 60, 64] };
const F: Chord = { root: 41, arp: [65, 69, 72, 77], pad: [53, 57, 60] };
const C: Chord = { root: 48, arp: [67, 72, 76, 79], pad: [55, 60, 64] };
const G: Chord = { root: 43, arp: [67, 71, 74, 79], pad: [55, 59, 62] };
const E: Chord = { root: 40, arp: [64, 68, 71, 76], pad: [52, 56, 59] };
const PROGRESSION: readonly Chord[] = [AM, F, C, G, AM, F, C, E, AM, F, C, G, AM, F, C, E];

// The lead, as [MIDI, eighths] runs per bar; 0 = rest. Bars 1-4 are the intro.
type Phrase = readonly (readonly [number, number])[];
const LEAD: readonly Phrase[] = [
  [], [], [], [],
  [[76, 2], [72, 1], [74, 1], [76, 2], [79, 2]],
  [[81, 3], [79, 1], [76, 2], [74, 1], [72, 1]],
  [[74, 2], [76, 1], [72, 1], [71, 2], [72, 2]],
  [[74, 4], [71, 2], [67, 2]],
  [[81, 2], [76, 1], [81, 1], [83, 2], [84, 2]],
  [[81, 3], [77, 1], [76, 2], [74, 2]],
  [[76, 2], [79, 2], [84, 2], [83, 2]],
  [[80, 4], [76, 2], [71, 2]],
  [[76, 2], [72, 1], [74, 1], [76, 2], [79, 2]],
  [[81, 3], [79, 1], [76, 2], [74, 1], [72, 1]],
  [[74, 2], [76, 1], [72, 1], [71, 2], [72, 2]],
  [[74, 1], [76, 1], [79, 1], [81, 1], [83, 2], [84, 2]],
];

// Bass: eighths of the bar as octave offsets from the root (-1 = rest).
const BASS_PATTERN = [0, 0, 12, 0, 0, 7, 12, 0];

const frequency = (midi: number): number => 440 * 2 ** ((midi - 69) / 12);
const fract = (v: number): number => v - Math.floor(v);
const clamp = (v: number): number => (v < -1 ? -1 : v > 1 ? 1 : v);
const saw = (phase: number): number => 2 * fract(phase) - 1;
const pulse = (phase: number, duty: number): number => (fract(phase) < duty ? 1 : -1);
const triangle = (phase: number): number => 1 - 4 * Math.abs(fract(phase) - 0.5);

let noiseState = 0x9e3779b9;
function noise(): number {
  let x = noiseState;
  x ^= x << 13;
  x >>>= 0;
  x ^= x >>> 17;
  x ^= x << 5;
  x >>>= 0;
  noiseState = x;
  return x / 2147483648 - 1;
}

/** Per-eighth lead lookup: which note plays and where it started. */
interface LeadNote {
  midi: number;
  start: number; // eighths from the top of the piece
  len: number; // eighths
}
const leadByEighth: (LeadNote | null)[] = new Array(BEATS * 2).fill(null);
for (let bar = 0; bar < BARS; bar++) {
  let at = bar * 8;
  for (const [midi, len] of LEAD[bar] ?? []) {
    const note: LeadNote = { midi, start: at, len };
    for (let e = at; e < at + len; e++) if (midi > 0) leadByEighth[e] = note;
    at += len;
  }
}

function render(): Int16Array {
  const pcm = new Int16Array(SAMPLES);
  const out = new Float32Array(SAMPLES);
  const echoSamples = Math.round(((SAMPLE_RATE * 60) / BPM) * 0.75); // dotted eighth
  const echo = new Float32Array(echoSamples);
  let echoAt = 0;

  let bassPhase = 0;
  let leadPhase = 0;
  let arpPhase = 0;
  const padPhase = [0, 0, 0, 0, 0, 0];
  let kickPhase = 0;
  let snareTone = 0;
  let hatLp = 0;

  for (let s = 0; s < SAMPLES; s++) {
    const t = s / SAMPLE_RATE;
    const beat = (t * BPM) / 60;
    const bar = Math.floor(beat / 4) % BARS;
    const chord = PROGRESSION[bar];
    const beatPhase = fract(beat);
    const eighth = Math.floor(beat * 2);
    const eighthPhase = fract(beat * 2);
    const sixteenth = Math.floor(beat * 4);
    const sixteenthPhase = fract(beat * 4);
    const dt = 1 / SAMPLE_RATE;

    // Kick: pitch sweep from 150 Hz down to 45 Hz, every beat.
    const kickFreq = 45 + 105 * Math.exp(-beatPhase * 26);
    kickPhase += kickFreq * dt;
    const kick = Math.sin(Math.PI * 2 * kickPhase) * Math.exp(-beatPhase * 9) * (beatPhase < 0.6 ? 1 : 0);

    // Snare on beats 2 and 4: noise burst over a 180 Hz body.
    const beatInBar = Math.floor(beat) % 4;
    let snare = 0;
    if (beatInBar === 1 || beatInBar === 3) {
      snareTone += 180 * dt;
      snare = (noise() * 0.7 + Math.sin(Math.PI * 2 * snareTone) * 0.3) * Math.exp(-beatPhase * 14);
    }

    // Hats: every sixteenth, the off-eighths a little longer and brighter.
    const open = sixteenth % 4 === 2;
    const n = noise();
    hatLp += (n - hatLp) * 0.55;
    const hat = (n - hatLp) * Math.exp(-sixteenthPhase * (open ? 14 : 34)) * (open ? 1 : 0.7);

    // Bass: octave-jumping eighths on the root, saw softened by a sine.
    const bassStep = BASS_PATTERN[eighth % 8];
    const bassMidi = chord.root + bassStep;
    bassPhase += frequency(bassMidi) * dt;
    const bassEnv = Math.exp(-eighthPhase * 3.2) * 0.9 + 0.1;
    const bass = (saw(bassPhase) * 0.55 + Math.sin(Math.PI * 2 * bassPhase) * 0.45) * bassEnv;

    // Arpeggio: chord tones up and down in sixteenths, a narrow pulse.
    const arpIdx = [0, 1, 2, 3, 2, 1][sixteenth % 6];
    arpPhase += frequency(chord.arp[arpIdx]) * dt;
    const arpEnv = Math.exp(-sixteenthPhase * 6);
    const arpDry = pulse(arpPhase, 0.25) * arpEnv;

    // Pad: three detuned saws per chord tone, rounded off with a triangle.
    let pad = 0;
    for (let k = 0; k < 3; k++) {
      const f = frequency(chord.pad[k]);
      padPhase[k] += f * 0.997 * dt;
      padPhase[k + 3] += f * 1.003 * dt;
      pad += triangle(padPhase[k]) * 0.6 + saw(padPhase[k + 3]) * 0.4;
    }
    pad /= 3;
    const barPhase = fract(beat / 4);
    const padEnv = Math.min(1, barPhase * 8) * Math.min(1, (1 - barPhase) * 6 + 0.2);

    // Lead: pulse and saw with a late vibrato, attack-decay-release per note.
    const note = leadByEighth[eighth];
    let lead = 0;
    if (note) {
      const local = beat * 2 - note.start; // eighths into the note
      const vib = local > 0.6 ? Math.sin(Math.PI * 2 * 5.5 * t) * 0.35 * Math.min(1, local - 0.6) : 0;
      leadPhase += frequency(note.midi + vib / 12) * dt;
      const attack = Math.min(1, local * 40);
      const remain = note.len - local;
      const release = remain < 0.25 ? Math.max(0, remain / 0.25) : 1;
      const decay = 0.72 + 0.28 * Math.exp(-local * 2.5);
      lead = (pulse(leadPhase, 0.5) * 0.55 + saw(leadPhase) * 0.45) * attack * decay * release;
    }

    // Echo return for the arpeggio, then mix.
    const returned = echo[echoAt];
    const arp = arpDry + returned * 0.42;
    echo[echoAt] = arpDry + returned * 0.3;
    echoAt = (echoAt + 1) % echoSamples;

    const value =
      kick * 0.42 + snare * 0.26 + hat * 0.07 + bass * 0.3 + arp * 0.09 + pad * 0.085 * padEnv + lead * 0.23;
    out[s] = value;
  }

  // Soft clip and normalise to a 0.84 peak. A 5 ms ramp at each end keeps
  // the wrap from the last sample to the first click-free.
  const edge = Math.round(SAMPLE_RATE * 0.005);
  let peak = 0;
  for (let s = 0; s < SAMPLES; s++) {
    const ramp = Math.min(1, s / edge, (SAMPLES - 1 - s) / edge);
    out[s] = Math.tanh(out[s] * 1.15) * ramp;
    const a = Math.abs(out[s]);
    if (a > peak) peak = a;
  }
  const gain = 0.84 / peak;
  for (let s = 0; s < SAMPLES; s++) pcm[s] = Math.round(clamp(out[s] * gain) * 32767);
  return pcm;
}

function wavBytes(pcm: Int16Array): Uint8Array {
  const bytes = new Uint8Array(44 + pcm.byteLength);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, value: string): void => {
    for (let i = 0; i < value.length; i++) bytes[offset + i] = value.charCodeAt(i);
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + pcm.byteLength, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, pcm.byteLength, true);
  for (let i = 0; i < pcm.length; i++) view.setInt16(44 + i * 2, pcm[i], true);
  return bytes;
}

mkdirSync(OUT, { recursive: true });
const pcm = render();
await Bun.write(join(OUT, "theme.wav"), wavBytes(pcm));
let rms = 0;
for (let i = 0; i < pcm.length; i++) rms += (pcm[i] / 32767) ** 2;
console.log(
  `theme.wav: ${BARS} bars at ${BPM} BPM, ${SECONDS.toFixed(1)} s, ${SAMPLE_RATE} Hz mono s16, ` +
    `${((44 + pcm.byteLength) / 1024).toFixed(0)} KB, rms ${Math.sqrt(rms / pcm.length).toFixed(3)}`,
);
