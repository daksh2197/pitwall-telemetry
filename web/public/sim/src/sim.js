// Sim glue (DOM-free): reset, fixed step, drift score, and a Node test helper.
import { cfg, auto, sim } from './state.js';
import { TR } from './track.js';
import { car, step, resetCar } from './physics.js';
import { lap, lapTick, resetLap } from './laps.js';
import { tire, tireReset } from './tire-monitor.js';
import { testDriver } from './test-driver.js';

const resetListeners = [];
export function onReset(fn) { resetListeners.push(fn); }
export function resetAll() {
  resetCar(); resetLap(); tireReset();
  for (const fn of resetListeners) fn();
}

export function simStep(h) { const prevS = TR[car.idx].s; step(h); lapTick(h, prevS); }

// Drift score. Returns true when a skid mark should be added.
export function driftTick(dt) {
  if (Math.abs(car.beta) > 0.087 && car.vx > 8) {
    sim.drift += Math.abs(car.beta) * car.vx * dt;
    return Math.random() < 0.6;
  }
  return false;
}

const DEFAULTS = { rotary: false, rain: false, wiper: 'int', dwell: 4, ground: false, flat: false, inerter: false, assist: true };

// Node helper: drive the sim for `seconds`. opts = {cfg, pilot, h, freshLaps, onStep}
export function runSim(seconds, opts = {}) {
  const h = opts.h || 1 / 240, pilot = opts.pilot !== false, fresh = opts.freshLaps !== false;
  Object.assign(cfg, { rotary: false, rain: false, ground: false, inerter: false, flat: false, assist: true }, opts.cfg);
  resetAll();
  if (fresh) { lap.best = null; lap.list.length = 0; lap.n = 0; }
  auto.on = !!pilot;
  let grass = 0, kerb = 0, maxBeta = 0, warnAt = null;
  const steps = Math.round(seconds / h);
  for (let n = 0; n < steps; n++) {
    if (pilot) testDriver();
    simStep(h);
    if (car.surface === 'grass') grass += h;
    if (car.surface === 'kerb') kerb += h;
    maxBeta = Math.max(maxBeta, Math.abs(car.beta));
    if (tire.warn && warnAt === null) warnAt = +(n * h).toFixed(1);
    if (opts.onStep) opts.onStep(n * h);
  }
  const out = { laps: lap.list.slice().reverse(), maxBetaDeg: maxBeta * 180 / Math.PI, grass, kerb, warnAt, tireWarn: tire.warn };
  Object.assign(cfg, DEFAULTS);
  auto.on = false;
  return out;
}
