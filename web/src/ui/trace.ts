/**
 * The trace: speed on top, throttle and brake below, car time along the bottom.
 *
 * This is the one bold thing on the page. Samples are placed by when the CAR made them, not
 * when they arrived, so a link outage is a hole at the right-hand edge and a backfill is that
 * hole filling in from the left, in purple.
 */

import { fmtClock } from '../core/format';
import type { LinkState } from '../core/status';
import type { Series, Store } from '../core/store';
import { lateRanges, niceMax, strokes, ticks, viewFor } from './geometry';

export const WINDOW_MS = 15_000;

export interface Palette {
  ground: string;
  panel: string;
  line: string;
  line2: string;
  chalk: string;
  muted: string;
  signal: string;
  go: string;
  purple: string;
}

export function readPalette(el: Element): Palette {
  const css = getComputedStyle(el);
  const get = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return {
    ground: get('--ground', '#111214'),
    panel: get('--panel', '#1a1c20'),
    line: get('--line', 'rgba(237,232,221,0.12)'),
    line2: get('--line-2', 'rgba(237,232,221,0.22)'),
    chalk: get('--chalk', '#ede8dd'),
    muted: get('--muted', '#a9a498'),
    signal: get('--signal', '#ff5a1f'),
    go: get('--go', '#3ddc84'),
    purple: get('--purple', '#b794ff'),
  };
}

interface Layout {
  left: number;
  right: number;
  top: number;
  speedTop: number;
  speedH: number;
  ctrlTop: number;
  ctrlH: number;
  stripTop: number;
  stripH: number;
  axisY: number;
}

export function layout(w: number, h: number): Layout {
  const left = w < 480 ? 36 : 46;
  const right = 8;
  const top = 6;
  const axis = 20;
  const stripH = 8;
  const gap = 22;
  const inner = Math.max(60, h - top - axis - stripH - gap * 2);
  const speedH = inner * 0.6;
  const ctrlH = inner - speedH;
  const speedTop = top;
  const ctrlTop = speedTop + speedH + gap;
  const stripTop = ctrlTop + ctrlH + gap;
  return { left, right, top, speedTop, speedH, ctrlTop, ctrlH, stripTop, stripH, axisY: stripTop + stripH + 4 };
}

export interface TraceState {
  store: Store;
  state: LinkState;
  palette: Palette;
}

export function drawTrace(canvas: HTMLCanvasElement, s: TraceState): void {
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth;
  const cssH = canvas.clientHeight;
  if (cssW < 10 || cssH < 10) return;
  const pxW = Math.round(cssW * dpr);
  const pxH = Math.round(cssH * dpr);
  if (canvas.width !== pxW || canvas.height !== pxH) {
    canvas.width = pxW;
    canvas.height = pxH;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const { store, palette: p } = s;
  const L = layout(cssW, cssH);
  const view = viewFor(store.rxMs, WINDOW_MS);
  const plotW = cssW - L.left - L.right;
  const x = (t: number) => L.left + ((t - view.t0) / (view.t1 - view.t0)) * plotW;

  const speed = store.series.get('Speed');
  const throttle = store.series.get('Throttle');
  const brake = store.series.get('BrakePressure');
  const speedMax = niceMax(Math.max(0, ...(speed?.y.slice(-2000) ?? [0])), 50, 300);

  ctx.font = '11px "Geist Mono", ui-monospace, monospace';
  ctx.textBaseline = 'middle';

  // Grid and labels
  const yS = (v: number) => L.speedTop + L.speedH - (Math.min(Math.max(v, 0), speedMax) / speedMax) * L.speedH;
  const yC = (v: number) => L.ctrlTop + L.ctrlH - (Math.min(Math.max(v, 0), 100) / 100) * L.ctrlH;
  ctx.lineWidth = 1;
  ctx.strokeStyle = p.line;
  ctx.fillStyle = p.muted;
  ctx.textAlign = 'right';
  for (let v = 0; v <= speedMax; v += 100) {
    line(ctx, L.left, yS(v), L.left + plotW, yS(v));
    ctx.fillText(String(v), L.left - 6, yS(v));
  }
  for (const v of [0, 50, 100]) {
    line(ctx, L.left, yC(v), L.left + plotW, yC(v));
    ctx.fillText(String(v), L.left - 6, yC(v));
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (const t of ticks(view, 5000)) {
    ctx.strokeStyle = p.line;
    line(ctx, x(t), L.speedTop, x(t), L.ctrlTop + L.ctrlH);
    ctx.fillText(fmtClock(t), x(t), L.axisY);
  }
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  paneLabel(ctx, 'SPEED km/h', L.left + 6, L.speedTop + 4, p);
  paneLabel(ctx, 'THROTTLE % / BRAKE %', L.left + 6, L.ctrlTop + 4, p);

  // The part of the window the pit wall has nothing for yet
  const newest = store.newest;
  const edge = newest ? Math.min(Math.max(newest.ts, view.t0), view.t1) : view.t0;
  if (s.state !== 'finished' && x(view.t1) - x(edge) > 6) {
    hatch(ctx, x(edge), L.speedTop, x(view.t1) - x(edge), L.ctrlTop + L.ctrlH - L.speedTop, p.line2);
    const label = s.state === 'catching-up' ? 'BACKFILLING' : s.state === 'no-data' ? 'NO DATA' : '';
    if (label && x(view.t1) - x(edge) > 80) {
      ctx.fillStyle = p.chalk;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, (x(edge) + x(view.t1)) / 2, L.speedTop + L.speedH / 2);
    }
  }

  // Lines
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  drawSeries(ctx, throttle, view, x, yC, p.go, p.go, 1.75);
  drawSeries(ctx, brake, view, x, yC, p.signal, p.signal, 1.75);
  drawSeries(ctx, speed, view, x, yS, p.chalk, p.purple, 2.75);

  // Backfill strip
  ctx.fillStyle = p.panel;
  ctx.fillRect(L.left, L.stripTop, plotW, L.stripH);
  ctx.fillStyle = p.purple;
  for (const [a, b] of lateRanges(speed, view)) {
    const xa = Math.max(x(a), L.left);
    const xb = Math.min(x(b), L.left + plotW);
    if (xb > xa) ctx.fillRect(xa, L.stripTop, Math.max(2, xb - xa), L.stripH);
  }
}

/** A small label with the card's colour behind it, so a gridline or a trace never runs through the words. */
function paneLabel(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, p: Palette): void {
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  const w = ctx.measureText(text).width;
  ctx.fillStyle = p.panel;
  ctx.fillRect(x - 3, y - 2, w + 6, 15);
  ctx.fillStyle = p.muted;
  ctx.fillText(text, x, y);
}

function line(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number): void {
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
}

function hatch(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  for (let k = -h; k < w; k += 10) line(ctx, x + k, y + h, x + k + h, y);
  ctx.restore();
}

function drawSeries(
  ctx: CanvasRenderingContext2D,
  series: Series | undefined,
  view: { t0: number; t1: number },
  x: (t: number) => number,
  y: (v: number) => number,
  normal: string,
  late: string,
  width: number,
): void {
  ctx.lineWidth = width;
  for (const piece of strokes(series, view)) {
    ctx.strokeStyle = piece.late ? late : normal;
    ctx.beginPath();
    piece.t.forEach((t, i) => {
      const px = x(t);
      const py = y(piece.y[i] as number);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    if (piece.t.length === 1) {
      const px = x(piece.t[0] as number);
      ctx.moveTo(px, y(piece.y[0] as number));
      ctx.lineTo(px + 0.01, y(piece.y[0] as number));
    }
    ctx.stroke();
  }
}
