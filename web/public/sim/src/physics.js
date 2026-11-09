// Car physics (DOM-free): 240 Hz bicycle model with tanh tyres. 
import { G, clamp, cfg, inp } from './state.js';
import { TR, NTR, W2, nearest } from './track.js';
import { tireTick } from './tire-monitor.js';

export const ENG = {
  piston: { name: 'Piston V6', peak: 6400, limit: 7200, down: 3600, P: 200e3, dm: 0 },
  rotary: { name: 'Rotary', peak: 8200, limit: 9000, down: 4600, P: 200e3, dm: -45 }
};
// Kerb grip from a quarter-car model (250/35 kg, 150 kN/m tyre, 80 kN/m spring), with an ISO 8608 class C road at 20 m/s standing in for kerbs:
// RMS tyre-load swing 28.8% with spring + best damper, 26.3% with the inerter in series with the damper (-8.9%).
export const KERB = { classic: 0.712, inerter: 0.737 };
export const GEARS = [3.4, 2.2, 1.6, 1.25, 1.03, 0.86];
export const FINAL = 3.6;
export const RW = 0.33;
export const P = { m: 1250, Iz: 1800, a: 1.25, b: 1.35, C: 90000, CdA: 0.70, crr: 0.015, tw: 0.8 };
export const car = {};

export function resetCar() {
  const p = TR[NTR - 15]; // 30 m before the line, so the first lap starts timing right away
  Object.assign(car, { x: p.x, y: p.y, psi: Math.atan2(p.ty, p.tx), vx: 0, vy: 0, r: 0, gear: 1, rpm: 1000, idx: NTR - 15, s: p.s, ax: 0, ay: 0, beta: 0, surface: 'track', top: 0 });
}
resetCar();

export function engine() { return cfg.rotary ? ENG.rotary : ENG.piston; }
export function power(e, rpm) { if (rpm >= e.limit) return 0; const x = rpm / e.peak; const sh = cfg.rotary ? x * (1.6 - 0.6 * x) : x * (2 - x); return e.P * clamp(Math.max(0.12, sh), 0, 1.02); }
export function rpmFor(u, g) { return Math.max(1000, u / (2 * Math.PI * RW) * 60 * GEARS[g - 1] * FINAL); }

export function step(dt) {
  const e = engine(), m = P.m + e.dm, L = P.a + P.b;
  const u = car.vx, au = Math.max(Math.abs(u), 0.5);
  // where are we
  car.idx = nearest(car.x, car.y, car.idx);
  const tp = TR[car.idx];
  const d = (car.x - tp.x) * (-tp.ty) + (car.y - tp.y) * tp.tx;
  const ad = Math.abs(d);
  car.surface = ad > W2 + 0.4 ? 'grass' : (tp.kerb && ad > W2 - 1.6 ? 'kerb' : 'track');
  let mu = cfg.rain ? 0.85 : 1.25;
  if (car.surface === 'grass') mu = cfg.rain ? 0.45 : 0.6;
  if (car.surface === 'kerb') mu *= cfg.inerter ? KERB.inerter : KERB.classic;
  // aero
  const ClA = cfg.ground ? 2.6 : 0.35, CdA = cfg.ground ? 0.78 : P.CdA;
  const DF = 0.5 * 1.2 * ClA * u * u, drag = 0.5 * 1.2 * CdA * u * Math.abs(u);
  const Fzf = m * G * P.b / L + DF * 0.45, Fzr = m * G * P.a / L + DF * 0.55;
  // gearbox
  let rpm = rpmFor(Math.abs(u), car.gear);
  if (rpm > e.limit - 250 && car.gear < 6) car.gear++;
  else if (car.gear > 1 && rpm < e.down && rpmFor(Math.abs(u), car.gear - 1) < e.limit - 900) car.gear--;
  rpm = rpmFor(Math.abs(u), car.gear); car.rpm = rpm;
  // longitudinal
  let Fdrive = inp.thr * power(e, rpm) * 0.85 / Math.max(au, 3);
  // traction control: drive force only takes the rear grip the corner isn't using, so full throttle on a keyboard doesn't spin the car
  if (cfg.assist) Fdrive = Math.min(Fdrive, Math.sqrt(Math.max(0.04 * (mu * Fzr) ** 2, (0.85 * mu * Fzr) ** 2 - (car.Fyr || 0) ** 2)));
  else Fdrive = Math.min(Fdrive, 1.05 * mu * Fzr);
  // brakes with simple ABS: each axle brakes with the grip the corner isn't using, so the car still steers under full brake
  let Fbf = 0, Fbr = 0;
  if (u > 0.4) {
    const want = inp.brk * mu * (Fzf + Fzr) * 0.95;
    Fbf = Math.min(want * 0.6, Math.sqrt(Math.max((0.3 * mu * Fzf) ** 2, (0.95 * mu * Fzf) ** 2 - (car.Fyf || 0) ** 2)));
    Fbr = Math.min(want * 0.4, Math.sqrt(Math.max((0.3 * mu * Fzr) ** 2, (0.95 * mu * Fzr) ** 2 - (car.Fyr || 0) ** 2)));
  }
  else if (inp.brk > 0.3 && inp.thr < 0.1) Fdrive = -2200 * inp.brk; // reverse when stopped
  const Fbrake = Fbf + Fbr;
  const roll = (car.surface === 'grass' ? 0.07 : P.crr) * m * G * Math.sign(u);
  // tyres
  const delta = inp.steer * 0.38 / (1 + au / 28);
  const Df = Math.sqrt(Math.max((0.3 * mu * Fzf) ** 2, (mu * Fzf) ** 2 - Fbf ** 2));
  const rearW = cfg.assist ? 1.1 : 1; // driver aids also fit wider rear tyres, which keeps the tail planted
  const Dr = rearW * Math.sqrt(Math.max((0.2 * mu * Fzr) ** 2, (mu * Fzr) ** 2 - (Fdrive + Fbr) ** 2));
  let Fyf = 0, Fyr = 0;
  if (Math.abs(u) > 1.5) {
    const af = Math.atan2(car.vy + P.a * car.r, au) - delta * Math.sign(u);
    const ar = Math.atan2(car.vy - P.b * car.r, au);
    Fyf = -Df * Math.tanh(P.C * af / Df); Fyr = -Dr * Math.tanh(P.C * rearW * rearW * ar / Dr);
  }
  const Fx = Fdrive - Fbrake * Math.sign(u) - drag - roll;
  let dvx = (Fx - Fyf * Math.sin(delta)) / m + car.vy * car.r;
  let dvy = (Fyr + Fyf * Math.cos(delta)) / m - car.vx * car.r;
  let dr = (P.a * Fyf * Math.cos(delta) - P.b * Fyr) / P.Iz;
  if (Math.abs(u) <= 1.5) { car.r = u * Math.tan(delta) / L; dr = 0; car.vy *= 0.8; dvy = 0; }
  car.vx += dvx * dt; car.vy += dvy * dt; car.r += dr * dt;
  if (Math.abs(car.vx) < 0.05 && inp.thr < 0.02 && inp.brk < 0.3) { car.vx = 0; car.vy = 0; car.r = 0; }
  const c = Math.cos(car.psi), s = Math.sin(car.psi);
  car.x += (car.vx * c - car.vy * s) * dt; car.y += (car.vx * s + car.vy * c) * dt; car.psi += car.r * dt;
  car.ax = dvx - car.vy * car.r; car.ay = dvy + car.vx * car.r;
  car.beta = Math.abs(car.vx) > 2 ? Math.atan2(car.vy, Math.abs(car.vx)) : 0;
  car.DF = DF; car.mu = mu; car.Fyr = Fyr; car.Fyf = Fyf;
  tireTick(dt, car, cfg, { tw: P.tw, rw: RW });
}
