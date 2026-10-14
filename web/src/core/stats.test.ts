import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseRecording } from './messages';
import { BINS, LATE_MS, barFraction, binIndex, percentile } from './stats';

describe('percentile (nearest rank, same as the Python side)', () => {
  it('matches the textbook example', () => {
    const v = [15, 20, 35, 40, 50];
    expect(percentile(v, 30)).toBe(20);
    expect(percentile(v, 40)).toBe(20);
    expect(percentile(v, 50)).toBe(35);
    expect(percentile(v, 100)).toBe(50);
    expect(percentile([7], 95)).toBe(7);
  });

  it('ignores input order and does not change its input', () => {
    const v = [50, 15, 40, 20, 35];
    expect(percentile(v, 50)).toBe(35);
    expect(v).toEqual([50, 15, 40, 20, 35]);
  });

  it('returns null for nonsense instead of a made-up number', () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([1], 0)).toBeNull();
    expect(percentile([1], 101)).toBeNull();
    expect(percentile([1], Number.NaN)).toBeNull();
  });

  it('always returns a value that was measured', () => {
    let seed = 7;
    const rand = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
    for (let n = 0; n < 200; n++) {
      const v = Array.from({ length: 1 + Math.floor(rand() * 60) }, () => rand() * 1000);
      const p = 1 + rand() * 99;
      expect(v).toContain(percentile(v, p));
    }
  });

  it('agrees with the numbers the Python pipeline wrote into the recording', () => {
    const rec = parseRecording(readFileSync(new URL('../../public/replay.json', import.meta.url), 'utf8'));
    const latencies: number[] = [];
    for (const m of rec?.messages ?? []) {
      if (m.type === 'batch') for (const s of m.samples) latencies.push(s.rx - s.ts);
    }
    const end = JSON.parse(readFileSync(new URL('../../public/replay.json', import.meta.url), 'utf8')).at(-1);
    expect(percentile(latencies, 50)).toBe(end.summary.metrics.p50_ms);
    expect(percentile(latencies, 95)).toBe(end.summary.metrics.p95_ms);
    expect(Math.max(...latencies)).toBe(end.summary.metrics.max_ms);
    expect(latencies.filter((l) => l > LATE_MS).length).toBe(end.summary.metrics.backfilled);
  });
});

describe('histogram bins', () => {
  it('puts each latency in exactly one bin, edges included on the upper side', () => {
    expect(binIndex(0)).toBe(0);
    expect(binIndex(49.9)).toBe(0);
    expect(binIndex(50)).toBe(1);
    expect(binIndex(249)).toBe(2);
    expect(binIndex(250)).toBe(3);
    expect(binIndex(2499)).toBe(5);
    expect(binIndex(2500)).toBe(6);
    expect(binIndex(1e9)).toBe(BINS.length - 1);
  });

  it('puts garbage in the first bin rather than nowhere', () => {
    expect(binIndex(Number.NaN)).toBe(0);
    expect(binIndex(-5)).toBe(0);
    expect(binIndex(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it('has bins that touch with no gap and no overlap', () => {
    for (let i = 1; i < BINS.length; i++) expect(BINS[i]?.from).toBe(BINS[i - 1]?.to);
    expect(BINS.at(-1)?.to).toBe(Number.POSITIVE_INFINITY);
  });

  it('draws bars on a log scale that never exceeds the box', () => {
    expect(barFraction(0, 100)).toBe(0);
    expect(barFraction(100, 100)).toBe(1);
    expect(barFraction(10, 100)).toBeGreaterThan(0.4);
    expect(barFraction(5, 0)).toBe(0);
    expect(barFraction(Number.NaN, 10)).toBe(0);
    for (const c of [1, 2, 99, 100]) expect(barFraction(c, 100)).toBeLessThanOrEqual(1);
  });
});
