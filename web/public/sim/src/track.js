// Track geometry (DOM-free). Catmull-Rom through CTRL, resampled every ~2 m.
export const TRACK_ID = 'pg-circuit-1';
export const TRACK_NAME = 'Pitwall Sim Circuit 1';
export const CTRL = [[0,0],[300,0],[420,60],[460,180],[400,300],[260,320],[200,420],[260,540],[420,560],[520,660],[480,800],[300,820],[120,760],[40,620],[-60,520],[-120,360],[-80,200],[-40,80]];
export const W2 = 7; // half width, m
export const NB = 240; // lap bins

function cr(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  const f = (a, b, c, d) => 0.5 * ((2 * b) + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
  return [f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])];
}
const raw = [];
for (let i = 0; i < CTRL.length; i++) {
  const n = CTRL.length, p0 = CTRL[(i - 1 + n) % n], p1 = CTRL[i], p2 = CTRL[(i + 1) % n], p3 = CTRL[(i + 2) % n];
  for (let j = 0; j < 40; j++) raw.push(cr(p0, p1, p2, p3, j / 40));
}
const cum = [0];
for (let i = 1; i <= raw.length; i++) { const a = raw[i - 1], b = raw[i % raw.length]; cum.push(cum[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1])); }
export const LEN = cum[cum.length - 1];
export const NTR = Math.round(LEN / 2);
export const TR = [];
{
  let k = 0;
  for (let i = 0; i < NTR; i++) {
    const s = i * LEN / NTR;
    while (cum[k + 1] < s) k++;
    const a = raw[k], b = raw[(k + 1) % raw.length];
    const t = (s - cum[k]) / ((cum[k + 1] - cum[k]) || 1);
    TR.push({ x: a[0] + (b[0] - a[0]) * t, y: a[1] + (b[1] - a[1]) * t, s });
  }
}
// unit tangents
for (let i = 0; i < NTR; i++) {
  const p = TR[(i - 1 + NTR) % NTR], q = TR[(i + 1) % NTR];
  const tx = q.x - p.x, ty = q.y - p.y, l = Math.hypot(tx, ty) || 1;
  TR[i].tx = tx / l; TR[i].ty = ty / l;
}
// signed curvature k
for (let i = 0; i < NTR; i++) {
  const p = TR[(i - 2 + NTR) % NTR], q = TR[(i + 2) % NTR];
  let da = Math.atan2(q.ty, q.tx) - Math.atan2(p.ty, p.tx);
  while (da > Math.PI) da -= 2 * Math.PI;
  while (da < -Math.PI) da += 2 * Math.PI;
  TR[i].k = da / (4 * LEN / NTR);
}
// kerbs where curvature within +-8 points exceeds 1/120
for (let i = 0; i < NTR; i++) {
  let m = 0;
  for (let j = -8; j <= 8; j++) m = Math.max(m, Math.abs(TR[(i + j + NTR) % NTR].k));
  TR[i].kerb = m > 1 / 120;
}
export const BOUNDS = TR.reduce((b, p) => ({ x0: Math.min(b.x0, p.x), x1: Math.max(b.x1, p.x), y0: Math.min(b.y0, p.y), y1: Math.max(b.y1, p.y) }), { x0: 1e9, x1: -1e9, y0: 1e9, y1: -1e9 });

// Lap bin for a distance along the track.
export function binOf(s) { return Math.min(NB - 1, Math.floor(s / LEN * NB)); }

// Nearest track index to (x, y): scan +-40 points around the hint, full scan if more than 60 m away.
export function nearest(x, y, hint) {
  let best = hint, bd = Infinity;
  const scan = i => { const j = (i % NTR + NTR) % NTR, p = TR[j], d = (p.x - x) ** 2 + (p.y - y) ** 2; if (d < bd) { bd = d; best = j; } };
  for (let j = -40; j <= 40; j++) scan(hint + j);
  if (bd > 3600) for (let i = 0; i < NTR; i++) scan(i);
  return best;
}
