import { describe, expect, it } from 'vitest';
import { fmtClock, fmtDuration, fmtFixed, fmtInt } from './format';

describe('numbers on screen', () => {
  it('never prints NaN, Infinity, undefined or -0', () => {
    const awful = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, undefined, null, -0, -0.4, -0.0001];
    for (const x of awful) {
      for (const text of [fmtInt(x), fmtFixed(x, 2), fmtDuration(x)]) {
        expect(text).not.toMatch(/NaN|Infinity|undefined|null/);
        expect(text).not.toMatch(/^-0(\.0+)?( |$)/);
      }
    }
  });

  it('groups thousands and rounds', () => {
    expect(fmtInt(1234.4)).toBe('1,234');
    expect(fmtInt(1234.5)).toBe('1,235');
    expect(fmtInt(0)).toBe('0');
    expect(fmtInt(-0.4)).toBe('0');
    expect(fmtInt(-1234)).toBe('-1,234');
  });

  it('keeps decimals and drops the sign of a rounded-away negative', () => {
    expect(fmtFixed(3.14159, 2)).toBe('3.14');
    expect(fmtFixed(-0.004, 2)).toBe('0.00');
    expect(fmtFixed(-1.5, 1)).toBe('-1.5');
  });

  it('writes durations the way a person would say them', () => {
    expect(fmtDuration(46)).toBe('46 ms');
    expect(fmtDuration(999.4)).toBe('999 ms');
    expect(fmtDuration(1000)).toBe('1.0 s');
    expect(fmtDuration(5144)).toBe('5.1 s');
    expect(fmtDuration(-20)).toBe('0 ms');
  });

  it('writes the lap clock', () => {
    expect(fmtClock(0)).toBe('0:00');
    expect(fmtClock(59_999)).toBe('0:59');
    expect(fmtClock(83_000)).toBe('1:23');
    expect(fmtClock(-5)).toBe('0:00');
    expect(fmtClock(Number.NaN)).toBe('0:00');
  });
});
