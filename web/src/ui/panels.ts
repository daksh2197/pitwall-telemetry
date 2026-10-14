/** Fills in the numbers on the page. Only touches the DOM when a value actually changed. */

import { fmtDuration, fmtInt } from '../core/format';
import type { Status } from '../core/status';
import { BINS, barFraction } from '../core/stats';
import type { Store } from '../core/store';

const RPM_LIMIT = 11_500; // the bar is full here. Matches car/profile.py.

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`index.html is missing #${id}`);
  return found as T;
}

function setText(node: HTMLElement, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}

export function buildHistogram(): void {
  const list = el('hist');
  list.replaceChildren(
    ...BINS.map((bin, i) => {
      const li = document.createElement('li');
      li.dataset.bin = String(i);
      const label = document.createElement('span');
      label.className = 'h-label';
      label.textContent = bin.label;
      const track = document.createElement('span');
      track.className = 'h-bar';
      track.appendChild(document.createElement('span'));
      const count = document.createElement('span');
      count.className = 'h-count';
      count.textContent = '0';
      li.append(label, track, count);
      return li;
    }),
  );
}

export function updatePanels(store: Store, status: Status, extraIgnored: number): void {
  // Chip
  const chip = el('chip');
  if (chip.dataset.state !== status.state) chip.dataset.state = status.state;
  setText(el('chip-label'), status.label);
  setText(el('chip-detail'), status.detail);
  el('now').dataset.stale = String(status.state !== 'live' && status.state !== 'finished');

  // Latest frame
  const v = store.latest;
  setText(el('r-speed'), fmtInt(v.Speed));
  const gear = v.Gear;
  setText(el('r-gear'), gear === undefined ? '–' : gear === 0 ? 'N' : fmtInt(gear));
  setText(el('r-rpm'), fmtInt(v.EngineRPM));
  const bar = el('r-rpm-bar');
  const pct = v.EngineRPM === undefined ? 0 : Math.min(100, Math.max(0, (v.EngineRPM / RPM_LIMIT) * 100));
  const width = `${pct.toFixed(1)}%`;
  if (bar.style.width !== width) bar.style.width = width;
  const shift = v.ShiftLight === 1 ? 'true' : 'false';
  if (bar.dataset.shift !== shift) bar.dataset.shift = shift;
  setText(el('r-coolant'), fmtInt(v.CoolantTemp));

  // Link
  setText(el('c-delivered'), fmtInt(store.link.delivered));
  setText(el('c-late'), fmtInt(store.lateCount));
  setText(el('c-lost'), fmtInt(store.link.lost));
  setText(el('c-dups'), fmtInt(store.link.duplicates));
  setText(el('c-behind'), fmtInt(store.link.behind));
  setText(el('c-ignored'), fmtInt(store.ignored + extraIgnored));

  // Latency
  const stats = store.latencyStats();
  setText(
    el('lat-sum'),
    stats.n === 0
      ? 'No frames yet.'
      : `p50 ${fmtDuration(stats.p50)}, p95 ${fmtDuration(stats.p95)}, max ${fmtDuration(stats.max)}. ${fmtInt(stats.n)} frames.`,
  );
  const max = Math.max(...store.binCounts, 0);
  el('hist')
    .querySelectorAll<HTMLElement>('li')
    .forEach((li, i) => {
      const count = store.binCounts[i] ?? 0;
      setText(li.querySelector<HTMLElement>('.h-count') as HTMLElement, fmtInt(count));
      const fill = li.querySelector<HTMLElement>('.h-bar > span') as HTMLElement;
      const w = `${(barFraction(count, max) * 100).toFixed(1)}%`;
      if (fill.style.width !== w) fill.style.width = w;
    });
}
