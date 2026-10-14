import { describe, expect, it } from 'vitest';
import type { Series } from '../core/store';
import { MAX_JOIN_MS, lateRanges, lowerBound, niceMax, strokes, ticks, viewFor } from './geometry';

const series = (t: number[], late: boolean[] = t.map(() => false)): Series => ({ t, y: t.map((x) => x / 10), late });

describe('the view', () => {
  it('ends at now and starts a window earlier', () => {
    expect(viewFor(20_000, 15_000)).toEqual({ t0: 5000, t1: 20_000 });
  });
  it('copes with a clock that is not there yet', () => {
    expect(viewFor(Number.NaN, 15_000)).toEqual({ t0: -15_000, t1: 0 });
    expect(viewFor(-4, 15_000).t1).toBe(0);
  });
});

describe('lowerBound', () => {
  const a = [0, 10, 20, 30];
  it('finds the first element at or past x', () => {
    expect(lowerBound(a, -5)).toBe(0);
    expect(lowerBound(a, 0)).toBe(0);
    expect(lowerBound(a, 11)).toBe(2);
    expect(lowerBound(a, 30)).toBe(3);
    expect(lowerBound(a, 31)).toBe(4);
    expect(lowerBound([], 5)).toBe(0);
  });
});

describe('strokes', () => {
  const view = { t0: 0, t1: 1000 };

  it('joins samples that are close together into one stroke', () => {
    const out = strokes(series([0, 10, 20, 30]), view);
    expect(out).toHaveLength(1);
    expect(out[0]?.t).toEqual([0, 10, 20, 30]);
  });

  it('breaks the line at a gap bigger than the join limit and not at the limit itself', () => {
    expect(strokes(series([0, 10, 10 + MAX_JOIN_MS]), view)).toHaveLength(1);
    const out = strokes(series([0, 10, 10 + MAX_JOIN_MS + 1, 300]), view);
    expect(out.map((s) => s.t)).toEqual([[0, 10], [161, 300]]);
  });

  it('changes colour with no hairline break: the new stroke starts where the old one ended', () => {
    const out = strokes(series([0, 10, 20, 30], [false, false, true, true]), view);
    expect(out.map((s) => [s.late, s.t])).toEqual([
      [false, [0, 10]],
      [true, [10, 20, 30]],
    ]);
  });

  it('keeps one sample before the window so the line enters from the edge', () => {
    const out = strokes(series([0, 450, 520, 600, 700, 800, 900, 1000, 1100]), { t0: 500, t1: 1000 });
    expect(out[0]?.t[0]).toBe(450);
    expect(out[0]?.t.at(-1)).toBe(1100);
  });

  it('draws nothing for an empty series, an unknown signal or a view with nothing in it', () => {
    expect(strokes(undefined, view)).toEqual([]);
    expect(strokes(series([]), view)).toEqual([]);
    expect(strokes(series([0, 10]), { t0: 5000, t1: 6000 })).toEqual([]);
  });

  it('draws a lone sample as a stroke of one point', () => {
    expect(strokes(series([500]), view)[0]?.t).toEqual([500]);
  });
});

describe('late ranges', () => {
  it('lists the late samples as blocks, merging ones less than 30 ms apart, and ignores on-time ones', () => {
    const s = series([0, 10, 20, 30, 40, 50, 300, 310], [false, true, true, false, true, true, true, true]);
    expect(lateRanges(s, { t0: 0, t1: 1000 })).toEqual([
      [10, 50],
      [300, 310],
    ]);
  });

  it('splits blocks that are 40 ms apart', () => {
    const s = series([0, 10, 50, 60], [true, true, true, true]);
    expect(lateRanges(s, { t0: 0, t1: 1000 })).toEqual([
      [0, 10],
      [50, 60],
    ]);
  });

  it('gives nothing for no series or no late samples', () => {
    expect(lateRanges(undefined, { t0: 0, t1: 1000 })).toEqual([]);
    expect(lateRanges(series([0, 10, 20]), { t0: 0, t1: 1000 })).toEqual([]);
  });
});

describe('axes', () => {
  it('rounds a maximum up to a nice number and never below the floor', () => {
    expect(niceMax(0, 50, 300)).toBe(300);
    expect(niceMax(290, 50, 300)).toBe(300);
    expect(niceMax(301, 50, 300)).toBe(350);
    expect(niceMax(Number.NaN, 50, 300)).toBe(300);
  });

  it('puts a tick every 5 seconds inside the view and none before zero', () => {
    expect(ticks({ t0: -3000, t1: 12_000 }, 5000)).toEqual([0, 5000, 10_000]);
    expect(ticks({ t0: 5001, t1: 9999 }, 5000)).toEqual([]);
    expect(ticks({ t0: 5000, t1: 10_000 }, 5000)).toEqual([5000, 10_000]);
  });
});
