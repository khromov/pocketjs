<script lang="ts">
  import { Image, Text, View } from "@pocketjs/framework/svelte/components";
  import { BTN } from "@pocketjs/framework/svelte/input";
  import { onButtonPress, onFrame } from "@pocketjs/framework/svelte/lifecycle";

  const COLS = 12;
  const ROWS = 12;
  const CELL = 18;
  const BOARD = COLS * CELL;
  /** Host frames per move: 8 at 60 Hz is about 7 steps a second. */
  const STEP_FRAMES = 8;

  interface Point {
    x: number;
    y: number;
  }

  const START: Point[] = [
    { x: 5, y: 6 },
    { x: 4, y: 6 },
    { x: 3, y: 6 },
  ];

  // A deterministic generator keeps the demo replayable frame for frame, which
  // is what the golden and tape harnesses need.
  let seed = 0x2545f491;
  function nextRandom(bound: number): number {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return Math.abs(seed) % bound;
  }

  let snake = $state<Point[]>(START.map((p) => ({ ...p })));
  let food = $state<Point>({ x: 9, y: 6 });
  let heading = $state<Point>({ x: 1, y: 0 });
  let queued = $state<Point>({ x: 1, y: 0 });
  let score = $state(0);
  let best = $state(0);
  let deaths = $state(0);
  let tick = 0;

  const occupies = (cells: Point[], x: number, y: number): boolean =>
    cells.some((cell) => cell.x === x && cell.y === y);

  function placeFood(cells: Point[]): Point {
    // Bounded rejection sampling; the board always has room at this size.
    for (let attempt = 0; attempt < 64; attempt++) {
      const spot = { x: nextRandom(COLS), y: nextRandom(ROWS) };
      if (!occupies(cells, spot.x, spot.y)) return spot;
    }
    return { x: 0, y: 0 };
  }

  function restart(): void {
    deaths += 1;
    if (score > best) best = score;
    snake = START.map((p) => ({ ...p }));
    heading = { x: 1, y: 0 };
    queued = { x: 1, y: 0 };
    score = 0;
    food = { x: 9, y: 6 };
  }

  function steer(x: number, y: number): void {
    // Reversing onto your own neck is a death, not a turn, so it is ignored.
    if (heading.x === -x && heading.y === -y) return;
    queued = { x, y };
  }

  onButtonPress(BTN.UP, () => steer(0, -1));
  onButtonPress(BTN.DOWN, () => steer(0, 1));
  onButtonPress(BTN.LEFT, () => steer(-1, 0));
  onButtonPress(BTN.RIGHT, () => steer(1, 0));

  onFrame(() => {
    if (++tick < STEP_FRAMES) return;
    tick = 0;

    heading = queued;
    const head = { x: snake[0].x + heading.x, y: snake[0].y + heading.y };

    const hitWall = head.x < 0 || head.y < 0 || head.x >= COLS || head.y >= ROWS;
    if (hitWall || occupies(snake, head.x, head.y)) {
      restart();
      return;
    }

    const grew = head.x === food.x && head.y === food.y;
    const body = grew ? snake : snake.slice(0, -1);
    snake = [head, ...body];
    if (grew) {
      score += 1;
      food = placeFood(snake);
    }
  });

  const cellStyle = (p: Point) => ({
    posType: 1,
    insetL: p.x * CELL,
    insetT: p.y * CELL,
    width: CELL - 2,
    height: CELL - 2,
  });
</script>

<View
  debugName="SnakeScreen"
  class="w-full h-full flex-row items-center justify-between p-4 gap-4 bg-gradient-to-b from-slate-50 to-slate-100"
>
  <View class="flex-col gap-2">
    <View
      debugName="Board"
      class="relative rounded-lg shadow-md bg-slate-900 border-slate-800"
      style={{ width: BOARD, height: BOARD }}
    >
      <View class="absolute rounded-sm bg-amber-400" style={cellStyle(food)} />
      {#each snake as segment, index (index)}
        <View
          class={index === 0 ? "absolute rounded-sm bg-emerald-300" : "absolute rounded-sm bg-emerald-500"}
          style={cellStyle(segment)}
        />
      {/each}
    </View>
    <View class="flex-row items-center justify-between">
      <Text class="text-xs text-slate-500 tracking-wide">D-PAD STEERS</Text>
      <Text class="text-xs text-slate-400">RUN {deaths + 1}</Text>
    </View>
  </View>

  <View class="flex-col items-center gap-2">
    <Image class="w-[128] h-[128]" src="svelte-logo.svg" />
    <Text class="text-lg text-slate-950 font-bold tracking-wide">SVELTE SNAKE</Text>
    <View class="flex-row gap-4">
      <View class="flex-col items-end">
        <Text class="text-2xl text-emerald-600 font-bold">{score}</Text>
        <Text class="text-xs text-slate-500 tracking-wide">SCORE</Text>
      </View>
      <View class="flex-col items-end">
        <Text class="text-2xl text-blue-600 font-bold">{best}</Text>
        <Text class="text-xs text-slate-500 tracking-wide">BEST</Text>
      </View>
    </View>
  </View>
</View>
