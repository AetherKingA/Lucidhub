// Raise sizing for the bet slider: amounts snap to a step counted from the minimum raise, but the
// minimum and all-in are always exact. A stack is often off the step grid (antes, split pots,
// returned bets), so plain rounding would send a raise a few chips short of all-in.

export interface RaiseRange {
  min: number;
  max: number;
  step: number;
}

/** Snaps an amount to the step. Anything at or past the top, or that would round onto it, is exactly all-in. */
export function snapRaise(v: number, { min, max, step }: RaiseRange): number {
  if (v >= max) return max;
  if (v <= min) return min;
  return Math.min(max, min + Math.round((v - min) / step) * step);
}

/** Number of slider positions above the minimum. The last one is all-in even when it's less than a full step. */
export function sliderPositions({ min, max, step }: RaiseRange): number {
  return Math.max(0, Math.ceil((max - min) / step));
}

export function amountAt(position: number, { min, max, step }: RaiseRange): number {
  return Math.min(max, min + position * step);
}

export function positionOf(v: number, r: RaiseRange): number {
  return v >= r.max ? sliderPositions(r) : Math.max(0, Math.round((v - r.min) / r.step));
}
