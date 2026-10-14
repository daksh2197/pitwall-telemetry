/**
 * Latency numbers for the screen. The method matches pitwall/metrics.py so the page and the
 * Python results table agree: nearest-rank percentile, and the same 250 ms line for "late".
 */

export const LATE_MS = 250; // a frame later than this counts as backfilled
export const STALL_MS = 500; // no frame for this long means no data

/** Nearest-rank: sort, then take the value at position ceil(p/100 * n). */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0 || !(p > 0 && p <= 100)) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1] ?? null;
}

export interface Bin {
  label: string;
  from: number; // inclusive, ms
  to: number; // exclusive, ms (Infinity for the last)
}

export const BINS: readonly Bin[] = [
  { label: 'under 50 ms', from: 0, to: 50 },
  { label: '50 to 100 ms', from: 50, to: 100 },
  { label: '100 to 250 ms', from: 100, to: 250 },
  { label: '250 to 500 ms', from: 250, to: 500 },
  { label: '0.5 to 1 s', from: 500, to: 1000 },
  { label: '1 to 2.5 s', from: 1000, to: 2500 },
  { label: 'over 2.5 s', from: 2500, to: Infinity },
];

export function binIndex(latencyMs: number): number {
  if (!Number.isFinite(latencyMs) || latencyMs < 0) return 0;
  const i = BINS.findIndex((b) => latencyMs >= b.from && latencyMs < b.to);
  return i === -1 ? BINS.length - 1 : i;
}

/** Bar length from 0 to 1. Log scale, so a few slow frames still show next to thousands of fast ones. */
export function barFraction(count: number, max: number): number {
  if (!(count > 0) || !(max > 0)) return 0;
  return Math.log10(1 + count) / Math.log10(1 + max);
}
