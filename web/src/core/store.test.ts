import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Message, Sample } from './messages';
import { parseRecording } from './messages';
import { Store } from './store';

const link = { delivered: 0, lost: 0, duplicates: 0, late: 0, malformed: 0, held: 0, behind: 0 };
const batch = (rx_ms: number, samples: Sample[]): Message => ({ type: 'batch', rx_ms, samples, link });
const sample = (seq: number, ts: number, rx: number, v: Record<string, number> = { Speed: 100 }): Sample => ({
  seq,
  ts,
  rx,
  id: 257,
  tx: 1,
  v,
});

describe('the store', () => {
  it('builds series by car time and remembers the latest value of each signal', () => {
    const s = new Store();
    s.ingest(batch(50, [sample(0, 0, 45, { Speed: 100, Gear: 3 }), sample(1, 10, 55, { Speed: 101 })]));
    expect(s.series.get('Speed')?.t).toEqual([0, 10]);
    expect(s.series.get('Speed')?.y).toEqual([100, 101]);
    expect(s.latest).toEqual({ Speed: 101, Gear: 3 });
    expect(s.rxMs).toBe(50);
  });

  it('flags a sample as late only above 250 ms', () => {
    const s = new Store();
    s.ingest(batch(500, [sample(0, 0, 250), sample(1, 10, 261), sample(2, 20, 270)]));
    expect(s.series.get('Speed')?.late).toEqual([false, true, false]);
    expect(s.lateCount).toBe(1);
  });

  it('counts latencies into bins and keeps them for the percentiles', () => {
    const s = new Store();
    s.ingest(batch(10_000, [sample(0, 0, 45), sample(1, 10, 80), sample(2, 20, 5020)]));
    expect(s.binCounts.reduce((a, b) => a + b, 0)).toBe(3);
    expect(s.binCounts[0]).toBe(1);
    expect(s.binCounts[6]).toBe(1);
    expect(s.latencyStats()).toEqual({ n: 3, p50: 70, p95: 5000, max: 5000 });
  });

  it('refuses a sample that is not newer than the newest, and counts it', () => {
    const s = new Store();
    s.ingest(batch(100, [sample(0, 50, 90)]));
    s.ingest(batch(150, [sample(1, 50, 120), sample(2, 40, 130), sample(3, 60, 140)]));
    expect(s.series.get('Speed')?.t).toEqual([50, 60]);
    expect(s.ignored).toBe(2);
  });

  it('never lets the clock run backwards', () => {
    const s = new Store();
    s.ingest(batch(200, []));
    s.ingest(batch(100, []));
    expect(s.rxMs).toBe(200);
  });

  it('marks the end and keeps the summary', () => {
    const s = new Store();
    s.ingest({ type: 'end', rx_ms: 9, summary: { generated: 1, delivered: 1, lost: 0, unresolved: 0 } });
    expect(s.ended).toBe(true);
    expect(s.summary?.generated).toBe(1);
  });

  it('resets to empty, and its version keeps climbing', () => {
    const s = new Store();
    s.ingest(batch(50, [sample(0, 0, 45)]));
    const before = s.version;
    s.reset();
    expect(s.series.size).toBe(0);
    expect(s.newest).toBeNull();
    expect(s.version).toBeGreaterThan(before);
  });

  it('replays the whole recording to the numbers the Python side reported', () => {
    const rec = parseRecording(readFileSync(new URL('../../public/replay.json', import.meta.url), 'utf8'));
    const s = new Store();
    for (const m of rec?.messages ?? []) s.ingest(m);
    const end = rec?.messages.at(-1);
    expect(end?.type).toBe('end');
    if (end?.type !== 'end') return;
    expect(s.latencies.length).toBe(end.summary.delivered);
    expect(s.link.delivered).toBe(end.summary.delivered);
    expect(s.ignored).toBe(0);
    expect(s.ended).toBe(true);
    // Speed is one of three messages at 100 Hz, so a 40 s run has 4000 of them.
    expect(s.series.get('Speed')?.t.length).toBe(4000);
    expect(s.series.get('Gear')?.t.length).toBe(800);
  });
});
