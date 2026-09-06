// Sound over the PocketJS audio module (PSP today; absent on the 3DS, where
// every call is a no-op). Effects use three round-robin voices so a shot, a
// door and a bark can overlap; music holds a fourth stream and loops. Each
// track decodes once, as a view over the pak bytes (never a copy).

import { pakView } from "@pocketjs/framework/svelte";
import { audioHost, createWavPlayer, decodeWav, type WavPcm, type WavPlayer } from "@pocketjs/framework/svelte/audio";

const VOICES = 3;
const SFX_VOLUME = 0.7;
/** helpers/music.ts WebAudioCore sets its gain to 0.5. */
const MUSIC_VOLUME = 0.5;

const cache = new Map<string, WavPcm>();
const missing = new Set<string>();

function pcmFor(name: string): WavPcm | null {
  if (missing.has(name)) return null;
  let pcm = cache.get(name);
  if (!pcm) {
    try {
      // A view, not a copy: the music tracks are megabytes, and a copy into
      // the QuickJS heap fails on the console (a failed track stays silent).
      pcm = decodeWav(pakView(`audio:wav.${name}`));
    } catch {
      missing.add(name);
      return null;
    }
    cache.set(name, pcm);
  }
  return pcm;
}

export class Sfx {
  readonly enabled: boolean;
  private readonly players: WavPlayer[] = [];
  private next = 0;

  constructor() {
    this.enabled = audioHost() !== null;
    if (!this.enabled) return;
    for (let i = 0; i < VOICES; i++) {
      const p = createWavPlayer();
      p.setVolume(SFX_VOLUME);
      this.players.push(p);
    }
  }

  play(name: string): void {
    if (!this.enabled) return;
    const pcm = pcmFor(name);
    if (!pcm) return;
    const p = this.players[this.next];
    this.next = (this.next + 1) % VOICES;
    if (p.loadPcm(pcm)) p.play();
  }

  /** Once per frame: feeds the rings within the host's credit budget. */
  pump(): void {
    for (const p of this.players) p.pump();
  }

  dispose(): void {
    for (const p of this.players) p.dispose();
    this.players.length = 0;
  }
}

/** One looping track at a time (helpers/music.ts MusicManager.play(name, loop)). */
export class Music {
  readonly enabled: boolean;
  private readonly player: WavPlayer | null;
  /** Track the app asked for. */
  private wanted = "";
  /** Track whose stream the host has accepted. */
  private started = "";

  constructor() {
    this.enabled = audioHost() !== null;
    this.player = this.enabled ? createWavPlayer() : null;
    this.player?.setVolume(MUSIC_VOLUME);
  }

  /** Ask for `name`; the stream opens on the next pump and is retried until the host accepts it. */
  play(name: string): void {
    this.wanted = name;
  }

  stop(): void {
    this.wanted = "";
    this.started = "";
    this.player?.stop();
  }

  /** Once per frame: open the wanted track, feed the ring, restart a finished pass. */
  pump(): void {
    const p = this.player;
    if (!p) return;
    if (this.wanted !== this.started) {
      const pcm = this.wanted ? pcmFor(this.wanted) : null;
      if (!pcm) {
        // Missing from the pak: give up on this name; an empty wanted stops.
        if (this.started) p.stop();
        this.started = "";
        this.wanted = "";
        return;
      }
      // A refused stream (host not ready, no free slot) is tried again next frame.
      if (!p.loadPcm(pcm)) return;
      p.play();
      this.started = this.wanted;
      return;
    }
    if (!this.started) return;
    p.pump();
    if (!p.playing()) {
      // The host reported the pass ended: stop() rewinds and flushes, play()
      // starts the next pass on the following pump.
      p.stop();
      p.play();
    }
  }

  dispose(): void {
    this.player?.dispose();
  }
}
