// Lap timer and the 1988-style reference-lap delta. DOM-free.
import { cfg, auto } from './state.js';
import { store } from './store.js';
import { TR, LEN, NB, binOf } from './track.js';
import { car } from './physics.js';

const BEST_KEY = 'pitwall-sim-best-v1';
export const lap = { started: false, t: 0, visited: new Uint8Array(NB), cur: new Float64Array(NB).fill(NaN), off: 0, n: 0, best: null, list: [], last: undefined, auto: false };
const listeners = [];

export function onLap(fn) { listeners.push(fn); }
export function loadBest() { lap.best = store.get(BEST_KEY); }
export function clearBest() { lap.best = null; store.set(BEST_KEY, null); }

export function resetLap() {
  lap.started = false; lap.t = 0; lap.visited.fill(0); lap.cur.fill(NaN); lap.off = 0;
}

export function lapTick(dt, prevS) {
  const s = TR[car.idx].s;
  if (lap.started) {
    lap.t += dt;
    const b = binOf(s);
    lap.visited[b] = 1; if (Number.isNaN(lap.cur[b])) lap.cur[b] = lap.t;
    if (auto.on) lap.auto = true;
    if (car.surface === 'grass') lap.off += dt;
  }
  car.top = Math.max(car.top, car.vx * 3.6);
  if (prevS > 0.85 * LEN && s < 0.15 * LEN && car.vx > 0) { // crossed the line forward
    if (lap.started) {
      const seen = lap.visited.reduce((a, v) => a + v, 0);
      if (seen >= NB * 0.9) {
        const valid = lap.off <= 1.5;
        const prevBest = lap.best ? lap.best.time : null;
        lap.n++;
        const rec = { n: lap.n, time: lap.t, valid, delta: prevBest !== null ? lap.t - prevBest : null, switches: { ...cfg }, auto: !!lap.auto, top: car.top, off: lap.off };
        lap.list.unshift(rec);
        if (valid && (!lap.best || lap.t < lap.best.time)) { lap.best = { time: lap.t, times: Array.from(lap.cur) }; store.set(BEST_KEY, lap.best); }
        lap.last = lap.t;
        for (const fn of listeners) { try { fn(rec); } catch (e) { /* listener errors must not stop the sim */ } }
      }
    }
    lap.started = true; lap.t = 0; lap.visited.fill(0); lap.cur.fill(NaN); lap.off = 0; lap.auto = auto.on; car.top = car.vx * 3.6;
  } else if (prevS < 0.15 * LEN && s > 0.85 * LEN && lap.started) { lap.started = false; } // went backwards over the line
}
