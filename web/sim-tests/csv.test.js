import test from 'node:test';
import assert from 'node:assert/strict';
import { lapsToCSV } from '../public/sim/src/csv.js';

test('header and rows', () => {
  const list = [
    { n: 1, time: 71.23456, valid: true, delta: null, switches: { rotary: false, rain: true, ground: false, inerter: false, flat: false, assist: true }, auto: false, top: 201.5, off: 0 },
    { n: 2, time: 70.1, valid: false, delta: -1.13456, switches: { rotary: true, rain: false, ground: true, inerter: true, flat: true, assist: false }, auto: true, top: 210, off: 2.25 }
  ];
  const lines = lapsToCSV(list).trim().split('\n');
  assert.equal(lines[0], 'lap,time_s,valid,delta_s,rotary,rain,ground,inerter,soft_rl,aids,test_driver,top_kmh,off_track_s');
  assert.equal(lines[1], '1,71.235,true,,false,true,false,false,false,true,false,201.500,0.000');
  assert.equal(lines[2], '2,70.100,false,-1.135,true,false,true,true,true,false,true,210.000,2.250');
  assert.equal(lines.length, 3);
});
test('empty list gives header only', () => {
  assert.equal(lapsToCSV([]).trim().split('\n').length, 1);
});
