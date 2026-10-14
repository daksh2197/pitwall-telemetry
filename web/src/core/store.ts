/**
 * Everything the dashboard knows, built up message by message.
 *
 * Samples come in sequence order, which is also car-time order, so each signal's series only
 * ever grows at the end. That is what makes drawing cheap and a backfill look like a gap
 * filling in from left to right.
 */

import type { LinkStats, Message, Meta, Sample, Summary } from './messages';
import { BINS, LATE_MS, binIndex, percentile } from './stats';

export interface Series {
  t: number[]; // car time, ms
  y: number[];
  late: boolean[]; // arrived more than LATE_MS after the car made it
}

export const NO_LINK: LinkStats = {
  delivered: 0,
  lost: 0,
  duplicates: 0,
  late: 0,
  malformed: 0,
  held: 0,
  behind: 0,
};

export class Store {
  meta: Meta | null = null;
  summary: Summary | null = null;
  rxMs = 0; // the pit wall's clock: the time of the newest batch
  link: LinkStats = NO_LINK;
  newest: Sample | null = null;
  latest: Record<string, number> = {};
  series = new Map<string, Series>();
  latencies: number[] = [];
  binCounts: number[] = BINS.map(() => 0);
  lateCount = 0;
  resentCount = 0;
  ignored = 0; // things thrown away for being malformed
  ended = false;
  /** Bumps on every change, so the screen can tell when it needs to redraw. */
  version = 0;

  private sortedCache: { n: number; p50: number | null; p95: number | null; max: number | null } | null = null;

  reset(): void {
    const next = this.version + 1;
    Object.assign(this, new Store());
    this.version = next; // keeps going up, so the screen never mistakes a fresh store for an old one
  }

  ingest(message: Message): void {
    this.version++;
    if (message.type === 'hello') {
      this.meta = message.meta;
      return;
    }
    this.rxMs = Math.max(this.rxMs, message.rx_ms);
    if (message.type === 'end') {
      this.ended = true;
      this.summary = message.summary;
      return;
    }
    this.link = message.link;
    for (const s of message.samples) this.addSample(s);
  }

  private addSample(s: Sample): void {
    // A sample older than the newest one is a repeat or a reordering. The link never does that,
    // but a stranger's server might, and the chart's search code relies on time going forward.
    if (this.newest && s.ts <= this.newest.ts) {
      this.ignored++;
      return;
    }
    const latency = s.rx - s.ts;
    const late = latency > LATE_MS;
    for (const [name, value] of Object.entries(s.v)) {
      let series = this.series.get(name);
      if (!series) {
        series = { t: [], y: [], late: [] };
        this.series.set(name, series);
      }
      series.t.push(s.ts);
      series.y.push(value);
      series.late.push(late);
      this.latest[name] = value;
    }
    this.newest = s;
    this.latencies.push(latency);
    this.binCounts[binIndex(latency)] = (this.binCounts[binIndex(latency)] ?? 0) + 1;
    if (late) this.lateCount++;
    if (s.tx > 1) this.resentCount++;
  }

  latencyStats(): { n: number; p50: number | null; p95: number | null; max: number | null } {
    const n = this.latencies.length;
    if (this.sortedCache?.n === n) return this.sortedCache;
    let max: number | null = null;
    for (const l of this.latencies) if (max === null || l > max) max = l;
    this.sortedCache = { n, p50: percentile(this.latencies, 50), p95: percentile(this.latencies, 95), max };
    return this.sortedCache;
  }
}
