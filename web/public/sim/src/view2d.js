// Top-down chase view and minimap.
import { clamp, cfg } from './state.js';
import { TR, NTR, W2, BOUNDS } from './track.js';
import { car } from './physics.js';
import { coverage } from './wiper.js';

const V = { tc: null, tctx: null, mc: null, mctx: null, view: null, dpr: 1, zoom: 6, camPsi: 0, visible: true, trackPath: null, kerbPath: null, miniBase: null, COL: null, MS: 1, ro: null, wasBlur: false };
const skids = [];
const mx = x => 20 + (x - BOUNDS.x0) * V.MS, my = y => 20 + (y - BOUNDS.y0) * V.MS;
const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

function resize() {
  const r = V.view.getBoundingClientRect();
  V.dpr = Math.min(2, devicePixelRatio || 1);
  V.tc.width = Math.max(1, Math.round(r.width * V.dpr)); V.tc.height = Math.max(1, Math.round(r.height * V.dpr));
  V.zoom = clamp(Math.min(r.width, r.height) / 70, 3.5, 9);
}

export function initView2d(canvasEl, miniEl) {
  V.tc = canvasEl; V.tctx = canvasEl.getContext('2d'); V.mc = miniEl; V.mctx = miniEl.getContext('2d'); V.view = canvasEl.parentElement;
  V.COL = { asphalt: css('--asphalt'), edge: css('--asphalt-edge'), grass: css('--grass'), kr: css('--kerb-r'), kw: css('--kerb-w'), accent: css('--accent'), text: css('--text'), muted: css('--muted') };
  V.trackPath = new Path2D(); TR.forEach((p, i) => i ? V.trackPath.lineTo(p.x, p.y) : V.trackPath.moveTo(p.x, p.y)); V.trackPath.closePath();
  V.kerbPath = new Path2D();
  for (const side of [1, -1]) {
    let open = false;
    for (let i = 0; i <= NTR; i++) {
      const p = TR[i % NTR], ox = p.x - p.ty * side * (W2 - 0.6), oy = p.y + p.tx * side * (W2 - 0.6);
      if (p.kerb) { if (!open) { V.kerbPath.moveTo(ox, oy); open = true; } else V.kerbPath.lineTo(ox, oy); } else open = false;
    }
  }
  V.MS = Math.min(260 / (BOUNDS.x1 - BOUNDS.x0), 260 / (BOUNDS.y1 - BOUNDS.y0));
  V.miniBase = document.createElement('canvas'); V.miniBase.width = 300; V.miniBase.height = 300;
  const c = V.miniBase.getContext('2d'), COL = V.COL;
  c.strokeStyle = COL.muted; c.lineWidth = 5; c.lineJoin = 'round'; c.beginPath(); TR.forEach((p, i) => i ? c.lineTo(mx(p.x), my(p.y)) : c.moveTo(mx(p.x), my(p.y))); c.closePath(); c.stroke();
  c.fillStyle = COL.text; c.fillRect(mx(TR[0].x) - 2, my(TR[0].y) - 9, 4, 18);
  if (typeof ResizeObserver !== 'undefined') { V.ro = new ResizeObserver(resize); V.ro.observe(V.view); }
  resize();
  V.camPsi = car.psi || 0;
}

export function setVisible(on) {
  V.visible = !!on;
  if (V.tc) { V.tc.style.display = on ? '' : 'none'; if (on) { V.camPsi = car.psi; resize(); } }
}
export function addSkid(x, y) { skids.push({ x, y }); if (skids.length > 900) skids.splice(0, 100); }
export function resetView2d() { skids.length = 0; V.camPsi = car.psi; }

export function drawView2d() {
  if (!V.tc) return;
  const COL = V.COL, tctx = V.tctx, mctx = V.mctx;
  if (V.visible) {
    const W = V.tc.width, H = V.tc.height, z = V.zoom * V.dpr;
    tctx.setTransform(1, 0, 0, 1, 0, 0); tctx.fillStyle = COL.grass; tctx.fillRect(0, 0, W, H);
    // chase cam: the car always points up the screen, so left on the keyboard is left on the screen
    let dpsi = car.psi - V.camPsi; while (dpsi > Math.PI) dpsi -= 2 * Math.PI; while (dpsi < -Math.PI) dpsi += 2 * Math.PI;
    V.camPsi += dpsi * 0.18;
    const zs = z * (1 - clamp(Math.abs(car.vx) / 60, 0, 1) * 0.3);
    tctx.setTransform(1, 0, 0, 1, 0, 0); tctx.translate(W / 2, H * 0.68); tctx.rotate(-Math.PI / 2 - V.camPsi); tctx.scale(zs, zs); tctx.translate(-car.x, -car.y);
    tctx.lineJoin = 'round';
    tctx.strokeStyle = COL.edge; tctx.lineWidth = 2 * W2 + 1.4; tctx.stroke(V.trackPath);
    tctx.strokeStyle = COL.asphalt; tctx.lineWidth = 2 * W2; tctx.stroke(V.trackPath);
    tctx.strokeStyle = 'rgba(237,232,221,0.16)'; tctx.lineWidth = 0.25; tctx.setLineDash([3, 5]); tctx.stroke(V.trackPath); tctx.setLineDash([]);
    tctx.lineWidth = 1.2; tctx.setLineDash([3, 3]); tctx.strokeStyle = COL.kr; tctx.lineDashOffset = 0; tctx.stroke(V.kerbPath); tctx.strokeStyle = COL.kw; tctx.lineDashOffset = 3; tctx.stroke(V.kerbPath); tctx.setLineDash([]);
    const s0 = TR[0]; tctx.strokeStyle = COL.text; tctx.lineWidth = 1.4; tctx.beginPath(); tctx.moveTo(s0.x - s0.ty * W2, s0.y + s0.tx * W2); tctx.lineTo(s0.x + s0.ty * W2, s0.y - s0.tx * W2); tctx.stroke();
    tctx.fillStyle = 'rgba(10,10,12,0.55)'; for (const k of skids) tctx.fillRect(k.x - 0.35, k.y - 0.35, 0.7, 0.7);
    tctx.save(); tctx.translate(car.x, car.y); tctx.rotate(car.psi);
    tctx.fillStyle = '#0b0b0c'; for (const [wx, wy] of [[1.3, -0.95], [1.3, 0.95], [-1.3, -0.95], [-1.3, 0.95]]) tctx.fillRect(wx - 0.38, wy - 0.22, 0.76, 0.44);
    tctx.fillStyle = COL.accent; tctx.fillRect(-2.3, -0.9, 4.6, 1.8);
    tctx.fillStyle = '#111214'; tctx.fillRect(0.2, -0.7, 1.0, 1.4);
    if (cfg.ground) { tctx.fillStyle = COL.text; tctx.fillRect(-2.5, -0.95, 0.25, 1.9); }
    tctx.restore();
    if (cfg.rain) { tctx.setTransform(1, 0, 0, 1, 0, 0); tctx.fillStyle = 'rgba(70,110,160,0.10)'; tctx.fillRect(0, 0, W, H); }
    const cov = cfg.rain ? coverage() : 0;
    V.tc.style.filter = cov > 0.08 ? `blur(${(cov * 4).toFixed(1)}px) brightness(${(1 - cov * 0.35).toFixed(2)})` : 'none';
  }
  // minimap
  mctx.clearRect(0, 0, 300, 300); mctx.drawImage(V.miniBase, 0, 0);
  mctx.fillStyle = COL.accent; mctx.beginPath(); mctx.arc(mx(car.x), my(car.y), 7, 0, Math.PI * 2); mctx.fill();
}
