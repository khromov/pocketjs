<script lang="ts">
  // The playfield: every sprite the game can show, pooled once, moved by the
  // presenter each frame. Input is decoded here and handed to the headless
  // game (game/step.ts); the game's event bits drive sounds, tweens and the
  // HUD store on the way back.
  import { onMount } from "svelte";
  import { setTextContent } from "@pocketjs/framework/svelte";
  import { animate, jump } from "@pocketjs/framework/svelte/animation";
  import { Image, Text, View } from "@pocketjs/framework/svelte/components";
  import type { NodeMirror } from "@pocketjs/framework/svelte/components";
  import { BTN } from "@pocketjs/framework/svelte/input";
  import { analogX, analogY, onButtonPress, onFrame } from "@pocketjs/framework/svelte/lifecycle";
  import {
    EV_BOMB,
    EV_BOSS_ENTER,
    EV_BOSS_HP,
    EV_HIT,
    EV_HUD,
    EV_KILL,
    EV_MODE,
    EV_PHASE,
    EV_PLAYER_HIT,
    EV_SHOT,
    KIND_SLOTS,
    MAX_FX,
    MAX_PBULLETS,
    MODE_CLEAR,
    MODE_OVER,
    MODE_PAUSE,
    MODE_PLAY,
    TYPE_SLOTS,
  } from "./game/constants.ts";
  import type { Game } from "./game/state.ts";
  import { restart, stepGame, togglePause, useBomb, type Input } from "./game/step.ts";
  import { hud, refs, syncHud } from "./hud.svelte.ts";
  import { buildPresenter, type Presenter } from "./present.ts";
  import {
    SFX_BOMB,
    SFX_CLEAR,
    SFX_DEATH,
    SFX_EXPLODE,
    SFX_HIT,
    SFX_PHASE,
    SFX_SHOT,
    createSfx,
  } from "./sfx.ts";

  let { game, w, h }: { game: Game; w: number; h: number } = $props();

  const range = (n: number, from = 0): number[] => Array.from({ length: n }, (_, i) => from + i);
  // Slot ranges mirror the pool partitions: one texture per kind and type.
  const RED = range(KIND_SLOTS[0]);
  const BLUE = range(KIND_SLOTS[1], KIND_SLOTS[0]);
  const GREEN = range(KIND_SLOTS[2], KIND_SLOTS[0] + KIND_SLOTS[1]);
  const SHOTS = range(MAX_PBULLETS);
  const DRONES = range(TYPE_SLOTS[0]);
  const GUNSHIPS = range(TYPE_SLOTS[1], TYPE_SLOTS[0]);
  const HEAVIES = range(TYPE_SLOTS[2], TYPE_SLOTS[0] + TYPE_SLOTS[1]);
  const FX = range(MAX_FX);
  /** The starfield tile is a square the width of the field, scrolled and wrapped. */
  const tile = w;

  const ebNodes: (NodeMirror | undefined)[] = new Array(game.eb.n);
  const pbNodes: (NodeMirror | undefined)[] = new Array(game.pb.n);
  const enNodes: (NodeMirror | undefined)[] = new Array(game.en.n);
  const fxNodes: (NodeMirror | undefined)[] = new Array(MAX_FX);
  let bossNode: NodeMirror | undefined;
  let playerNode: NodeMirror | undefined;
  let shieldNode: NodeMirror | undefined;
  let flashNode: NodeMirror | undefined;
  let bgA: NodeMirror | undefined;
  let bgB: NodeMirror | undefined;
  let presenter: Presenter | undefined;

  const sfx = createSfx();
  const input: Input = { mx: 0, my: 0, fire: false, focus: false };
  let scroll = 0;
  let fxNext = 0;
  let scoreShown = -1;
  let frame = 0;
  let shotParity = 0;
  let hitParity = 0;

  onButtonPress(BTN.RTRIGGER, () => {
    game.lock = !game.lock;
    hud.lock = game.lock;
  });
  onButtonPress(BTN.CIRCLE, () => {
    useBomb(game);
  });
  onButtonPress(BTN.START, () => {
    if (game.mode === MODE_OVER || game.mode === MODE_CLEAR) {
      restart(game);
      scroll = 0;
      presenter?.hideAll();
    } else {
      togglePause(game);
    }
  });

  function burst(x: number, y: number): void {
    const n = fxNodes[fxNext];
    fxNext = (fxNext + 1) % MAX_FX;
    if (!n) return;
    jump(n, "translateX", x);
    jump(n, "translateY", y);
    jump(n, "scale", 0.3);
    jump(n, "opacity", 1);
    animate(n, "scale", 2.2, { dur: 260, easing: "out" });
    animate(n, "opacity", 0, { dur: 260, easing: "out" });
  }

  function pad7(n: number): string {
    let s = String(n);
    while (s.length < 7) s = "0" + s;
    return s;
  }

  /** Turn this frame's event bits into sounds, tweens and HUD writes. */
  function handleEvents(): void {
    const ev = game.events;
    game.events = 0;
    for (let k = 0; k < game.fxN; k++) burst(game.fxX[k], game.fxY[k]);
    game.fxN = 0;

    if (ev & EV_BOMB) {
      if (flashNode) {
        jump(flashNode, "opacity", 0.85);
        animate(flashNode, "opacity", 0, { dur: 400, easing: "out" });
      }
      sfx.play(SFX_BOMB);
    }
    if ((ev & EV_BOSS_HP) !== 0 && refs.bossBar) {
      const b = game.boss;
      jump(refs.bossBar, "scaleX", b.alive ? Math.max(0, b.hp / b.maxHp) : 0);
      jump(refs.bossBar, "opacity", b.alive ? 1 : 0);
    }
    if (ev & (EV_HUD | EV_MODE | EV_BOSS_ENTER)) syncHud(game);

    if (ev & EV_PLAYER_HIT) {
      sfx.play(SFX_DEATH);
    } else if (ev & EV_KILL) {
      sfx.play(SFX_EXPLODE);
    } else if (ev & EV_HIT) {
      // Every third connecting shot: the stream is dense and the voices few.
      hitParity = (hitParity + 1) % 3;
      if (hitParity === 0) sfx.play(SFX_HIT);
    }
    if (ev & EV_PHASE) sfx.play(SFX_PHASE);
    if (ev & EV_SHOT) {
      shotParity ^= 1;
      if (shotParity === 0) sfx.play(SFX_SHOT);
    }
    if ((ev & EV_MODE) !== 0 && game.mode === MODE_CLEAR) sfx.play(SFX_CLEAR);

    // The score is the one value that changes every few frames: written
    // straight to the text node, at most ten times a second.
    if (frame % 6 === 0 && game.score !== scoreShown && refs.score) {
      setTextContent(refs.score, pad7(game.score));
      scoreShown = game.score;
    }
  }

  onFrame((buttons) => {
    if (!presenter) return;
    let mx = 0;
    let my = 0;
    if (buttons & BTN.LEFT) mx -= 1;
    if (buttons & BTN.RIGHT) mx += 1;
    if (buttons & BTN.UP) my -= 1;
    if (buttons & BTN.DOWN) my += 1;
    mx += analogX();
    my += analogY();
    const len = Math.sqrt(mx * mx + my * my);
    if (len > 1) {
      mx /= len;
      my /= len;
    }
    input.mx = mx;
    input.my = my;
    // One button: holding fire is what slows the ship.
    input.fire = input.focus = (buttons & BTN.CROSS) !== 0;

    stepGame(game, input);
    if (game.mode === MODE_PLAY) {
      scroll += 0.5 * game.dt;
      if (scroll >= tile) scroll -= tile;
    }
    handleEvents();
    presenter.present(game, scroll, tile);
    sfx.pump();
    frame++;
  });

  onMount(() => {
    presenter = buildPresenter({
      eb: ebNodes,
      pb: pbNodes,
      en: enNodes,
      boss: bossNode,
      player: playerNode,
      shield: shieldNode,
      bgA,
      bgB,
    });
    syncHud(game);
    presenter.present(game, scroll, tile);
    return () => sfx.dispose();
  });
</script>

<View debugName="Playfield" class="relative overflow-hidden bg-[#0b0618]" style={{ width: w, height: h }}>
  <Image class="absolute" src="art/bg.png" style={{ insetL: 0, insetT: 0, width: tile, height: tile }} nodeRef={(n: NodeMirror) => (bgA = n)} />
  <Image class="absolute" src="art/bg.png" style={{ insetL: 0, insetT: 0, width: tile, height: tile }} nodeRef={(n: NodeMirror) => (bgB = n)} />

  {#each DRONES as i (i)}
    <Image class="absolute w-[32] h-[32]" src="art/drone.png" style={{ insetL: -16, insetT: -16, opacity: 0 }} nodeRef={(n: NodeMirror) => (enNodes[i] = n)} />
  {/each}
  {#each GUNSHIPS as i (i)}
    <Image class="absolute w-[32] h-[32]" src="art/gunship.png" style={{ insetL: -16, insetT: -16, opacity: 0 }} nodeRef={(n: NodeMirror) => (enNodes[i] = n)} />
  {/each}
  {#each HEAVIES as i (i)}
    <Image class="absolute w-[64] h-[64]" src="art/heavy.png" style={{ insetL: -32, insetT: -32, opacity: 0 }} nodeRef={(n: NodeMirror) => (enNodes[i] = n)} />
  {/each}
  <Image class="absolute w-[64] h-[64]" src="art/boss.png" style={{ insetL: -32, insetT: -32, opacity: 0 }} nodeRef={(n: NodeMirror) => (bossNode = n)} />

  {#each SHOTS as i (i)}
    <Image class="absolute w-[8] h-[32]" src="art/shot.png" style={{ insetL: -4, insetT: -16, opacity: 0 }} nodeRef={(n: NodeMirror) => (pbNodes[i] = n)} />
  {/each}

  <View debugName="Player" class="absolute w-[32] h-[32]" style={{ insetL: -16, insetT: -16 }} nodeRef={(n: NodeMirror) => (playerNode = n)}>
    <Image class="absolute w-[64] h-[64]" src="art/shield.png" style={{ insetL: -16, insetT: -16, opacity: 0 }} nodeRef={(n: NodeMirror) => (shieldNode = n)} />
    <Image class="absolute w-[32] h-[32]" src="art/ship.png" style={{ insetL: 0, insetT: 0 }} />
    <View class="absolute w-[4] h-[4] rounded-full bg-white" style={{ insetL: 14, insetT: 14 }} />
  </View>

  {#each RED as i (i)}
    <Image class="absolute w-[16] h-[16]" src="art/bullet-red.png" style={{ insetL: -8, insetT: -8, opacity: 0 }} nodeRef={(n: NodeMirror) => (ebNodes[i] = n)} />
  {/each}
  {#each BLUE as i (i)}
    <Image class="absolute w-[16] h-[16]" src="art/bullet-blue.png" style={{ insetL: -8, insetT: -8, opacity: 0 }} nodeRef={(n: NodeMirror) => (ebNodes[i] = n)} />
  {/each}
  {#each GREEN as i (i)}
    <Image class="absolute w-[8] h-[8]" src="art/bullet-green.png" style={{ insetL: -4, insetT: -4, opacity: 0 }} nodeRef={(n: NodeMirror) => (ebNodes[i] = n)} />
  {/each}

  {#each FX as i (i)}
    <Image class="absolute w-[32] h-[32]" src="art/burst.png" style={{ insetL: -16, insetT: -16, opacity: 0, scale: 0.3 }} nodeRef={(n: NodeMirror) => (fxNodes[i] = n)} />
  {/each}

  <View debugName="Flash" class="absolute bg-white" style={{ insetL: 0, insetT: 0, width: w, height: h, opacity: 0 }} nodeRef={(n: NodeMirror) => (flashNode = n)} />

  {#if hud.mode === MODE_PAUSE}
    <View class="absolute flex-col items-center justify-center bg-[#00000099]" style={{ insetL: 0, insetT: 0, width: w, height: h }}>
      <Text class="text-2xl text-white font-bold tracking-wide">PAUSED</Text>
    </View>
  {:else if hud.mode === MODE_OVER}
    <View class="absolute flex-col items-center justify-center gap-2 bg-[#00000099]" style={{ insetL: 0, insetT: 0, width: w, height: h }}>
      <Text class="text-2xl text-rose-400 font-bold tracking-wide">GAME OVER</Text>
      <Text class="text-xs text-slate-300 tracking-wide">PRESS START</Text>
    </View>
  {:else if hud.mode === MODE_CLEAR}
    <View class="absolute flex-col items-center justify-center gap-2 bg-[#00000099]" style={{ insetL: 0, insetT: 0, width: w, height: h }}>
      <Text class="text-2xl text-emerald-300 font-bold tracking-wide">STAGE CLEAR</Text>
      <Text class="text-xs text-slate-300 tracking-wide">PRESS START</Text>
    </View>
  {/if}
</View>
