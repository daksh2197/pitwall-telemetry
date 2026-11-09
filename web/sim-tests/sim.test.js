import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cfg, auto } from '../public/sim/src/state.js';
import { TR, NTR, NB, binOf } from '../public/sim/src/track.js';
import { car } from '../public/sim/src/physics.js';
import { lap, lapTick, resetLap, onLap } from '../public/sim/src/laps.js';
import { drops, wiperTick, clearDrops } from '../public/sim/src/wiper.js';
import { runSim, resetAll } from '../public/sim/src/sim.js';

// Deterministic Math.random (LCG) for tests that depend on the tire-monitor noise.
function seeded(fn, seed = 12345) {
  const orig = Math.random;
  let s = seed;
  Math.random = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  try { return fn(); } finally { Math.random = orig; }
}
const bestValid = r => Math.min(...r.laps.filter(l => l.valid).map(l => l.time));

const stock = seeded(() => runSim(260));
const rain = seeded(() => runSim(260, { cfg: { rain: true } }));
const ground = seeded(() => runSim(260, { cfg: { ground: true } }));
const flat = seeded(() => runSim(260, { cfg: { flat: true } }));
const bStock = bestValid(stock), bRain = bestValid(rain), bGround = bestValid(ground), bFlat = bestValid(flat);
console.log(`best laps: stock ${bStock.toFixed(2)} (v1 92.02), ground ${bGround.toFixed(2)} (v1 90.47), rain ${bRain.toFixed(2)} (v1 108.17), flat ${bFlat.toFixed(2)}`);

test('aids on: sideslip stays under 10 degrees over a lap', () => {
  const r = seeded(() => runSim(200));
  assert.ok(r.laps.length >= 1);
  assert.ok(r.maxBetaDeg < 10, `max beta ${r.maxBetaDeg}`);
});

test('test driver completes a valid lap in 60-140 s', () => {
  const v = stock.laps.filter(l => l.valid);
  assert.ok(v.length >= 1);
  assert.ok(v[0].time > 60 && v[0].time < 140, `time ${v[0].time}`);
});

test('rain is slower than dry', () => assert.ok(bRain > bStock, `${bRain} vs ${bStock}`));
test('ground effect is not slower than stock', () => assert.ok(bGround <= bStock, `${bGround} vs ${bStock}`));

test('regression: lap times near v1 reference (loose, pilot differs)', () => {
  assert.ok(Math.abs(bStock - 92.02) < 3, `stock ${bStock}`);
  assert.ok(Math.abs(bGround - 90.47) < 3, `ground ${bGround}`);
  assert.ok(Math.abs(bRain - 108.17) < 3, `rain ${bRain}`);
});

test('tire monitor: flags rear-left when soft, never when full', () => {
  assert.equal(flat.tireWarn, 'rear-left');
  assert.ok(flat.warnAt !== null && flat.warnAt <= 10, `warnAt ${flat.warnAt}`);
  assert.equal(stock.warnAt, null);
  assert.equal(stock.tireWarn, null);
});

// Drive the lap timer directly by placing the car on consecutive track points.
function place(i) { car.idx = i; car.x = TR[i].x; car.y = TR[i].y; car.vx = 20; car.surface = 'track'; }
function driveLap(dt, startIdx) {
  // one full pass over every track point; returns after the crossing tick
  let prev = startIdx;
  for (let n = 1; n <= NTR; n++) { const i = (startIdx + n) % NTR; place(i); lapTick(dt, TR[prev].s); prev = i; }
}

test('lap timer: best, delta, incomplete laps', () => {
  auto.on = false; resetAll(); lap.best = null; lap.list.length = 0; lap.n = 0;
  const heard = []; onLap(r => heard.push(r)); onLap(() => { throw new Error('listener errors are swallowed'); });
  place(NTR - 2);
  driveLap(0.05, NTR - 2);              // crosses the line: starts timing, no lap recorded yet
  assert.equal(lap.n, 0); assert.ok(lap.started);
  driveLap(0.05, NTR - 2);              // lap 1: NTR ticks from crossing to crossing
  assert.equal(lap.n, 1);
  const t1 = lap.list[0].time;
  assert.ok(Math.abs(t1 - NTR * 0.05) < 1e-6, `t1 ${t1}`);
  const times = lap.best.times;
  assert.equal(times.length, NB);
  for (let b = 1; b < NB; b++) assert.ok(times[b] >= times[b - 1], 'times monotonic');
  const mid = Math.floor(NTR / 2); // bin time = ticks since the line * dt, within one bin of slack
  assert.ok(Math.abs(times[binOf(TR[mid].s)] - mid * 0.05) < 0.05 * NTR / NB * 2);
  assert.equal(lap.list[0].delta, null);
  assert.equal(lap.list[0].off, 0);
  // lap 2, slower
  driveLap(0.06, NTR - 2);
  assert.equal(lap.n, 2);
  const t2 = lap.list[0].time;
  // lap 2 began on the 2nd tick of the previous pass (dt 0.05): NTR-2 ticks of 0.05 + 2 ticks of 0.06
  assert.ok(Math.abs(t2 - ((NTR - 2) * 0.05 + 2 * 0.06)) < 1e-6, `t2 ${t2}`);
  assert.ok(Math.abs(lap.list[0].delta - (t2 - t1)) < 1e-9);
  assert.equal(lap.best.time, t1, 'slower lap does not replace best');
  assert.equal(lap.last, t2);
  assert.equal(heard.length, 2);
  // incomplete lap: skip most of the track (teleport), cross the line again
  const nBefore = lap.n;
  resetLap(); // discard the partly driven lap 3
  place(0); lapTick(0.05, TR[NTR - 1].s);      // restarts timing
  for (let i = 1; i < NTR * 0.5; i++) { place(i); lapTick(0.05, TR[i - 1].s); }
  place(NTR - 1); lapTick(0.05, TR[NTR - 2].s);
  place(0); lapTick(0.05, TR[NTR - 1].s);      // crossing with ~50% bins visited
  assert.equal(lap.n, nBefore, 'incomplete lap not counted');
  resetLap(); assert.equal(lap.started, false);
});

test('wiper clears drops with intermittent mode, not with off', () => {
  const fill = () => { clearDrops(); for (let i = 0; i < 200; i++) drops.push({ x: i / 200, y: (i * 7 % 100) / 108, r: 0.01 }); };
  const run = () => { for (let i = 0; i < 150; i++) wiperTick(1 / 60, 0); };
  Object.assign(cfg, { wiper: 'int', dwell: 1, rain: false });
  fill(); run();
  assert.equal(drops.length, 0);
  cfg.wiper = 'off';
  fill(); run();
  assert.equal(drops.length, 200);
  Object.assign(cfg, { wiper: 'int', dwell: 4, rain: false });
  clearDrops();
});
