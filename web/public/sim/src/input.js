// Input: keyboard, touch, Gamepad API through the active profile, test-driver handback, and the controller panel with the pedal-mapping wizard.
import { clamp, inp, auto, sim } from './state.js';
import { store } from './store.js';
import { testDriver } from './test-driver.js';
import { PROFILE_FORMAT, STANDARD_PROFILE, validateProfile, readControls } from './profiles.js';
import { deliverText, readFileText } from './export.js';

const $ = s => document.querySelector(s);
const PROFILE_KEY = 'pitwall-sim-profile-v1';
const DRIVE_KEYS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space'];
const clone = o => JSON.parse(JSON.stringify(o));

const keys = new Set();
const touch = { gas: false, brk: false, steer: 0 };
const S = { kbSteer: 0, viewVisible: true, gpBlocked: false, xr: null, profile: null, wiz: null, tick: 0, ready: false };

function loadProfile() {
  const saved = store.get(PROFILE_KEY);
  if (saved && validateProfile(saved).ok) return clone(saved);
  return clone(STANDARD_PROFILE);
}
function saveProfile() { store.set(PROFILE_KEY, S.profile); }
function setProfile(p) { S.profile = p; saveProfile(); syncControls(); }

export function getProfile() { if (!S.profile) S.profile = loadProfile(); return S.profile; }
export function setXRReader(fn) { S.xr = fn; }
export function isViewVisible() { return S.viewVisible; }

export function begin() {
  if (sim.running) return;
  sim.running = true;
  const st = $('#start'); if (st) st.hidden = true;
}

export function setAuto(on) {
  auto.on = on;
  const b = $('#auto');
  if (b) { b.setAttribute('aria-pressed', on); b.textContent = on ? 'Test driver: on' : 'Test driver'; }
  if (on) begin();
}

function inTextField(t) { return !!(t && ((t.closest && t.closest('input,select,textarea')) || t.isContentEditable)); }

function getPad() {
  let pads = [];
  try { pads = navigator.getGamepads ? Array.from(navigator.getGamepads()) : []; } catch (e) { S.gpBlocked = true; return null; }
  return pads.find(p => p && p.connected) || null;
}

function readGamepad() {
  const gp = getPad();
  if (!gp) return null;
  return { gp, ...readControls(getProfile(), gp) };
}

export function updateInput(dt) {
  const g = readGamepad();
  const kThr = (keys.has('ArrowUp') || keys.has('KeyW')) ? 1 : 0;
  const kBrk = (keys.has('ArrowDown') || keys.has('KeyS') || keys.has('Space')) ? 1 : 0;
  const kDir = ((keys.has('ArrowRight') || keys.has('KeyD')) ? 1 : 0) - ((keys.has('ArrowLeft') || keys.has('KeyA')) ? 1 : 0);
  S.kbSteer += clamp(kDir - S.kbSteer, -dt * 3.2, dt * 3.2);
  if (!kDir) S.kbSteer *= Math.max(0, 1 - dt * 5);
  const gpActive = g && (g.thr > 0.02 || g.brk > 0.02 || Math.abs(g.steer) > 0.03);
  const xq = auto.on && !g && S.xr ? S.xr() : null;
  const xrActive = !!(xq && (xq.thr > 0.02 || xq.brk > 0.02 || Math.abs(xq.steer) > 0.03));
  if (auto.on && (kThr || kBrk || kDir || touch.gas || touch.brk || touch.steer || gpActive || xrActive)) setAuto(false);
  if (auto.on) { testDriver(); inp.src = 'Test driver'; return; }
  if (S.wiz) { inp.thr = 0; inp.brk = 0; inp.steer = 0; inp.src = 'Wheel'; return; } // mapping: don't drive
  if (gpActive) { inp.thr = g.thr; inp.brk = g.brk; inp.steer = g.steer; inp.src = 'Wheel'; return; }
  const x = !g && S.xr ? S.xr() : null;
  if (x) { inp.thr = clamp(x.thr || 0, 0, 1); inp.brk = clamp(x.brk || 0, 0, 1); inp.steer = clamp(x.steer || 0, -1, 1); inp.src = 'VR controllers'; return; }
  if (touch.gas || touch.brk || touch.steer) { inp.thr = touch.gas ? 1 : 0; inp.brk = touch.brk ? 1 : 0; inp.steer = touch.steer; inp.src = 'Touch'; return; }
  inp.thr = kThr; inp.brk = kBrk; inp.steer = S.kbSteer; inp.src = g ? 'Wheel' : 'Keyboard';
}

/* ---------------- Controller panel + profile tools ---------------- */
function describePedal(s, label) {
  if (!s) return label + ': none';
  return s.type === 'button' ? `${label}: button ${s.index}` : `${label}: axis ${s.axis} (${s.rest.toFixed(2)} to ${s.full.toFixed(2)})`;
}
export function describeProfile(p) {
  const pedals = p.combined
    ? `gas and brake share axis ${p.combined.axis} (rest ${p.combined.rest.toFixed(2)}, gas ${p.combined.gas_end.toFixed(2)}, brake ${p.combined.brake_end.toFixed(2)})`
    : `${describePedal(p.throttle, 'gas')}, ${describePedal(p.brake, 'brake')}`;
  return `${p.name} · steer axis ${p.steer.axis}${p.steer.invert ? ' (inverted)' : ''} · ${pedals}`;
}
function syncControls() {
  const p = getProfile();
  const inv = $('#invert'); if (inv) inv.textContent = p.steer.invert ? 'Steering inverted' : 'Invert steering';
  const sens = $('#sens'); if (sens) sens.value = Math.round(p.steer.sens * 100);
  const sum = $('#profsum'); if (sum) sum.textContent = describeProfile(p);
}
function say(html, asText) {
  const box = $('#mapstep'); if (!box) return;
  box.hidden = false; if (asText) box.textContent = html; else box.innerHTML = html;
}
function hideStep() { const box = $('#mapstep'); if (box) box.hidden = true; }

function axesPanel() {
  const st = $('#gp-status'), ax = $('#axes'); if (!st || !ax) return;
  const g = getPad();
  if (S.gpBlocked) { st.textContent = 'This browser is blocking controller access for this page. Keyboard and touch still work.'; ax.innerHTML = ''; return; }
  if (!g) { st.textContent = "No wheel or gamepad seen yet. Plug it in, then press a pedal or button so the browser shares it. If it still doesn't show up here, try Chrome or Edge."; ax.innerHTML = ''; return; }
  st.textContent = `Connected: ${g.id}`;
  const p = getProfile();
  const roles = i => {
    let r = '';
    if (i === p.steer.axis) r += ' · steer';
    if (p.combined && p.combined.axis === i) r += ' · gas+brake';
    else {
      if (p.throttle.type === 'axis' && p.throttle.axis === i) r += ' · gas';
      if (p.brake.type === 'axis' && p.brake.axis === i) r += ' · brake';
    }
    return r;
  };
  ax.innerHTML = g.axes.slice(0, 8).map((v, i) => `<div><span>Axis ${i}${roles(i)}</span><div class="bar"><span style="width:${((v + 1) / 2 * 100).toFixed(0)}%"></span></div><span>${v.toFixed(2)}</span></div>`).join('');
}

/* ---------------- Pedal-mapping wizard ---------------- */
function snapshot(g) { return { axes: Array.from(g.axes), btn: Array.from(g.buttons).map(b => b.value || (b.pressed ? 1 : 0)) }; }
// Biggest mover versus the rest snapshot, ignoring skip axes. Axes count when they moved 0.3 or more; otherwise buttons (0.5 or more).
function biggestMover(rest, now, skipAxes) {
  let ai = -1, ad = 0;
  now.axes.forEach((v, i) => { if (skipAxes.includes(i)) return; const d = Math.abs(v - rest.axes[i]); if (d > ad) { ad = d; ai = i; } });
  let bi = -1, bd = 0;
  now.btn.forEach((v, i) => { const d = v - (rest.btn[i] || 0); if (d > bd) { bd = d; bi = i; } });
  if (ai >= 0 && ad >= 0.3) return { type: 'axis', axis: ai, rest: rest.axes[ai], full: now.axes[ai], d: ad };
  if (bi >= 0 && bd >= 0.5) return { type: 'button', index: bi, d: bd };
  return null;
}
const NEXT = '<button class="btn" type="button" data-act="next">Next</button> <button class="btn" type="button" data-act="cancel">Cancel</button>';
function wizShow() {
  const w = S.wiz; if (!w) return;
  const t = [
    `Step 1 of 4: centre the wheel, take your hands off it and let both pedals up. Then click <b>Next</b>. ${NEXT}`,
    `Step 2 of 4: turn the wheel fully to the <b>right</b> and hold it, then click <b>Next</b>. ${NEXT}`,
    `Step 3 of 4: press the <b>throttle</b> all the way down and hold it, then click <b>Next</b>. ${NEXT}`,
    `Step 4 of 4: let go of the throttle, press the <b>brake</b> all the way down and hold it, then click <b>Next</b>. ${NEXT}`
  ];
  say(t[w.stage]);
}
function startWizard() {
  const g = getPad();
  if (!g) { say('No controller found. Plug in the wheel, press a pedal, then try again.', true); return; }
  S.wiz = { stage: 0, rest: null, steerAxis: 0, invert: false, thr: null, brk: null, combined: null };
  wizShow();
}
function wizFinish() {
  const w = S.wiz, g = getPad(), cur = getProfile();
  const p = {
    format: PROFILE_FORMAT,
    name: ('Mapped ' + (g ? g.id : 'device')).slice(0, 80),
    device: g ? g.id : null,
    steer: { axis: w.steerAxis, invert: w.invert, deadzone: 0.02, sens: cur.steer.sens },
    throttle: w.thr, brake: w.brk, combined: w.combined
  };
  const v = validateProfile(p);
  S.wiz = null;
  if (!v.ok) { say('Could not save that mapping: ' + v.errors.join('; '), true); return; }
  setProfile(p);
  say('Saved. ' + describeProfile(p), true);
}
function wizNext() {
  const w = S.wiz, g = getPad();
  if (!w || !g) { if (w) say('The controller went away. Reconnect it and click Map pedals again.', true); S.wiz = null; return; }
  const now = snapshot(g);
  if (w.stage === 0) { w.rest = now; w.stage = 1; return wizShow(); }
  if (w.stage === 1) {
    let bi = -1, bd = 0;
    now.axes.forEach((v, i) => { const d = Math.abs(v - w.rest.axes[i]); if (d > bd) { bd = d; bi = i; } });
    if (bi < 0 || bd < 0.3) { say(`That didn't move an axis. Turn the wheel fully right and click <b>Next</b> again. ${NEXT}`); return; }
    w.steerAxis = bi; w.invert = now.axes[bi] < w.rest.axes[bi]; w.stage = 2; return wizShow();
  }
  if (w.stage === 2) {
    const m = biggestMover(w.rest, now, [w.steerAxis]);
    if (!m) { say(`That pedal didn't move anything. Press it fully and click <b>Next</b> again. ${NEXT}`); return; }
    w.thr = m.type === 'axis' ? { type: 'axis', axis: m.axis, rest: m.rest, full: m.full } : { type: 'button', index: m.index };
    w.stage = 3; return wizShow();
  }
  if (w.stage === 3) {
    const m = biggestMover(w.rest, now, [w.steerAxis]);
    if (!m) { say(`That pedal didn't move anything. Press the brake fully and click <b>Next</b> again. ${NEXT}`); return; }
    if (m.type === 'axis' && w.thr.type === 'axis' && m.axis === w.thr.axis) {
      const thrDir = Math.sign(w.thr.full - w.thr.rest), brkDir = Math.sign(m.full - m.rest);
      if (thrDir === brkDir) { say(`Throttle and brake moved the same axis the same way. Let go of the throttle, press only the brake and click <b>Next</b> again. ${NEXT}`); return; }
      w.combined = { axis: m.axis, rest: m.rest, gas_end: w.thr.full, brake_end: m.full };
      w.brk = { type: 'axis', axis: m.axis, rest: m.rest, full: m.full };
    } else if (m.type === 'axis') w.brk = { type: 'axis', axis: m.axis, rest: m.rest, full: m.full };
    else w.brk = { type: 'button', index: m.index };
    return wizFinish();
  }
}
function pollTick() { if (++S.tick % 3 === 0) axesPanel(); }
function stepClick(e) {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const a = b.dataset.act;
  if (a === 'cancel') { S.wiz = null; hideStep(); }
  else if (a === 'next') wizNext();
}

async function importProfile(file) {
  try {
    const obj = JSON.parse(await readFileText(file));
    const v = validateProfile(obj);
    if (!v.ok) { say('That file is not a valid profile: ' + v.errors.join('; '), true); return; }
    setProfile(clone(obj)); say('Imported. ' + describeProfile(obj), true);
  } catch (err) { say('Could not read that file as a profile.', true); }
}

/* ---------------- Wiring ---------------- */
export function initInput() {
  if (S.ready) return; S.ready = true;
  getProfile();
  const view = $('#view');
  if (view && typeof IntersectionObserver !== 'undefined') new IntersectionObserver(es => { S.viewVisible = es[0].isIntersecting; }, { threshold: 0.35 }).observe(view);
  addEventListener('keydown', e => {
    if (inTextField(e.target)) return;
    if (e.code === 'Space' && e.target.closest && e.target.closest('button,a')) return;
    const drive = DRIVE_KEYS.includes(e.code);
    if (drive && !S.viewVisible) return; // arrows and space scroll the page while the car is out of sight
    if (drive) { e.preventDefault(); begin(); }
    keys.add(e.code);
  });
  addEventListener('keyup', e => keys.delete(e.code));
  addEventListener('blur', () => keys.clear());
  const hold = (id, k) => {
    const b = $(id); if (!b) return;
    const on = e => { e.preventDefault(); touch[k] = true; b.classList.add('held'); begin(); };
    const off = () => { touch[k] = false; b.classList.remove('held'); };
    b.addEventListener('pointerdown', on); b.addEventListener('pointerup', off); b.addEventListener('pointerleave', off); b.addEventListener('pointercancel', off);
  };
  hold('#t-gas', 'gas'); hold('#t-brk', 'brk');
  const ts = $('#t-steer');
  if (ts) {
    ts.addEventListener('input', e => { touch.steer = e.target.value / 100; begin(); });
    ts.addEventListener('change', e => { e.target.value = 0; touch.steer = 0; });
  }
  addEventListener('gamepadconnected', () => begin());
  const on = (id, ev, fn) => { const el = $(id); if (el) el.addEventListener(ev, fn); };
  on('#map', 'click', startWizard);
  on('#mapstep', 'click', stepClick);
  on('#invert', 'click', () => { S.profile.steer.invert = !S.profile.steer.invert; saveProfile(); syncControls(); });
  on('#sens', 'input', e => { S.profile.steer.sens = e.target.value / 100; saveProfile(); syncControls(); });
  on('#profexport', 'click', async () => {
    const r = await deliverText(JSON.stringify(getProfile(), null, 2) + '\n', 'pitwall-sim-profile.json', 'application/json');
    say(r === 'downloaded' ? 'Profile downloaded.' : 'Could not export the profile.', true);
  });
  on('#profimport', 'click', () => { const f = $('#proffile'); if (f) f.click(); });
  on('#proffile', 'change', e => { const f = e.target.files && e.target.files[0]; if (f) importProfile(f); e.target.value = ''; });
  on('#profreset', 'click', () => { setProfile(clone(STANDARD_PROFILE)); say('Back to the standard mapping. ' + describeProfile(S.profile), true); });
  syncControls();
  setInterval(pollTick, 100);
}
