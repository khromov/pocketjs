<script lang="ts">
  // The first-person view: ceiling and floor planes, the wall-strip and
  // sprite pools (built imperatively in onMount, see scene.ts), the weapon
  // hand and the damage flash. `render(game)` is called by the app once per
  // frame after the game has stepped.
  import { onMount } from "svelte";
  import { jump } from "@pocketjs/framework/svelte/animation";
  import { Image, View } from "@pocketjs/framework/svelte/components";
  import type { NodeMirror } from "@pocketjs/framework/svelte/renderer";
  import {
    CEILING_COLOR,
    DEATH_FRAMES,
    FLOOR_COLOR,
    MAX_SPRITE_SLOTS,
    RAYCAST_EVERY,
    WEAPON_PISTOL,
    WEAPON_SMG,
  } from "../game/constants.ts";
  import type { Game } from "../game/game.ts";
  import { castColumns, RayBuffers, setCamera, type Camera } from "../game/raycast.ts";
  import { SpriteCollector } from "../game/sprites.ts";
  import type { Layout } from "./layout.ts";
  import { SceneRenderer } from "./scene.ts";

  let { layout }: { layout: Layout } = $props();

  const HAND_PISTOL = [
    "art/hand-pistol-0.png",
    "art/hand-pistol-1.png",
    "art/hand-pistol-2.png",
    "art/hand-pistol-3.png",
  ];
  const HAND_SMG = [
    "art/hand-smg-0.png",
    "art/hand-smg-1.png",
    "art/hand-smg-2.png",
    "art/hand-smg-3.png",
    "art/hand-smg-4.png",
  ];
  const HAND = 128;

  const { viewW, viewH } = layout;
  const ceilingH = Math.floor(viewH / 2);
  const rays = new RayBuffers(layout.columns);
  const sprites = new SpriteCollector(256, MAX_SPRITE_SLOTS);
  const cam: Camera = { x: 0, y: 0, dirX: 1, dirY: 0, planeX: 0, planeY: 0 };

  let sceneRoot: NodeMirror | undefined;
  let scene: SceneRenderer | undefined;
  let flashNode: NodeMirror | undefined;
  let lastFlash = -1;
  let handSrc = $state("");

  onMount(() => {
    if (!sceneRoot) throw new Error("wolfensvelte: scene root did not mount");
    scene = new SceneRenderer(sceneRoot, viewW, viewH, layout.stripW, MAX_SPRITE_SLOTS);
    return () => {
      scene?.dispose();
      scene = undefined;
    };
  });

  export function render(game: Game): void {
    if (!scene) return;
    const p = game.player;
    if (game.frame % RAYCAST_EVERY === 0) {
      setCamera(cam, p.x, p.y, p.angle, layout.halfFovTan);
      castColumns(game.world, cam, rays, layout.projDist);
      for (let i = 0; i < rays.count; i++) scene.writeStrip(i, rays.wallH[i], rays.cell[i], rays.texU[i]);
      sprites.collect(game.world, game.enemies.list, cam, layout.projDist, viewW, viewH, rays.zbuf, layout.stripW);
      const n = sprites.count;
      for (let s = 0; s < n; s++) {
        scene.writeSprite(s, sprites.cell[s], sprites.left[s], sprites.top[s], sprites.size[s], sprites.runA[s], sprites.runB[s]);
      }
      for (let s = n; s < MAX_SPRITE_SLOTS; s++) scene.hideSprite(s);
      scene.commit();
    }

    const src = p.weapon === WEAPON_PISTOL ? HAND_PISTOL[p.handFrame] : p.weapon === WEAPON_SMG ? HAND_SMG[p.handFrame] : "";
    if (src !== handSrc) handSrc = src;

    // Hit flash, and the red fade of Wolfensvelte's death sequence.
    let flash = p.flash * 0.55;
    if (game.phase === "dying" || game.phase === "dead") flash = Math.min(0.9, 0.2 + (0.7 * game.phaseFrame) / DEATH_FRAMES);
    if (flashNode && flash !== lastFlash) {
      jump(flashNode, "opacity", flash);
      lastFlash = flash;
    }
  }
</script>

<View debugName="View3D" style={{ posType: 1, insetL: 0, insetT: 0, width: viewW, height: viewH, overflow: 1 }}>
  <View style={{ posType: 1, insetL: 0, insetT: 0, width: viewW, height: ceilingH, bgColor: CEILING_COLOR }} />
  <View style={{ posType: 1, insetL: 0, insetT: ceilingH, width: viewW, height: viewH - ceilingH, bgColor: FLOOR_COLOR }} />
  <View debugName="Scene" nodeRef={(n) => (sceneRoot = n)} style={{ posType: 1, insetL: 0, insetT: 0, width: viewW, height: viewH }} />
  {#if handSrc}
    <Image
      debugName="Hand"
      src={handSrc}
      style={{
        posType: 1,
        insetL: Math.round(viewW / 2 - HAND / 2),
        insetT: viewH - HAND,
        width: HAND,
        height: HAND,
        originX: 0,
        originY: 0.5,
        scale: layout.handScale,
      }}
    />
  {/if}
  <View
    debugName="Flash"
    nodeRef={(n) => (flashNode = n)}
    style={{ posType: 1, insetL: 0, insetT: 0, width: viewW, height: viewH, bgColor: "#ff0000", opacity: 0 }}
  />
</View>
