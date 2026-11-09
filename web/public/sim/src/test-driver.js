// Test driver (autopilot): pure pursuit steering plus a look-ahead speed target. DOM-free.
import { G, clamp, cfg, inp } from './state.js';
import { TR, NTR, LEN } from './track.js';
import { P, car, engine } from './physics.js';

export const AP_LAT = 0.55;

export function testDriver() {
  const i = car.idx, v = Math.max(car.vx, 0), mu = car.mu || 1.25, LAT = AP_LAT;
  const t = TR[(i + Math.round(4 + v * 0.35)) % NTR];
  let err = Math.atan2(t.y - car.y, t.x - car.x) - car.psi;
  while (err > Math.PI) err -= 2 * Math.PI; while (err < -Math.PI) err += 2 * Math.PI;
  const Ld = Math.max(6, Math.hypot(t.x - car.x, t.y - car.y));
  inp.steer = clamp(Math.atan(2 * (P.a + P.b) * Math.sin(err) / Ld) * (1 + v / 28) / 0.38, -1, 1);
  const ClA = cfg.ground ? 2.6 : 0.35, m = P.m + engine().dm;
  let vt = 95;
  for (let j = 0; j < 150; j += 2) {
    const k = Math.abs(TR[(i + j) % NTR].k); if (k < 1e-4) continue;
    const den = k - LAT * mu * 0.6 * ClA / m, vmax = den > 0 ? Math.sqrt(LAT * mu * G / den) : 95;
    vt = Math.min(vt, Math.sqrt(vmax * vmax + 2 * 0.75 * mu * G * j * LEN / NTR));
  }
  if (v > vt + 0.5) { inp.thr = 0; inp.brk = 1; } else { inp.thr = 1; inp.brk = 0; }
}
