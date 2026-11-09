import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRibbon, buildStrip, kerbQuads, dashQuads, startLineQuad } from '../public/sim/src/view3d.js';
import { TR, NTR, W2 } from '../public/sim/src/track.js';

test('ribbon: 2*NTR vertices, every edge point is exactly W2 from the centreline', () => {
  const { positions, indices } = buildRibbon(TR, W2);
  assert.equal(positions.length / 3, 2 * NTR);
  for (let i = 0; i < NTR; i++) {
    for (const k of [0, 1]) {
      const x = positions[(2 * i + k) * 3], z = positions[(2 * i + k) * 3 + 2];
      assert.ok(Math.abs(Math.hypot(x - TR[i].x, z - TR[i].y) - W2) < 1e-3);
    }
    // left and right on opposite sides
    const lx = positions[2 * i * 3] - TR[i].x, lz = positions[2 * i * 3 + 2] - TR[i].y;
    const rx = positions[(2 * i + 1) * 3] - TR[i].x, rz = positions[(2 * i + 1) * 3 + 2] - TR[i].y;
    assert.ok(lx * rx + lz * rz < 0);
  }
});

test('ribbon: indices valid, closed loop, 2 triangles per segment', () => {
  const { positions, indices } = buildRibbon(TR, W2);
  assert.equal(indices.length, NTR * 6);
  for (const ix of indices) assert.ok(ix >= 0 && ix < positions.length / 3);
  assert.ok(indices.includes(2 * NTR - 1) && indices.includes(0));
});

test('strip offsets are respected', () => {
  const { positions } = buildStrip(TR, 3, 5, 0.5);
  assert.ok(Math.abs(Math.hypot(positions[0] - TR[0].x, positions[2] - TR[0].y) - 3) < 1e-3);
  assert.ok(Math.abs(Math.hypot(positions[3] - TR[0].x, positions[5] - TR[0].y) - 5) < 1e-3);
  assert.equal(positions[1], 0.5);
});

test('kerb quads only where TR.kerb, on the outer 1.2 m, colours alternate', () => {
  const k = kerbQuads(TR, W2);
  assert.ok(k.quads.length > 0);
  assert.equal(k.positions.length / 3, k.quads.length * 4);
  assert.equal(k.colors.length, k.positions.length);
  for (const ix of k.indices) assert.ok(ix < k.positions.length / 3);
  k.quads.forEach((q, n) => {
    assert.ok(TR[q.i].kerb && TR[(q.i + 1) % NTR].kerb);
    const d = (v) => Math.hypot(k.positions[(n * 4 + v) * 3] - TR[q.i].x, k.positions[(n * 4 + v) * 3 + 2] - TR[q.i].y);
    assert.ok(Math.abs(d(0) - (W2 - 1.2)) < 1e-3 && Math.abs(d(1) - W2) < 1e-3);
  });
  const nonKerb = TR.filter(p => !p.kerb).length;
  assert.ok(nonKerb > 0, 'track has non-kerb stretches');
  assert.ok(k.quads.some(q => q.red) && k.quads.some(q => !q.red));
});

test('start line spans the track at TR[0]; dashes are valid', () => {
  const s = startLineQuad(TR, W2);
  assert.ok(Math.abs(Math.hypot(s.positions[0] - TR[0].x, s.positions[2] - TR[0].y) - W2) < 1e-3);
  const d = dashQuads(TR);
  for (const ix of d.indices) assert.ok(ix < d.positions.length / 3);
});
