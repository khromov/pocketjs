<script lang="ts">
  // The playfield: every sprite the game can show, pooled once, moved by the
  // presenter each frame. Input is decoded here and handed to the headless
  // game (game/step.ts); the game's event bits drive sounds, tweens and the
  // HUD store on the way back.
  //
  // The pools are bare host nodes, not <Image> components. A component
  // instance costs a few hundred JS objects (props, effects, attachments);
  // six hundred of them put the QuickJS heap past what a PSP has, while a
  // node created through the renderer is one mirror object. The template
  // keeps four empty layer views in paint order and the pools are inserted
  // into them at mount.
  import { onMount, untrack } from "svelte";
  import { setTextContent } from "@pocketjs/framework/svelte";
  import { jump } from "@pocketjs/framework/svelte/animation";
  import { Image, Text, View } from "@pocketjs/framework/svelte/components";
  import type { NodeMirror } from "@pocketjs/framework/svelte/components";
  import { BTN } from "@pocketjs/framework/svelte/input";
  import { analogX, analogY, onButtonPress, onFrame } from "@pocketjs/framework/svelte/lifecycle";
  import { createElement, detachNode, insertNode, setProp } from "@pocketjs/framework/svelte/renderer";
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
    MAX_EBULLETS,
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
  import { createMusic } from "./music.ts";
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

  let { game: gameProp, w: wProp, h }: { game: Game; w: number; h: number } = $props();
  // The game and the field size are fixed for the component's life: read once.
  const game = untrack(() => gameProp);
  const w = untrack(() => wProp);

  /** The starfield tile is a square the width of the field, scrolled and wrapped. */
  const tile = w;

  // Paint layers, back to front; each pool is inserted into one of them.
  let enemyLayer: NodeMirror | undefined;
  let shotLayer: NodeMirror | undefined;
  let bulletLayer: NodeMirror | undefined;
  let fxLayer: NodeMirror | undefined;
  const pooled: NodeMirror[] = [];
  let ebNodes: NodeMirror[] = [];
  let pbNodes: NodeMirror[] = [];
  let enNodes: NodeMirror[] = [];
  let fxNodes: NodeMirror[] = [];
  let bossNode: NodeMirror | undefined;
  let playerNode: NodeMirror | undefined;

  /**
   * `count` image nodes of one texture, centred on the layer origin and
   * hidden, appended to `layer` in slot order. The class strings are literals
   * so the build bakes their style records like any template class.
   */
  function pool(
    layer: NodeMirror,
    count: number,
    cls: string,
    src: string,
    halfW: number,
    halfH: number,
    scale = 1,
  ): NodeMirror[] {
    const nodes: NodeMirror[] = new Array(count);
    for (let i = 0; i < count; i++) {
      const n = createElement("image");
      setProp(n, "class", cls);
      setProp(n, "src", src);
      setProp(n, "style", { insetL: -halfW, insetT: -halfH, opacity: 0, scale });
      insertNode(layer, n);
      nodes[i] = n;
      pooled.push(n);
    }
    return nodes;
  }

  function need(node: NodeMirror | undefined, what: string): NodeMirror {
    if (!node) throw new Error(`svelte-shooter: ${what} layer was not mounted`);
    return node;
  }
  let shieldNode: NodeMirror | undefined;
  let flashNode: NodeMirror | undefined;
  let bgA: NodeMirror | undefined;
  let bgB: NodeMirror | undefined;
  let presenter: Presenter | undefined;

  const sfx = createSfx();
  const music = createMusic();
  const input: Input = { mx: 0, my: 0, fire: false, focus: false };
  let scroll = 0;
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

  function pad7(n: number): string {
    let s = String(n);
    while (s.length < 7) s = "0" + s;
    return s;
  }

  /** Turn this frame's event bits into sounds, tweens and HUD writes. */
  function handleEvents(): void {
    const ev = game.events;
    game.events = 0;
    const p = presenter;
    if (p) {
      for (let k = 0; k < game.fxN; k++) p.burst(game.fxX[k], game.fxY[k]);
      if (ev & EV_BOMB) p.flash();
    }
    game.fxN = 0;

    if (ev & EV_BOMB) sfx.play(SFX_BOMB);
    if ((ev & EV_BOSS_HP) !== 0 && refs.bossBar) {
      const b = game.boss;
      jump(refs.bossBar, "scaleX", b.alive ? Math.max(0, b.hp / b.maxHp) : 0);
      jump(refs.bossBar, "opacity", b.alive ? 1 : 0);
    }
    if (ev & (EV_HUD | EV_MODE | EV_BOSS_ENTER)) syncHud(game);
    if (ev & EV_MODE) {
      if (game.mode === MODE_PAUSE) music.pause();
      else if (game.mode === MODE_PLAY) music.resume();
    }

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
    input.fire = (buttons & BTN.CROSS) !== 0;
    // Hold the left trigger to creep through a dense pattern; it mirrors the
    // right trigger's lock toggle.
    input.focus = (buttons & BTN.LTRIGGER) !== 0;

    stepGame(game, input);
    if (game.mode === MODE_PLAY) {
      scroll += 0.5 * game.dt;
      if (scroll >= tile) scroll -= tile;
    }
    handleEvents();
    presenter.present(game, scroll, tile);
    sfx.pump();
    music.pump();
    frame++;
  });

  onMount(() => {
    const enemies = need(enemyLayer, "enemy");
    const shots = need(shotLayer, "shot");
    const bullets = need(bulletLayer, "bullet");
    const fx = need(fxLayer, "fx");
    enNodes = [
      ...pool(enemies, TYPE_SLOTS[0], "absolute w-[32] h-[32]", "art/drone.png", 16, 16),
      ...pool(enemies, TYPE_SLOTS[1], "absolute w-[32] h-[32]", "art/gunship.png", 16, 16),
      ...pool(enemies, TYPE_SLOTS[2], "absolute w-[64] h-[64]", "art/heavy.png", 32, 32),
    ];
    bossNode = pool(enemies, 1, "absolute w-[64] h-[64]", "art/boss.png", 32, 32)[0];
    pbNodes = pool(shots, MAX_PBULLETS, "absolute w-[8] h-[32]", "art/shot.png", 4, 16);
    // One pool for every bullet kind: the presenter re-points a slot's
    // texture on spawn, so no kind can starve while another has room.
    ebNodes = pool(bullets, MAX_EBULLETS, "absolute w-[16] h-[16]", "art/bullet-red.png", 8, 8);
    fxNodes = pool(fx, MAX_FX, "absolute w-[32] h-[32]", "art/burst.png", 16, 16, 0.3);
    presenter = buildPresenter({
      eb: ebNodes,
      pb: pbNodes,
      en: enNodes,
      fx: fxNodes,
      boss: bossNode,
      player: playerNode,
      shield: shieldNode,
      flash: flashNode,
      bgA,
      bgB,
    });
    syncHud(game);
    presenter.present(game, scroll, tile);
    music.play();
    return () => {
      sfx.dispose();
      music.dispose();
      for (const n of pooled) if (n.parent) detachNode(n.parent, n);
      pooled.length = 0;
    };
  });
</script>

<View debugName="Playfield" class="relative overflow-hidden bg-[#0b0618]" style={{ width: w, height: h }}>
  <Image class="absolute" src="art/bg.png" style={{ insetL: 0, insetT: 0, width: tile, height: tile }} nodeRef={(n: NodeMirror) => (bgA = n)} />
  <Image class="absolute" src="art/bg.png" style={{ insetL: 0, insetT: 0, width: tile, height: tile }} nodeRef={(n: NodeMirror) => (bgB = n)} />

  <View debugName="Enemies" class="absolute" style={{ insetL: 0, insetT: 0, width: 0, height: 0 }} nodeRef={(n: NodeMirror) => (enemyLayer = n)} />
  <View debugName="Shots" class="absolute" style={{ insetL: 0, insetT: 0, width: 0, height: 0 }} nodeRef={(n: NodeMirror) => (shotLayer = n)} />

  <View debugName="Player" class="absolute w-[32] h-[32]" style={{ insetL: -16, insetT: -16 }} nodeRef={(n: NodeMirror) => (playerNode = n)}>
    <Image class="absolute w-[64] h-[64]" src="art/shield.png" style={{ insetL: -16, insetT: -16, opacity: 0 }} nodeRef={(n: NodeMirror) => (shieldNode = n)} />
    <Image class="absolute w-[32] h-[32]" src="art/ship.png" style={{ insetL: 0, insetT: 0 }} />
    <View class="absolute w-[8] h-[8] rounded-full bg-[#ffffff55]" style={{ insetL: 12, insetT: 12 }} />
    <View class="absolute w-[2] h-[2] bg-white" style={{ insetL: 15, insetT: 15 }} />
  </View>

  <View debugName="Bullets" class="absolute" style={{ insetL: 0, insetT: 0, width: 0, height: 0 }} nodeRef={(n: NodeMirror) => (bulletLayer = n)} />
  <View debugName="Fx" class="absolute" style={{ insetL: 0, insetT: 0, width: 0, height: 0 }} nodeRef={(n: NodeMirror) => (fxLayer = n)} />

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
