// Flappy Bird physics, shared by the browser (to play and draw) and the server (to check runs).
// Everything runs in fixed ticks (60 a second) and uses only whole-tick inputs, so the same
// seed and the same flap ticks always give exactly the same flight. A run is just its flap ticks.

export const TICKS_PER_SECOND = 60;
export const TICK_MS = 1000 / TICKS_PER_SECOND;

/** The playfield, in world units. The client scales it to the screen. */
export const WORLD_W = 288;
export const WORLD_H = 512;
export const GROUND_Y = 452;

export const BIRD_X = 80;
export const BIRD_R = 11;
export const GRAVITY = 0.32;
export const FLAP_VELOCITY = -5.6;
export const MAX_FALL = 8.5;
export const SPEED = 2.1;

export const PIPE_W = 52;
export const PIPE_GAP = 118;
export const PIPE_SPACING = 168;
/** World x of the first pipe's left edge (the bird starts at 0). */
export const FIRST_PIPE_X = 360;
const GAP_MARGIN = 56;

/** Longest run the server accepts: 30 minutes of flying. */
export const MAX_RUN_TICKS = 30 * 60 * TICKS_PER_SECOND;

export interface Bird {
  tick: number;
  y: number;
  vy: number;
  dead: boolean;
  score: number;
}

export interface Pipe {
  index: number;
  /** World x of the left edge. */
  x: number;
  /** Centre of the gap. */
  gapY: number;
}

export interface RunResult {
  /** Pipes passed. */
  score: number;
  /** Ticks flown before crashing (or before the run was cut off). Further = better. */
  distance: number;
  crashed: boolean;
}

/** Small fast seeded random number generator (mulberry32). */
function mulberry32(a: number) {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Pipe number `index` of a course. Each pipe has its own random draw, so any pipe can be looked up directly. */
export function pipeAt(seed: number, index: number): Pipe {
  const r = mulberry32((seed ^ Math.imul(index + 1, 0x9e3779b1)) | 0)();
  const min = GAP_MARGIN + PIPE_GAP / 2;
  const max = GROUND_Y - GAP_MARGIN - PIPE_GAP / 2;
  return { index, x: FIRST_PIPE_X + index * PIPE_SPACING, gapY: Math.round(min + r * (max - min)) };
}

/** The pipes visible between two world x positions. */
export function pipesBetween(seed: number, fromX: number, toX: number): Pipe[] {
  const first = Math.max(0, Math.floor((fromX - FIRST_PIPE_X - PIPE_W) / PIPE_SPACING));
  const pipes: Pipe[] = [];
  for (let i = first; FIRST_PIPE_X + i * PIPE_SPACING <= toX; i++) pipes.push(pipeAt(seed, i));
  return pipes;
}

/** World x of the bird at a tick. */
export const birdWorldX = (tick: number) => tick * SPEED;

export function newBird(): Bird {
  return { tick: 0, y: WORLD_H * 0.42, vy: 0, dead: false, score: 0 };
}

function hitsPipe(seed: number, wx: number, y: number) {
  const index = Math.floor((wx + BIRD_R - FIRST_PIPE_X) / PIPE_SPACING);
  for (const i of [index - 1, index]) {
    if (i < 0) continue;
    const p = pipeAt(seed, i);
    // Closest point of the pipe's rectangles to the bird's centre.
    const cx = Math.max(p.x, Math.min(wx, p.x + PIPE_W));
    if (Math.abs(cx - wx) >= BIRD_R) continue;
    const dx = cx - wx;
    const top = p.gapY - PIPE_GAP / 2;
    const bottom = p.gapY + PIPE_GAP / 2;
    if (y < top) return true;
    if (y > bottom) return true;
    // Inside the gap's height: only the pipe corners can still touch.
    const reach = Math.sqrt(BIRD_R * BIRD_R - dx * dx);
    if (y - reach < top || y + reach > bottom) return true;
  }
  return false;
}

/** Advances one tick. Mutates and returns the bird. A flap on this tick is applied before moving. */
export function step(seed: number, bird: Bird, flap: boolean): Bird {
  if (bird.dead) return bird;
  if (flap) bird.vy = FLAP_VELOCITY;
  else bird.vy = Math.min(MAX_FALL, bird.vy + GRAVITY);
  bird.y = Math.max(-BIRD_R * 4, bird.y + bird.vy);
  bird.tick++;
  const wx = birdWorldX(bird.tick);
  // Passed a pipe once the bird's centre is past its right edge.
  const passed = Math.floor((wx - FIRST_PIPE_X - PIPE_W) / PIPE_SPACING) + 1;
  bird.score = Math.max(0, passed);
  if (bird.y + BIRD_R >= GROUND_Y || hitsPipe(seed, wx, bird.y)) bird.dead = true;
  return bird;
}

/** Checks a run's flap ticks: whole numbers, strictly increasing, inside the run. */
export function validFlaps(flaps: unknown, maxTicks = MAX_RUN_TICKS): flaps is number[] {
  if (!Array.isArray(flaps) || flaps.length > maxTicks) return false;
  let prev = -1;
  for (const f of flaps) {
    if (!Number.isInteger(f) || f <= prev || f >= maxTicks) return false;
    prev = f;
  }
  return true;
}

/**
 * Replays a run from its flap ticks. `maxTicks` cuts it off (the tournament clock ran out),
 * which counts the distance flown so far.
 */
export function simulate(seed: number, flaps: readonly number[], maxTicks = MAX_RUN_TICKS): RunResult {
  const bird = newBird();
  let next = 0;
  while (!bird.dead && bird.tick < maxTicks) {
    const flap = flaps[next] === bird.tick;
    if (flap) next++;
    step(seed, bird, flap);
  }
  return { score: bird.score, distance: bird.tick, crashed: bird.dead };
}

/** Replays a run tick by tick, for drawing a ghost. Positions are kept, so seeking is cheap. */
export function trace(seed: number, flaps: readonly number[], maxTicks = MAX_RUN_TICKS): { y: number[]; result: RunResult } {
  const bird = newBird();
  const y = [bird.y];
  let next = 0;
  while (!bird.dead && bird.tick < maxTicks) {
    const flap = flaps[next] === bird.tick;
    if (flap) next++;
    step(seed, bird, flap);
    y.push(bird.y);
  }
  return { y, result: { score: bird.score, distance: bird.tick, crashed: bird.dead } };
}

/** Better run first: further, then whoever set it earlier. */
export function compareRuns(a: { distance: number; setAt: number }, b: { distance: number; setAt: number }) {
  return b.distance - a.distance || a.setAt - b.setAt;
}

/** A simple autopilot (for bots and tests): flaps when it's below the next gap's centre and falling. */
export function autopilot(seed: number, maxTicks: number, skill = 1, random = Math.random): number[] {
  const bird = newBird();
  const flaps: number[] = [];
  // One aiming error per pipe (not per tick), so a weaker pilot misjudges some pipes rather than twitching.
  let aimFor = -1;
  let wobble = 0;
  while (!bird.dead && bird.tick < maxTicks) {
    const wx = birdWorldX(bird.tick);
    // Aim for the next pipe only once the bird is fully clear of the current one.
    const i = Math.max(0, Math.floor((wx - FIRST_PIPE_X - PIPE_W - BIRD_R) / PIPE_SPACING) + 1);
    const target = bird.tick * SPEED < FIRST_PIPE_X - 120 ? WORLD_H * 0.42 : pipeAt(seed, i).gapY + 14;
    if (i !== aimFor) {
      aimFor = i;
      wobble = skill >= 1 ? 0 : (random() - 0.5) * 90 * (1 - skill);
    }
    const flap = bird.y > target + wobble && bird.vy >= 0;
    if (flap) flaps.push(bird.tick);
    step(seed, bird, flap);
  }
  return flaps;
}
