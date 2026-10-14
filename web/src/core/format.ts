/** Numbers as text. Nothing in here can print NaN, Infinity or "-0". */

const INT = new Intl.NumberFormat('en-CA', { maximumFractionDigits: 0 });

function clean(n: number): number {
  return Object.is(n, -0) ? 0 : n;
}

/** 1234.4 -> "1,234". Anything that is not a finite number -> "–". */
export function fmtInt(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '–';
  const r = Math.round(n);
  return INT.format(clean(r));
}

/** A fixed number of decimals, with the minus sign dropped if the number rounds to zero. */
export function fmtFixed(n: number | null | undefined, digits: number): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '–';
  const s = n.toFixed(digits);
  return Number(s) === 0 ? (0).toFixed(digits) : s;
}

/** A duration in ms: "46 ms" under a second, "1.8 s" above. */
export function fmtDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '–';
  const v = Math.max(0, ms);
  if (v < 1000) return `${INT.format(Math.round(v))} ms`;
  return `${(v / 1000).toFixed(1)} s`;
}

/** Lap clock: 83000 -> "1:23". */
export function fmtClock(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0:00';
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}
