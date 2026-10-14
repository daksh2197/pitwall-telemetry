/** The maths behind the trace chart, with no canvas in it, so it can be tested. */

import type { Series } from '../core/store';

/** Two samples further apart than this are not joined by a line. A gap is a gap. */
export const MAX_JOIN_MS = 150;

export interface View {
  t0: number; // left edge, car time ms
  t1: number; // right edge
}

export function viewFor(nowMs: number, widthMs: number): View {
  const t1 = Number.isFinite(nowMs) ? Math.max(nowMs, 0) : 0;
  return { t0: t1 - widthMs, t1 };
}

/** Index of the first element that is >= x, in a sorted array. */
export function lowerBound(sorted: readonly number[], x: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((sorted[mid] ?? Infinity) < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export interface Stroke {
  late: boolean;
  t: number[];
  y: number[];
}

/**
 * Cut a series into the pieces to draw inside a view.
 *
 * A piece ends where there is a gap bigger than MAX_JOIN_MS or where the colour changes. When
 * the colour changes, the new piece starts at the last point of the old one, so there is no
 * hairline break between them.
 */
export function strokes(series: Series | undefined, view: View, maxJoinMs = MAX_JOIN_MS): Stroke[] {
  if (!series || series.t.length === 0) return [];
  const out: Stroke[] = [];
  const start = Math.max(0, lowerBound(series.t, view.t0) - 1);
  let current: Stroke | null = null;
  let prevT = 0;
  let prevY = 0;
  for (let i = start; i < series.t.length; i++) {
    const t = series.t[i] as number;
    const y = series.y[i] as number;
    const late = series.late[i] as boolean;
    if (t > view.t1 + maxJoinMs) break;
    if (current && t - prevT > maxJoinMs) current = null;
    if (!current) {
      current = { late, t: [t], y: [y] };
      out.push(current);
    } else if (current.late !== late) {
      current = { late, t: [prevT, t], y: [prevY, y] };
      out.push(current);
    } else {
      current.t.push(t);
      current.y.push(y);
    }
    prevT = t;
    prevY = y;
  }
  return out.filter((s) => s.t.length > 0 && (s.t[s.t.length - 1] as number) >= view.t0);
}

/** Late stretches closer together than this are drawn as one block, so one on-time frame does not make a sliver. */
export const MERGE_MS = 30;

/** Stretches of car time covered by late samples, for the strip under the chart. */
export function lateRanges(series: Series | undefined, view: View, maxJoinMs = MAX_JOIN_MS): [number, number][] {
  const out: [number, number][] = [];
  if (!series) return out;
  const start = Math.max(0, lowerBound(series.t, view.t0) - 1);
  for (let i = start; i < series.t.length; i++) {
    const t = series.t[i] as number;
    if (t > view.t1 + maxJoinMs) break;
    if (!series.late[i]) continue;
    const last = out[out.length - 1];
    if (last && t - last[1] <= MERGE_MS) last[1] = t;
    else out.push([t, t]);
  }
  return out.filter(([, b]) => b >= view.t0);
}

/** Round a maximum up to the next multiple of `step`, never below `floor`. */
export function niceMax(value: number, step: number, floor: number): number {
  if (!Number.isFinite(value)) return floor;
  return Math.max(floor, Math.ceil(value / step) * step);
}

/** Tick positions: every `everyMs` that falls inside the view. */
export function ticks(view: View, everyMs: number): number[] {
  const out: number[] = [];
  const first = Math.ceil(Math.max(view.t0, 0) / everyMs) * everyMs;
  for (let t = first; t <= view.t1 && out.length < 1000; t += everyMs) out.push(t);
  return out;
}
