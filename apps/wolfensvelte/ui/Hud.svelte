<script lang="ts">
  // The 320x40 status bar (sprites/hud/main.BMP) with its fields at the
  // classic offsets: floor, score, lives, face, health, ammo, weapon. Drawn in
  // bar space and scaled as a whole by the caller (x1.5 on a 480-wide screen,
  // x1 on the 3DS bottom screen).
  import { Image, View } from "@pocketjs/framework/svelte/components";
  import HudDigits from "./HudDigits.svelte";

  const FACES: Record<string, string[]> = {
    full: ["art/face-full-0.png", "art/face-full-1.png", "art/face-full-2.png"],
    beat_up: ["art/face-beat_up-0.png", "art/face-beat_up-1.png", "art/face-beat_up-2.png"],
    hurt: ["art/face-hurt-0.png", "art/face-hurt-1.png", "art/face-hurt-2.png"],
    low_hp: ["art/face-low_hp-0.png", "art/face-low_hp-1.png", "art/face-low_hp-2.png"],
    dying: ["art/face-dying-0.png", "art/face-dying-1.png", "art/face-dying-2.png"],
    near_death: ["art/face-near_death-0.png", "art/face-near_death-1.png", "art/face-near_death-2.png"],
    dead: ["art/face-dead-0.png"],
  };
  const BANDS = ["full", "beat_up", "hurt", "low_hp", "dying", "near_death", "near_death"];
  const WEAPONS = ["art/hud-weapon-knife.png", "art/hud-weapon-pistol.png", "art/hud-weapon-smg.png"];

  interface Props {
    health: number;
    ammo: number;
    score: number;
    lives: number;
    weapon: number;
    /** Advances every 1.5 s; picks one of the band's three portraits. */
    faceFrame: number;
    level?: number;
    scale?: number;
  }
  let { health, ammo, score, lives, weapon, faceFrame, level = 1, scale = 1 }: Props = $props();

  const face = $derived.by(() => {
    if (health <= 0) return FACES.dead[0];
    const band = BANDS[Math.min(6, Math.floor((100 - health) / 16))];
    const frames = FACES[band];
    return frames[faceFrame % frames.length];
  });
</script>

<View
  debugName="StatusBar"
  style={{ posType: 1, insetL: 0, insetT: 0, width: 320, height: 40, originX: -0.5, originY: -0.5, scale }}
>
  <Image src="art/hud-bar.png" style={{ posType: 1, insetL: 0, insetT: 0, width: 512, height: 64 }} />
  <HudDigits value={level} digits={2} x={16} />
  <HudDigits value={score} digits={6} x={48} />
  <HudDigits value={lives} digits={1} x={112} />
  <Image src={face} style={{ posType: 1, insetL: 136, insetT: 4, width: 32, height: 32 }} />
  <HudDigits value={health} digits={3} x={168} />
  <HudDigits value={ammo} digits={3} x={208} />
  <Image src={WEAPONS[weapon]} style={{ posType: 1, insetL: 256, insetT: 8, width: 64, height: 32 }} />
</View>
