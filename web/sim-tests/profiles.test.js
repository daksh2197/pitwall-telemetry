import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { STANDARD_PROFILE, validateProfile, readPedal, splitCombined, readControls } from '../public/sim/src/profiles.js';

const clone = o => JSON.parse(JSON.stringify(o));
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, a + ' vs ' + b);

test('separate pedal axes, rest -1 to full 1', () => {
  const s = { type: 'axis', axis: 2, rest: -1, full: 1 };
  near(readPedal(s, [0, 0, -1], []), 0);
  near(readPedal(s, [0, 0, 0], []), 0.5);
  near(readPedal(s, [0, 0, 1], []), 1);
  near(readPedal(s, [0, 0, -3], []), 0);
});
test('inverted pedal, rest 1 to full -1', () => {
  const s = { type: 'axis', axis: 1, rest: 1, full: -1 };
  near(readPedal(s, [0, 1], []), 0);
  near(readPedal(s, [0, 0], []), 0.5);
  near(readPedal(s, [0, -1], []), 1);
});
test('button pedals', () => {
  const b = []; b[7] = { value: 0.6, pressed: true };
  near(readPedal({ type: 'button', index: 7 }, [], b), 0.6);
  near(readPedal({ type: 'button', index: 6 }, [], b), 0);
});
test('combined axis split', () => {
  const c = { axis: 1, rest: 0, gas_end: -1, brake_end: 1 };
  assert.deepEqual(splitCombined(-1, c), { thr: 1, brk: 0 });
  assert.deepEqual(splitCombined(0.5, c), { thr: 0, brk: 0.5 });
  assert.deepEqual(splitCombined(0, c), { thr: 0, brk: 0 });
  const p = clone(STANDARD_PROFILE); p.combined = c;
  const r = readControls(p, { axes: [0, -0.5], buttons: [] });
  near(r.thr, 0.5); near(r.brk, 0);
});
test('steer deadzone, invert, sens', () => {
  const gp = v => ({ axes: [v], buttons: [] });
  const p = clone(STANDARD_PROFILE);
  assert.equal(readControls(p, gp(0.01)).steer, 0);
  near(readControls(p, gp(0.5)).steer, 0.5);
  p.steer.invert = true; near(readControls(p, gp(0.5)).steer, -0.5);
  p.steer.sens = 1.5; near(readControls(p, gp(0.5)).steer, -0.75);
  assert.equal(readControls(p, gp(1)).steer, -1);
});
test('standard profile reads buttons', () => {
  const b = []; b[7] = { value: 1, pressed: true }; b[6] = { value: 0.25, pressed: false };
  const r = readControls(clone(STANDARD_PROFILE), { axes: [0.3], buttons: b });
  near(r.thr, 1); near(r.brk, 0.25); near(r.steer, 0.3);
});
test('validateProfile', () => {
  assert.equal(validateProfile(STANDARD_PROFILE).ok, true);
  for (const bad of [null, 5, 'x', [], {}, { format: 'nope' }]) assert.equal(validateProfile(bad).ok, false);
  const a = clone(STANDARD_PROFILE); a.throttle = { type: 'axis', axis: 'x', rest: 0, full: 0 };
  assert.equal(validateProfile(a).ok, false);
  const b = clone(STANDARD_PROFILE); b.steer.sens = -1;
  assert.equal(validateProfile(b).ok, false);
  const c = clone(STANDARD_PROFILE); c.combined = { axis: 1, rest: 0 };
  assert.equal(validateProfile(c).ok, false);
  const e = clone(STANDARD_PROFILE); e.combined = { axis: 1, rest: 0, gas_end: -1, brake_end: 1 };
  assert.equal(validateProfile(e).ok, true);
});
test('profiles/standard.json equals STANDARD_PROFILE', () => {
  const j = JSON.parse(readFileSync(new URL('../public/sim/profiles/standard.json', import.meta.url), 'utf8'));
  assert.deepEqual(j, STANDARD_PROFILE);
});
