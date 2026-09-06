// Sound over the PocketJS audio module (PSP today; absent on the 3DS, where
// every call is a no-op). Effects use three round-robin voices so a shot, a
// door and a bark can overlap; music holds a fourth stream and loops. Each
// track decodes once from the pak, as a view over the pak bytes.

import { pakGet } from "@pocketjs/framework/svelte";
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
      pcm = decodeWav(pakGet(`audio:wav.${name}`));
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
  private current = "";

  constructor() {
    this.enabled = audioHost() !== null;
    this.player = this.enabled ? createWavPlayer() : null;
    this.player?.setVolume(MUSIC_VOLUME);
  }

  /** Start `name` from the top unless it is already the playing track. */
  play(name: string): void {
    if (!this.player || this.current === name) return;
    const pcm = pcmFor(name);
    if (!pcm) return;
    this.current = name;
    if (this.player.loadPcm(pcm)) this.player.play();
  }

  stop(): void {
    this.current = "";
    this.player?.stop();
  }

  /** Once per frame: feed the ring, and restart the track when it has ended. */
  pump(): void {
    const p = this.player;
    if (!p) return;
    p.pump();
    if (this.current && !p.playing()) {
      // The player reports the host's "ended" event; stop() rewinds and
      // flushes, play() starts the next pass on the following pump.
      p.stop();
      p.play();
    }
  }

  dispose(): void {
    this.player?.dispose();
  }
}
