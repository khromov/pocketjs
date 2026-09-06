<script lang="ts">
  // The 3DS bottom screen: the status bar at 1:1 across the top, the E1M1
  // overview with the player marker, and three tappable weapon buttons.
  // Mounted only where hasAuxiliarySurface() is true; AuxiliarySurface throws
  // on hosts without a second display.
  //
  // The buttons read raw auxiliary contacts rather than onPress: a tap only
  // presses a focusable node, and a focusable button would also join d-pad
  // focus, where CIRCLE is the use action.
  import { AuxiliarySurface, Image, View } from "@pocketjs/framework/svelte/components";
  import { auxiliaryTouches } from "@pocketjs/framework/svelte/input";
  import { WEAPON_KNIFE, WEAPON_PISTOL, WEAPON_SMG } from "../game/constants.ts";
  import Hud from "./Hud.svelte";
  import LevelMap from "./LevelMap.svelte";

  interface Props {
    health: number;
    ammo: number;
    score: number;
    lives: number;
    weapon: number;
    hasSmg: boolean;
    faceFrame: number;
    onSelectWeapon: (weapon: number) => void;
  }
  let { health, ammo, score, lives, weapon, hasSmg, faceFrame, onSelectWeapon }: Props = $props();

  const BUTTON_LEFT = 212;
  const BUTTON_W = 100;
  const BUTTON_H = 52;
  const BUTTONS = [
    { weapon: WEAPON_KNIFE, icon: "art/hud-weapon-knife.png", top: 52 },
    { weapon: WEAPON_PISTOL, icon: "art/hud-weapon-pistol.png", top: 116 },
    { weapon: WEAPON_SMG, icon: "art/hud-weapon-smg.png", top: 180 },
  ];

  let map: LevelMap | undefined = $state();
  let seen = new Set<number>();

  export function update(px: number, py: number): void {
    map?.update(px, py);
  }

  /** Once per frame: a contact's down edge inside a button selects that weapon. */
  export function pollTouch(): void {
    const contacts = auxiliaryTouches();
    const live = new Set<number>();
    for (const c of contacts) {
      live.add(c.id);
      if (seen.has(c.id)) continue;
      if (c.x < BUTTON_LEFT || c.x >= BUTTON_LEFT + BUTTON_W) continue;
      for (const b of BUTTONS) {
        if (c.y >= b.top && c.y < b.top + BUTTON_H) onSelectWeapon(b.weapon);
      }
    }
    seen = live;
  }
</script>

<AuxiliarySurface>
  <View debugName="BottomScreen" class="w-full h-full bg-[#004141]">
    <Hud {health} {ammo} {score} {lives} {weapon} {faceFrame} scale={1} />
    <LevelMap bind:this={map} x={8} y={44} />
    {#each BUTTONS as b (b.weapon)}
      <View
        debugName="WeaponButton"
        class={b.weapon === weapon
          ? "absolute rounded-md bg-[#8a2b2b] border border-[#e0c040]"
          : b.weapon === WEAPON_SMG && !hasSmg
            ? "absolute rounded-md bg-[#0d2a2a]"
            : "absolute rounded-md bg-[#1f5252] border border-[#3f8a8a]"}
        style={{ insetL: BUTTON_LEFT, insetT: b.top, width: BUTTON_W, height: BUTTON_H }}
      >
        <Image
          src={b.icon}
          style={{
            posType: 1,
            insetL: 14,
            insetT: 8,
            width: 64,
            height: 32,
            originX: -0.5,
            originY: -0.5,
            scale: 1.5,
            opacity: b.weapon === WEAPON_SMG && !hasSmg ? 0.3 : 1,
          }}
        />
      </View>
    {/each}
  </View>
</AuxiliarySurface>
