// WebXR seated cockpit for Pitwall Sim: "Enter VR (untested)" button, in-world dash panel, headset controller driving.
// Untested on a headset. Only the code paths reachable in desktop Chromium have been exercised.
//
// How it works: the camera used for rendering is parented to v3.cockpit (inside the car group). three r159's WebXRManager
// composes the headset pose with camera.parent.matrixWorld, so the head sits in the driver's seat and rides with the car.
// Controls (xr-standard mapping): right trigger = gas, left trigger = brake, left thumbstick x = steer.
// Recentre: right controller A button (buttons[4]).
import { setXRReader } from './input.js';
import { useXRLoop, endXRLoop } from './loop.js';
import { car } from './physics.js';
import { lap } from './laps.js';
import { tire } from './tire-monitor.js';
import { TR, binOf } from './track.js';
import { clamp } from './state.js';

const DEAD = 0.08;

export async function initXR({ v3, button }) {
  try {
    if (!v3 || typeof navigator === 'undefined' || !navigator.xr || !button) return;
    const ok = await navigator.xr.isSessionSupported('immersive-vr').catch(() => false);
    if (!ok) return;
    button.hidden = false; button.style.display = ''; button.textContent = 'Enter VR (untested)';

    const THREE = v3.THREE, renderer = v3.renderer;
    let session = null, panel = null, timer = 0, aPrev = false;

    function makePanel() {
      const cv = document.createElement('canvas'); cv.width = 512; cv.height = 224;
      const tex = new THREE.CanvasTexture(cv);
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.22), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));
      mesh.position.set(0, -0.15, -0.9); mesh.rotation.x = -0.3;
      v3.cockpit.add(mesh);
      return { cv, tex, mesh, ctx: cv.getContext('2d') };
    }
    function fmt(t) { if (!(t >= 0)) return '--:--.---'; const m = Math.floor(t / 60); return m + ':' + (t - m * 60).toFixed(3).padStart(6, '0'); }
    function draw() {
      if (!panel) return;
      const c = panel.ctx, W = 512, H = 224, mono = '"Geist Mono", ui-monospace, Menlo, monospace';
      c.fillStyle = '#111214'; c.fillRect(0, 0, W, H);
      c.strokeStyle = '#2c2d32'; c.lineWidth = 3; c.strokeRect(2, 2, W - 4, H - 4);
      c.textBaseline = 'alphabetic';
      c.fillStyle = '#ede8dd'; c.font = '600 84px ' + mono; c.textAlign = 'left';
      c.fillText(String(Math.max(0, Math.round((car.vx || 0) * 3.6))), 20, 100);
      c.fillStyle = '#a9a498'; c.font = '22px ' + mono; c.fillText('km/h', 24, 130);
      c.fillStyle = '#ff5a1f'; c.font = '600 84px ' + mono; c.textAlign = 'right';
      c.fillText(String(car.gear || 1), W - 24, 100);
      c.fillStyle = '#a9a498'; c.font = '22px ' + mono; c.fillText('GEAR', W - 24, 130);
      c.textAlign = 'left'; c.fillStyle = '#ede8dd'; c.font = '34px ' + mono;
      c.fillText(lap.started ? fmt(lap.t) : '--:--.---', 20, 176);
      let delta = null;
      if (lap.started && lap.best && lap.best.times) { const b = lap.best.times[binOf(TR[car.idx].s)]; if (Number.isFinite(b)) delta = lap.t - b; }
      c.textAlign = 'right'; c.font = '34px ' + mono;
      c.fillStyle = delta == null ? '#a9a498' : delta <= 0 ? '#3ccf8e' : '#ff5d5d';
      c.fillText(delta == null ? '+-.---' : (delta > 0 ? '+' : '') + delta.toFixed(3), W - 24, 176);
      c.textAlign = 'left'; c.font = '22px ' + mono; c.fillStyle = '#a9a498';
      c.fillText('SLIP ' + ((car.beta || 0) * 180 / Math.PI).toFixed(1) + '°', 20, 208);
      if (tire && tire.warn) { c.textAlign = 'right'; c.fillStyle = '#f4b740'; c.fillText('TIRE WARNING', W - 24, 208); }
      panel.tex.needsUpdate = true;
    }

    function reader() {
      if (!session) return null;
      let L = null, R = null;
      for (const s of session.inputSources) { if (!s.gamepad) continue; if (s.handedness === 'left') L = s.gamepad; else if (s.handedness === 'right') R = s.gamepad; }
      if (!L && !R) return null;
      const ax = L && L.axes.length > 2 ? L.axes[2] : 0;
      const steer = Math.abs(ax) < DEAD ? 0 : Math.sign(ax) * (Math.abs(ax) - DEAD) / (1 - DEAD);
      const a = !!(R && R.buttons[4] && R.buttons[4].pressed);
      if (a && !aPrev) recentre();
      aPrev = a;
      return { thr: R && R.buttons[0] ? R.buttons[0].value : 0, brk: L && L.buttons[0] ? L.buttons[0].value : 0, steer: clamp(steer, -1, 1) };
    }

    // Move the cockpit so the current head position sits at the driver's eye again (position only).
    function recentre() {
      const cam = v3.camera; if (!cam || !v3.cockpit) return;
      const off = cam.position.clone().applyQuaternion(v3.cockpit.quaternion);
      v3.cockpit.position.copy(v3.cockpitBase).sub(off);
    }

    function onEnd() {
      session = null; clearInterval(timer);
      endXRLoop(); v3.setXRMode(false); setXRReader(null);
      if (panel) panel.mesh.visible = false;
      button.textContent = 'Enter VR (untested)'; button.disabled = false;
    }

    button.addEventListener('click', async () => {
      if (session) { try { await session.end(); } catch (e) { /* ignore */ } return; }
      let s = null;
      try {
        button.disabled = true;
        s = await navigator.xr.requestSession('immersive-vr', { optionalFeatures: ['local-floor', 'bounded-floor'] });
        renderer.xr.enabled = true;
        renderer.xr.setReferenceSpaceType('local');
        await renderer.xr.setSession(s);
        session = s;
        s.addEventListener('end', onEnd);
        if (!panel) panel = makePanel();
        panel.mesh.visible = true;
        v3.setXRMode(true);
        useXRLoop(renderer);
        setXRReader(reader);
        draw(); timer = setInterval(draw, 100);
        button.textContent = 'Exit VR'; button.disabled = false;
      } catch (e) {
        console.warn('VR unavailable:', e && e.message ? e.message : e);
        button.textContent = 'VR unavailable'; button.disabled = false;
        try { if (s && s !== session) await s.end(); else if (session) await session.end(); } catch (e2) { /* ignore */ }
        session = null; renderer.xr.enabled = false; setXRReader(null); endXRLoop(); v3.setXRMode(false);
      }
    });
  } catch (e) {
    console.warn('VR init failed:', e && e.message ? e.message : e);
  }
}
