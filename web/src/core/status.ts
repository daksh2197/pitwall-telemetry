/** Is the link live, stalled or catching up? Worked out only from what the pit wall received. */

import { fmtDuration } from './format';
import type { Sample } from './messages';
import { LATE_MS, STALL_MS } from './stats';

export type LinkState = 'waiting' | 'live' | 'catching-up' | 'no-data' | 'finished';

export interface Status {
  state: LinkState;
  label: string; // short, for the chip and for screen readers: only changes when the state does
  detail: string; // longer, with numbers
  behindMs: number | null;
}

const LABELS: Record<LinkState, string> = {
  waiting: 'Waiting',
  live: 'Live',
  'catching-up': 'Catching up',
  'no-data': 'No data',
  finished: 'Finished',
};

export function linkStatus(input: { rxMs: number; newest: Sample | null; ended: boolean }): Status {
  const { rxMs, newest, ended } = input;
  if (ended) {
    return { state: 'finished', label: LABELS.finished, detail: 'The run is over.', behindMs: null };
  }
  if (!newest) {
    return { state: 'waiting', label: LABELS.waiting, detail: 'Waiting for the first frame.', behindMs: null };
  }
  const behindMs = Math.max(0, rxMs - newest.ts);
  const silentMs = Math.max(0, rxMs - newest.rx);
  if (silentMs > STALL_MS) {
    return {
      state: 'no-data',
      label: LABELS['no-data'],
      detail: `Nothing for ${fmtDuration(silentMs)}.`,
      behindMs,
    };
  }
  if (behindMs > LATE_MS) {
    return {
      state: 'catching-up',
      label: LABELS['catching-up'],
      detail: `Backfilling, ${fmtDuration(behindMs)} behind.`,
      behindMs,
    };
  }
  return { state: 'live', label: LABELS.live, detail: `${fmtDuration(behindMs)} behind the car.`, behindMs };
}
