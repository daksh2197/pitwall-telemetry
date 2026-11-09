// Rain drops + intermittent wiper (1967). DOM-free.
import { clamp, cfg } from './state.js';

export const drops = [];
export const wiper = { phase: 'rest', t: 0, ang: 0 };

// speed is car.vx
export function wiperTick(dt, speed, rnd = Math.random) {
  if (cfg.rain) { const rate = 8 + Math.abs(speed) * 0.5; let n = rate * dt; while (n > 0) { if (rnd() < n) drops.push({ x: rnd(), y: rnd() * 0.92, r: 0.006 + rnd() * 0.012 }); n -= 1; } }
  if (drops.length > 420) drops.splice(0, drops.length - 420);
  const sweep = 1.1;
  const mode = cfg.wiper;
  if (mode === 'off') { wiper.phase = 'rest'; wiper.ang = 0; }
  else if (wiper.phase === 'rest') { wiper.t += dt; if (mode === 'steady' || wiper.t >= cfg.dwell) { wiper.phase = 'sweep'; wiper.t = 0; } }
  else { wiper.t += dt; const f = wiper.t / sweep; wiper.ang = Math.PI * (f < 0.5 ? f * 2 : 2 - f * 2); if (f >= 1) { wiper.phase = 'rest'; wiper.t = 0; wiper.ang = 0; } }
  if (wiper.phase === 'sweep') { for (let i = drops.length - 1; i >= 0; i--) { const d = drops[i]; const phi = Math.atan2(-(d.y - 1.08), d.x - 0.5); if (Math.abs(phi - (Math.PI - wiper.ang)) < 0.14) drops.splice(i, 1); } }
}
export function coverage() { let a = 0; for (const d of drops) a += Math.PI * d.r * d.r * 7 / 3; return clamp(a * 3.2, 0, 1); }
export function clearDrops() { drops.length = 0; wiper.phase = 'rest'; wiper.t = 0; wiper.ang = 0; }
