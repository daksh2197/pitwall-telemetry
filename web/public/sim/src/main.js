// Wires everything together: modules, frame loop, 2D/3D toggle, CSV.
import { sim, auto } from './state.js';
import { store } from './store.js';
import { startLoop } from './loop.js';
import { deliverText } from './export.js';
import { car } from './physics.js';
import { lap, onLap, loadBest, clearBest } from './laps.js';
import { wiperTick } from './wiper.js';
import { resetAll, onReset, simStep, driftTick } from './sim.js';
import { lapsToCSV } from './csv.js';
import { initInput, updateInput, setAuto, begin, isViewVisible } from './input.js';
import { initView2d, drawView2d, addSkid, resetView2d, setVisible } from './view2d.js';
import { initDash, drawDash, renderLapTable } from './dash.js';
import { initView3d } from './view3d.js';
import { initXR } from './xr.js';

const $ = s => document.querySelector(s);
const M = { v3: null, v3p: null, mode: '2d', cam: 'chase', last: 0, simAcc: 0, statusT: 0, xrDone: false };

function status(msg, ms = 4000) {
  const el = $('#status'); if (!el) return;
  el.textContent = msg; clearTimeout(M.statusT);
  if (msg) M.statusT = setTimeout(() => { el.textContent = ''; }, ms);
}
function inTextField(t) { return !!(t && ((t.closest && t.closest('input,select,textarea')) || t.isContentEditable)); }

/* ---------------- 2D / 3D ---------------- */
function ensureV3() {
  if (!M.v3p) {
    M.v3p = initView3d($('#view')).then(api => { M.v3 = api || null; if (M.v3) { M.v3.setActive(M.mode === '3d'); M.v3.setCam(M.cam); } return M.v3; }).catch(() => null);
  }
  return M.v3p;
}
function maybeXR() {
  if (M.xrDone || !M.v3) return;
  M.xrDone = true;
  initXR({ v3: M.v3, button: $('#vr') }).catch(() => {});
}
function paintToggles() {
  const is3 = M.mode === '3d';
  $('#v2d').setAttribute('aria-pressed', String(!is3)); $('#v3d').setAttribute('aria-pressed', String(is3));
  $('#camseg').hidden = !is3; $('#camhint').hidden = !is3;
  $('#cchase').setAttribute('aria-pressed', String(M.cam === 'chase')); $('#ccock').setAttribute('aria-pressed', String(M.cam === 'cockpit'));
  $('#view').classList.toggle('is3d', is3);
}
function apply(mode) {
  M.mode = mode;
  setVisible(mode === '2d');
  if (M.v3) M.v3.setActive(mode === '3d');
  paintToggles();
}
async function setMode(mode, remember) {
  if (mode === '3d') {
    const v3 = await ensureV3();
    if (!v3) { apply('2d'); status('3D needs WebGL; staying in 2D'); return; }
    apply('3d'); maybeXR();
  } else apply('2d');
  if (remember) store.set('pitwall-sim-view-v1', mode);
}
function setCam(c) { M.cam = c; if (M.v3) M.v3.setCam(c); paintToggles(); }

function defaultMode() {
  const phone = matchMedia('(pointer:coarse)').matches || innerWidth < 700;
  if (phone) return '2d';
  return store.get('pitwall-sim-view-v1') === '2d' ? '2d' : '3d';
}

/* ---------------- Frame ---------------- */
function frame(now) {
  const dt = Math.min(0.05, (now - M.last) / 1000); M.last = now;
  updateInput(dt);
  if (sim.running) {
    M.simAcc += dt; const h = 1 / 240; let n = 0;
    while (M.simAcc >= h && n < 20) { simStep(h); M.simAcc -= h; n++; }
    if (driftTick(dt)) addSkid(car.x, car.y);
  }
  wiperTick(dt, car.vx);
  drawView2d();
  if (M.v3 && (M.mode === '3d' || M.v3.isPresenting())) M.v3.render(dt);
  drawDash(dt);
}

function init() {
  loadBest();
  resetAll();
  initInput();
  initView2d($('#track'), $('#mini'));
  initDash();
  onLap(() => renderLapTable());
  onReset(() => resetView2d());

  const view = $('#view');
  $('#go').addEventListener('click', e => { e.stopPropagation(); begin(); view.focus(); });
  view.addEventListener('pointerdown', () => { begin(); view.focus(); });
  $('#vbar').addEventListener('pointerdown', e => e.stopPropagation());
  $('#reset').addEventListener('click', () => resetAll());
  $('#auto').addEventListener('click', () => setAuto(!auto.on));
  $('#clearbest').addEventListener('click', () => { clearBest(); });
  $('#csvbtn').addEventListener('click', async () => {
    if (!lap.list.length) { status('No laps to export yet.'); return; }
    const r = await deliverText(lapsToCSV(lap.list.slice().reverse()), 'pitwall-sim-laps.csv', 'text/csv');
    status(r === 'downloaded' ? 'Laps downloaded as CSV' : 'Could not export the laps');
  });
  $('#v2d').addEventListener('click', () => setMode('2d', true));
  $('#v3d').addEventListener('click', () => setMode('3d', true));
  $('#cchase').addEventListener('click', () => setCam('chase'));
  $('#ccock').addEventListener('click', () => setCam('cockpit'));
  addEventListener('keydown', e => {
    if (inTextField(e.target) || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    if (e.code === 'KeyR' && isViewVisible()) resetAll();
    if (e.code === 'KeyC' && isViewVisible() && M.mode === '3d') setCam(M.cam === 'chase' ? 'cockpit' : 'chase');
  });
  document.addEventListener('visibilitychange', () => { M.last = performance.now(); });

  paintToggles();
  M.last = performance.now();
  startLoop(frame);

  const want = defaultMode();
  if (want === '3d') setMode('3d', false);
  else if (navigator.xr && navigator.xr.isSessionSupported) {
    // Load 3D in the background only on a headset browser, so the VR button can appear without opening 3D.
    navigator.xr.isSessionSupported('immersive-vr').then(ok => { if (ok) ensureV3().then(maybeXR); }).catch(() => {});
  }
}
if (document.readyState === "loading") addEventListener("DOMContentLoaded", init); else init();
