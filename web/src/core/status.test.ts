import { describe, expect, it } from 'vitest';
import type { Sample } from './messages';
import { linkStatus } from './status';

const newest = (ts: number, rx: number): Sample => ({ seq: 1, ts, rx, id: 1, tx: 1, v: {} });

describe('link status', () => {
  it('waits for the first frame', () => {
    expect(linkStatus({ rxMs: 0, newest: null, ended: false }).state).toBe('waiting');
  });

  it('is live when the newest frame is recent and on time', () => {
    const s = linkStatus({ rxMs: 1000, newest: newest(955, 1000), ended: false });
    expect(s.state).toBe('live');
    expect(s.behindMs).toBe(45);
    expect(s.detail).toBe('45 ms behind the car.');
  });

  it('is stalled when nothing has been delivered for more than half a second', () => {
    expect(linkStatus({ rxMs: 1500, newest: newest(1410, 1450), ended: false }).state).toBe('live');
    const s = linkStatus({ rxMs: 6200, newest: newest(955, 1000), ended: false });
    expect(s.state).toBe('no-data');
    expect(s.detail).toBe('Nothing for 5.2 s.');
    expect(s.behindMs).toBe(5245);
  });

  it('is catching up when frames are arriving but are old', () => {
    const s = linkStatus({ rxMs: 17_300, newest: newest(14_000, 17_290), ended: false });
    expect(s.state).toBe('catching-up');
    expect(s.detail).toBe('Backfilling, 3.3 s behind.');
  });

  it('says finished once the run has ended, whatever else is true', () => {
    expect(linkStatus({ rxMs: 99_999, newest: newest(1, 2), ended: true }).state).toBe('finished');
  });

  it('keeps the short label the same while the numbers change, so screen readers hear a change once', () => {
    const a = linkStatus({ rxMs: 2000, newest: newest(1950, 1990), ended: false });
    const b = linkStatus({ rxMs: 2100, newest: newest(2040, 2090), ended: false });
    expect(a.label).toBe(b.label);
    expect(a.detail).not.toBe(b.detail);
  });

  it('never reports a negative lag', () => {
    expect(linkStatus({ rxMs: 10, newest: newest(500, 600), ended: false }).behindMs).toBe(0);
  });
});
