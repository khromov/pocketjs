<script lang="ts">
  // Wolfensvelte 3D on PocketJS: the screens around one level of E1M1.
  //
  //   title -> get psyched -> playing <-> paused
  //                             |-> dying -> (lives left) get psyched | title
  //                             '-> elevator -> end -> title
  //
  // The game itself (game/game.ts) steps once per 60 Hz core tick while
  // playing; View3D draws it, Hud/BottomScreen show the vitals. The status bar
  // sits on the 3DS bottom screen and over the view everywhere else.
  //
  // Every count in game/ and here (PSYCHED_FRAMES, DEATH_FRAMES, speeds, the
  // blink) is in core ticks. A host that presents below 60 Hz runs
  // ticksPerFrame() ticks per frame and draws once at the end, so a 30 Hz
  // PSP plays the 60 Hz trajectory at the same speed (docs/DETERMINISM.md).
  import { jump } from "@pocketjs/framework/svelte/animation";
  import { Image, Text, View } from "@pocketjs/framework/svelte/components";
  import { ticksPerFrame } from "@pocketjs/framework/svelte/clock";
  import { BTN } from "@pocketjs/framework/svelte/input";
  import { onFrame } from "@pocketjs/framework/svelte/lifecycle";
  import type { NodeMirror } from "@pocketjs/framework/svelte/renderer";
  import { Music, Sfx } from "./game/audio.ts";
  import { PSYCHED_FRAMES } from "./game/constants.ts";
  import { Game } from "./game/game.ts";
  import { InputReader } from "./game/input.ts";
  import { EMPTY_INPUT } from "./game/player.ts";
  import { computeLayout } from "./render/layout.ts";
  import View3D from "./render/View3D.svelte";
  import BottomScreen from "./ui/BottomScreen.svelte";
  import Hud from "./ui/Hud.svelte";

  type Phase = "title" | "psyched" | "playing" | "paused" | "dying" | "end";

  const layout = computeLayout();
  const game = new Game();
  const reader = new InputReader();
  const sfx = new Sfx();
  const music = new Music();
  const START_LIVES = 3;
  /** Core ticks per presented frame: 1 at 60 Hz, 2 on a 30 Hz host. */
  const TICKS = ticksPerFrame();

  const titleScale = Math.min(layout.screenW / 320, layout.screenH / 200);
  const titleLeft = Math.round((layout.screenW - 320 * titleScale) / 2);
  const titleTop = Math.round((layout.screenH - 200 * titleScale) / 2);
  const psychedScale = layout.screenW >= 448 ? 1.5 : 1.25;
  const psychedW = Math.round(224 * psychedScale);
  const psychedLeft = Math.round((layout.screenW - psychedW) / 2);
  const psychedTop = Math.round(layout.screenH / 2 - 24 * psychedScale - 12);
  const endScale = 2;
  const endLeft = Math.round((layout.screenW - 104 * endScale) / 2);

  let phase = $state<Phase>("title");
  let phaseFrame = 0;
  let blink = $state(true);
  let lives = $state(START_LIVES);
  let health = $state(100);
  let ammo = $state(8);
  let score = $state(0);
  let weapon = $state(1);
  let hasSmg = $state(false);
  let faceFrame = $state(0);
  let kills = $state(0);
  let view3d: View3D | undefined = $state();
  let bottom: BottomScreen | undefined = $state();
  let psychedBar: NodeMirror | undefined;
  let prevButtons = 0;

  const totalEnemies = game.enemies.list.length;

  function syncHud(): void {
    const p = game.player;
    health = p.health;
    ammo = p.ammo;
    score = p.score;
    weapon = p.weapon;
    hasSmg = p.hasSmg;
    faceFrame = Math.floor(game.frame / 90) % 3;
    bottom?.update(p.x, p.y);
  }

  function enterPsyched(): void {
    phase = "psyched";
    phaseFrame = 0;
    psychedBar = undefined;
  }

  function newGame(): void {
    lives = START_LIVES;
    game.restart(false);
    syncHud();
    // The level track starts with the splash, as MusicManager.play(page) did.
    music.play("music-e1m1");
    enterPsyched();
  }

  /** Set by a tick that moved the game; the frame then syncs the HUD once. */
  let hudDirty = false;

  /** One core tick of the screen flow and the game. Edges come from the
   *  tick before, so a press lands on the first tick of a frame only. */
  function tick(buttons: number): void {
    const pressed = buttons & ~prevButtons;
    prevButtons = buttons;
    phaseFrame++;
    if (phaseFrame % 30 === 0) blink = !blink;

    switch (phase) {
      case "title":
        music.play("music-menu");
        if (pressed & BTN.START) newGame();
        break;
      case "psyched":
        if (phaseFrame >= PSYCHED_FRAMES) {
          phase = "playing";
          phaseFrame = 0;
          reader.reset(buttons);
        }
        break;
      case "playing": {
        if (pressed & BTN.START) {
          phase = "paused";
          break;
        }
        bottom?.pollTouch();
        game.update(reader.read(buttons));
        for (const name of game.sfx) sfx.play(name);
        game.sfx.length = 0;
        hudDirty = true;
        if (game.phase === "dying") {
          phase = "dying";
          phaseFrame = 0;
        } else if (game.phase === "won") {
          kills = totalEnemies - game.enemies.aliveCount();
          phase = "end";
          phaseFrame = 0;
        }
        break;
      }
      case "paused":
        if (pressed & BTN.START) {
          phase = "playing";
          reader.reset(buttons);
        } else if (pressed & BTN.SELECT) {
          phase = "title";
        }
        break;
      case "dying":
        game.update(EMPTY_INPUT);
        game.sfx.length = 0;
        hudDirty = true;
        if (game.phase === "dead") {
          if (lives > 0) {
            lives -= 1;
            game.restart(true);
            enterPsyched();
          } else {
            phase = "title";
          }
        }
        break;
      case "end":
        if (pressed & BTN.START) phase = "title";
        break;
    }
  }

  onFrame((buttons) => {
    sfx.pump();
    music.pump();
    for (let t = 0; t < TICKS; t++) tick(buttons);

    // Draw the state the last tick left, once per presented frame.
    if (phase === "psyched") {
      if (psychedBar) jump(psychedBar, "scaleX", Math.min(1, phaseFrame / PSYCHED_FRAMES));
    } else if (phase === "playing" || phase === "dying") {
      view3d?.render(game);
    }
    if (hudDirty) {
      hudDirty = false;
      syncHud();
    }
  });
</script>

<View
  debugName="Wolfensvelte"
  style={{ posType: 1, insetL: 0, insetT: 0, width: layout.screenW, height: layout.screenH, bgColor: "#000000", overflow: 1 }}
>
  {#if phase === "title"}
    <Image
      src="art/menu-title.png"
      style={{ posType: 1, insetL: titleLeft, insetT: titleTop, width: 512, height: 256, originX: -0.5, originY: -0.5, scale: titleScale }}
    />
    {#if blink}
      <View class="absolute w-full flex-row justify-center" style={{ insetT: layout.screenH - 26 }}>
        <Text class="text-sm text-white font-bold tracking-wide">PRESS START</Text>
      </View>
    {/if}
  {:else if phase === "psyched"}
    <View style={{ posType: 1, insetL: 0, insetT: 0, width: layout.screenW, height: layout.screenH, bgColor: "#004141" }} />
    <Image
      src="art/menu-psyched.png"
      style={{ posType: 1, insetL: psychedLeft, insetT: psychedTop, width: 256, height: 64, originX: -0.5, originY: -0.5, scale: psychedScale }}
    />
    <View style={{ posType: 1, insetL: psychedLeft, insetT: psychedTop + Math.round(48 * psychedScale) + 8, width: psychedW, height: 10, bgColor: "#00201f" }}>
      <View
        nodeRef={(n) => (psychedBar = n)}
        style={{ posType: 1, insetL: 0, insetT: 0, width: psychedW, height: 10, bgColor: "#c03030", originX: -0.5, originY: -0.5, scaleX: 0 }}
      />
    </View>
  {:else if phase === "end"}
    <Image
      src="art/menu-end.png"
      style={{ posType: 1, insetL: endLeft, insetT: 16, width: 128, height: 128, originX: -0.5, originY: -0.5, scale: endScale }}
    />
    <View class="absolute w-full flex-col items-center gap-1" style={{ insetT: 16 + 88 * endScale + 8 }}>
      <Text class="text-lg text-[#e0c040] font-bold tracking-wide">FLOOR COMPLETED</Text>
      <Text class="text-sm text-white font-bold">SCORE {score}</Text>
      <Text class="text-sm text-white font-bold">KILLS {kills} / {totalEnemies}</Text>
      {#if blink}
        <Text class="text-sm text-slate-300 font-bold tracking-wide">PRESS START</Text>
      {/if}
    </View>
  {:else}
    <View3D bind:this={view3d} {layout} />
    {#if !layout.hudOnAux}
      <View style={{ posType: 1, insetL: 0, insetT: layout.viewH, width: layout.screenW, height: layout.screenH - layout.viewH, bgColor: "#004141" }}>
        <Hud {health} {ammo} {score} {lives} {weapon} {faceFrame} scale={layout.hudScale} />
      </View>
    {/if}
    {#if phase === "paused"}
      <View
        class="absolute inset-0 flex-col items-center justify-center gap-2 bg-[#000000]"
        style={{ opacity: 0.85, width: layout.screenW, height: layout.viewH }}
      >
        <Text class="text-2xl text-white font-bold tracking-wide">PAUSED</Text>
        <Text class="text-xs text-slate-300 tracking-wide">START RESUMES  ·  SELECT QUITS</Text>
      </View>
    {/if}
  {/if}
</View>

{#if layout.hudOnAux}
  <BottomScreen
    bind:this={bottom}
    {health}
    {ammo}
    {score}
    {lives}
    {weapon}
    {hasSmg}
    {faceFrame}
    onSelectWeapon={(w) => reader.selectWeapon(w)}
  />
{/if}
