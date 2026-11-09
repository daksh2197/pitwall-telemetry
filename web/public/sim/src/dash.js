// Dash cluster, grip circle, windshield, patent switch panel and lap table.
import { G, clamp, cfg, inp, sim } from './state.js';
import { NB, LEN, TR } from './track.js';
import { car, engine, KERB } from './physics.js';
import { tire, tireReset } from './tire-monitor.js';
import { lap } from './laps.js';
import { drops, wiper, coverage } from './wiper.js';

const $ = s => document.querySelector(s);
const D = { gctx: null, wsc: null, wsctx: null, dashAcc: 0, COL: null, el: null, lights: null, ready: false };
const ggTrail = [];
const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

export const MODS = [
  { id: 'rotary', yr: 1958, num: 'US 2,988,065', pat: 'US2988065A', title: 'Rotary engine', what: 'Swap the piston V6 for a rotary: about 45 kg lighter and revving to 9,000, with a softer low end.', ctl: 'switch' },
  { id: 'wiper', yr: 1964, num: 'US 3,351,836', pat: 'US3351836A', title: 'Intermittent wiper', what: 'Turn the rain on. Grip drops, and the windshield fills up unless the wiper clears it. Set how long it pauses between sweeps.', ctl: 'rain' },
  { id: 'ground', yr: 1979, num: 'CA 1,149,841', pat: 'CA1149841A', title: 'Ground-effect undertray', what: 'An undertray that seals the floor. Downforce grows with the square of speed, so the fast corners get grippier.', ctl: 'switch' },
  { id: 'flat', yr: 1987, num: 'US 4,876,528', pat: 'US4876528A', title: 'Low-tire warning from wheel speeds', what: 'Let air out of the rear-left. The dash compares the two diagonal pairs of wheel speeds and flags the soft tire on the next straight, with no sensor in the tire.', ctl: 'flat' },
  { id: 'delta', yr: 1988, num: 'US 5,173,856', pat: 'US5173856A', title: 'Lap logger with a reference lap', what: 'Your best lap is stored bin by bin around the track. The dash shows how far ahead or behind you are right now.', ctl: 'always' },
  { id: 'slip', yr: 2001, num: 'US 6,681,180', pat: 'US6681180B2', title: 'Sideslip angle from GPS', what: 'The angle between where the car points and where it travels, from the velocity vector alone. Turn the driver aids off to drift. Past 5° the drift score counts.', ctl: 'aids' },
  { id: 'inerter', yr: 2001, num: 'US 7,316,303', pat: 'US7316303B2', title: 'Inerter, the "J-damper"', what: 'Grip over the kerbs comes from a quarter-car model: a stiff race spring, the inerter in series with the damper. It is a small gain, which is what the physics says.', ctl: 'switch' }
];

export function modHTML(m) {
  let ctl = '';
  if (m.ctl === 'switch') ctl = `<button type="button" class="switch" data-sw="${m.id}" aria-pressed="false"><span class="track"></span><span>Off</span></button>`;
  if (m.ctl === 'always') ctl = '<span class="always">Always on</span>';
  if (m.ctl === 'aids') ctl = '<span class="always">Always on</span><button type="button" class="switch" data-sw="assist" aria-pressed="true"><span class="track"></span><span>Aids on</span></button>';
  if (m.ctl === 'flat') ctl = `<button type="button" class="switch" data-sw="flat" aria-pressed="false"><span class="track"></span><span>Tire full</span></button>`;
  if (m.ctl === 'rain') ctl = `<button type="button" class="switch" data-sw="rain" aria-pressed="false"><span class="track"></span><span>Dry</span></button>
    <label for="wmode">Wiper <select id="wmode"><option value="off">Off</option><option value="int" selected>Intermittent</option><option value="steady">Steady</option></select></label>
    <label for="dwell">Pause <input type="range" id="dwell" min="1" max="10" step="0.5" value="4"> <span id="dwellv">4.0 s</span></label>`;
  const extra = m.id === 'wiper' ? '<canvas class="windshield" id="ws" width="560" height="240" aria-label="Windshield"></canvas>' : '';
  return `<article class="mod" id="mod-${m.id}"><div class="yr"><b>${m.yr}</b><a href="https://patents.google.com/patent/${m.pat}/en" target="_blank" rel="noopener">${m.num} ↗</a></div><h3>${m.title}</h3><p>${m.what}</p>${extra}<div class="stat" id="st-${m.id}">–</div><div class="ctl">${ctl}</div></article>`;
}

const LABEL = { rotary: ['Off', 'On'], ground: ['Off', 'On'], inerter: ['Off', 'On'], flat: ['Tire full', 'Air let out'], rain: ['Dry', 'Raining'], assist: ['Aids off', 'Aids on'] };

const fmtT = t => { if (t === null || t === undefined || !Number.isFinite(t)) return '–'; const m = Math.floor(t / 60), s = t - m * 60; return `${m}:${s.toFixed(2).padStart(5, '0')}`; };

export function drawGG() {
  const c = D.gctx, S = 300, R = 120, cx = S / 2, cy = S / 2, gmax = 1.6, COL = D.COL;
  c.clearRect(0, 0, S, S);
  c.strokeStyle = COL.line; c.lineWidth = 2; for (const f of [0.5, 1, 1.5]) { c.beginPath(); c.arc(cx, cy, R * f / gmax, 0, Math.PI * 2); c.stroke(); }
  c.beginPath(); c.moveTo(cx - R, cy); c.lineTo(cx + R, cy); c.moveTo(cx, cy - R); c.lineTo(cx, cy + R); c.stroke();
  const gx = car.ay / G, gy = -car.ax / G; ggTrail.push([gx, gy]); if (ggTrail.length > 60) ggTrail.shift();
  ggTrail.forEach(([x, y], i) => { c.fillStyle = `rgba(237,232,221,${(i / ggTrail.length * 0.35).toFixed(3)})`; c.beginPath(); c.arc(cx + x / gmax * R, cy + y / gmax * R, 4, 0, Math.PI * 2); c.fill(); });
  c.fillStyle = COL.accent; c.beginPath(); c.arc(cx + clamp(gx, -gmax, gmax) / gmax * R, cy + clamp(gy, -gmax, gmax) / gmax * R, 9, 0, Math.PI * 2); c.fill();
  c.fillStyle = COL.muted; c.font = '20px ui-monospace, monospace'; c.fillText('1 g', cx + R / gmax + 6, cy - 6);
}

export function drawWindshield() {
  const c = D.wsctx, W = D.wsc.width, H = D.wsc.height;
  c.clearRect(0, 0, W, H);
  const grd = c.createLinearGradient(0, 0, 0, H); grd.addColorStop(0, '#1a2a3a'); grd.addColorStop(1, '#0d1a26'); c.fillStyle = grd; c.fillRect(0, 0, W, H);
  c.fillStyle = 'rgba(190,215,240,0.55)'; for (const d of drops) { c.beginPath(); c.arc(d.x * W, d.y * H, d.r * W, 0, Math.PI * 2); c.fill(); }
  const px = W / 2, py = H * 1.08, Lb = H * 1.02, a = Math.PI - wiper.ang;
  c.strokeStyle = '#0b0b0c'; c.lineWidth = 7; c.lineCap = 'round'; c.beginPath(); c.moveTo(px, py); c.lineTo(px + Math.cos(a) * Lb, py - Math.sin(a) * Lb); c.stroke();
  if (!cfg.rain) { c.fillStyle = 'rgba(237,232,221,0.6)'; c.font = '22px ui-monospace, monospace'; c.fillText('Dry. Turn the rain on.', 20, 36); }
}

export function updateModStats() {
  const e = engine(), E = D.el;
  E.stRotary.textContent = `${e.name}: ${Math.round(e.P / 1000)} kW peak at ${e.peak.toLocaleString('en-CA')} rpm · ${Math.round(car.rpm).toLocaleString('en-CA')} rpm now`;
  E.stWiper.textContent = cfg.rain ? `Grip 0.85 (dry 1.25) · windshield ${Math.round(coverage() * 100)}% covered · ${cfg.wiper === 'int' ? 'pause ' + cfg.dwell.toFixed(1) + ' s' : cfg.wiper}` : 'Dry track · grip 1.25';
  E.stGround.textContent = `Downforce ${Math.round(car.DF || 0).toLocaleString('en-CA')} N at ${Math.round(Math.abs(car.vx) * 3.6)} km/h`;
  E.stFlat.textContent = `Diagonal difference ${tire.ema.toFixed(3)}% · warns between 0.05% and 0.6%`;
  E.stDelta.textContent = lap.best ? `Best ${fmtT(lap.best.time)} · ${lap.n} lap${lap.n === 1 ? '' : 's'} this session` : 'Set a lap to create the reference';
  E.stSlip.textContent = `${(car.beta * 180 / Math.PI).toFixed(1)}° now · drift score ${Math.round(sim.drift)}`;
  E.stInerter.textContent = `Kerb grip ${Math.round(KERB.classic * 100)}% without · ${Math.round(KERB.inerter * 100)}% with${car.surface === 'kerb' ? ' · on a kerb now' : ''}`;
}

export function drawDash(dt) {
  drawGG(); drawWindshield();
  D.dashAcc += dt; if (D.dashAcc < 0.05) return; D.dashAcc = 0;
  const e = engine(), E = D.el;
  E.spd.textContent = Math.round(Math.abs(car.vx) * 3.6);
  E.gear.textContent = car.vx < -0.3 ? 'R' : car.gear;
  const rf = car.rpm / e.limit;
  E.rpmbar.style.width = (clamp(rf, 0, 1) * 100).toFixed(1) + '%';
  E.rpm.textContent = Math.round(car.rpm).toLocaleString('en-CA') + ' rpm';
  D.lights.forEach((l, i) => l.classList.toggle('on', rf > [0.8, 0.85, 0.9, 0.94, 0.97][i]));
  E.lap.textContent = lap.started ? fmtT(lap.t) : '0:00.00';
  E.last.textContent = fmtT(lap.last); E.best.textContent = lap.best ? fmtT(lap.best.time) : '–';
  const b = Math.min(NB - 1, Math.floor(TR[car.idx].s / LEN * NB));
  if (lap.started && lap.best && Number.isFinite(lap.best.times[b])) { const dv = lap.t - lap.best.times[b]; E.delta.textContent = (dv >= 0 ? '+' : '−') + Math.abs(dv).toFixed(2); E.delta.className = 'v ' + (dv < 0 ? 'good' : 'bad'); }
  else { E.delta.textContent = '–'; E.delta.className = 'v'; }
  const deg = car.beta * 180 / Math.PI;
  E.needle.setAttribute('transform', `rotate(${clamp(deg, -15, 15) * 6} 75 78)`);
  E.slipv.textContent = deg.toFixed(1) + '°'; E.drift.textContent = Math.round(sim.drift);
  E.thr.style.width = (inp.thr * 100).toFixed(0) + '%'; E.brk.style.width = (inp.brk * 100).toFixed(0) + '%';
  E.str.style.left = (50 + inp.steer * 48).toFixed(1) + '%';
  E.gval.textContent = (Math.hypot(car.ax, car.ay) / G).toFixed(2) + ' g';
  E.tirelight.classList.toggle('on', !!tire.warn);
  E.tiretxt.textContent = tire.warn ? `Low tire: ${tire.warn}` : 'Tire monitor: all four OK';
  const surf = [];
  if (car.surface === 'kerb') surf.push(`<span class="kerb">Kerb · grip ${Math.round((cfg.inerter ? KERB.inerter : KERB.classic) * 100)}%</span>`);
  if (car.surface === 'grass') surf.push('<span class="grass">Off track</span>');
  if (cfg.rain) surf.push(`<span class="rain">Rain · view ${Math.round((1 - coverage()) * 100)}%</span>`);
  E.surface.innerHTML = surf.join('');
  E.chip.innerHTML = `Input: <b>${inp.src}</b>`;
  E.chip.classList.toggle('live', inp.src === 'Wheel' || inp.src === 'VR controllers');
  updateModStats();
}

export function renderLapTable() {
  const tb = $('#laptable'), th = $('#lapthead'); if (!tb) return;
  if (th) th.innerHTML = '<tr><th>Lap</th><th>Time</th><th>Delta to best</th><th>Switches</th><th>Top speed</th></tr>';
  if (!lap.list.length) { tb.innerHTML = `<tr><td colspan="5" class="empty">No laps yet. Cross the start line twice.</td></tr>`; return; }
  const swNames = [['rotary', 'Rotary'], ['rain', 'Rain'], ['ground', 'Ground effect'], ['inerter', 'Inerter'], ['flat', 'Soft RL']];
  tb.innerHTML = lap.list.slice(0, 30).map(l => `<tr><td class="num">${l.n}${l.valid ? '' : ' · off track'}</td><td class="num">${fmtT(l.time)}</td><td class="num">${l.delta === null ? 'first lap' : (l.delta >= 0 ? '+' : '−') + Math.abs(l.delta).toFixed(2)}</td><td>${(swNames.map(([k, n]) => l.switches[k] ? `<span class="pill on">${n}</span>` : '').join('') + (l.switches.assist ? '' : '<span class="pill on">Aids off</span>')) || '<span class="pill">Stock</span>'}${l.auto ? '<span class="pill">Test driver</span>' : ''}</td><td class="num">${Number.isFinite(l.top) ? Math.round(l.top) + ' km/h' : '–'}</td></tr>`).join('');
}

export function initDash() {
  if (D.ready) return; D.ready = true;
  D.COL = { line: css('--line'), accent: css('--accent'), muted: css('--muted') };
  $('#timeline').innerHTML = MODS.map(modHTML).join('');
  D.gctx = $('#gg').getContext('2d'); D.wsc = $('#ws'); D.wsctx = D.wsc.getContext('2d');
  D.lights = Array.from(document.querySelectorAll('#lights i'));
  D.el = {
    spd: $('#spd'), gear: $('#gear'), rpmbar: $('#rpmbar'), rpm: $('#rpm'), lap: $('#lap'), last: $('#last'), best: $('#best'), delta: $('#delta'),
    needle: $('#needle'), slipv: $('#slip'), drift: $('#drift'), thr: $('#thr'), brk: $('#brk'), str: $('#str'), gval: $('#gval'), tirelight: $('#tirelight'),
    tiretxt: $('#tiretxt'), surface: $('#surface'), chip: $('#in-chip'),
    stRotary: $('#st-rotary'), stWiper: $('#st-wiper'), stGround: $('#st-ground'), stFlat: $('#st-flat'), stDelta: $('#st-delta'), stSlip: $('#st-slip'), stInerter: $('#st-inerter')
  };
  document.addEventListener('click', e => {
    const sw = e.target.closest('[data-sw]'); if (!sw) return;
    const k = sw.dataset.sw; cfg[k] = !cfg[k];
    sw.setAttribute('aria-pressed', cfg[k]); sw.lastElementChild.textContent = LABEL[k][cfg[k] ? 1 : 0];
    const modId = { rain: 'wiper', assist: 'slip' }[k] || k; $('#mod-' + modId).classList.toggle('on', k === 'assist' ? !cfg.assist : cfg[k]);
    if (k === 'flat' && !cfg.flat) tireReset();
    if (k === 'rain' && !cfg.rain) drops.length = 0;
    if (k === 'rotary') { const e2 = engine(); $('#eng').textContent = `${e2.name} · ${e2.limit.toLocaleString('en-CA')} limit`; }
  });
  $('#wmode').addEventListener('change', e => { cfg.wiper = e.target.value; });
  $('#dwell').addEventListener('input', e => { cfg.dwell = parseFloat(e.target.value); $('#dwellv').textContent = cfg.dwell.toFixed(1) + ' s'; });
  renderLapTable(); updateModStats();
}
