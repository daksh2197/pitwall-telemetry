// 3D view (three.js r159, loaded lazily through loadThree). Ribbon track from TR, kerbs, start line, low-poly car,
// ground-effect undertray, rain, cockpit windshield with wiper, chase and cockpit cameras.
// Pure geometry helpers (buildStrip, buildRibbon, kerbQuads, dashQuads, startLineQuad) need no THREE and no DOM.
// Cockpit frame: view3d.cockpit is an Object3D inside the car group at the driver's eye, rotated so its -Z is the
// car's forward, +X is the car's right and +Y is up (so it is also a camera frame).
import { W2, TR, NTR, BOUNDS } from './track.js';
import { car } from './physics.js';
import { cfg, inp, clamp } from './state.js';
import { drops, wiper } from './wiper.js';
import { loadThree } from './three-loader.js';

const C = { grass: 0x14211a, asphalt: 0x2b2c30, edge: 0x3a3b40, kr: [0xd8, 0x40, 0x2b], kw: [0xed, 0xe8, 0xdd], accent: 0xff5a1f, text: 0xede8dd, bg: 0x111214 };

// ---- pure geometry (DOM-free, THREE-free) ----

// Flip any triangle that faces down so every flat strip is lit from above.
function upFacing(positions, indices) {
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
    const ux = positions[b] - positions[a], uz = positions[b + 2] - positions[a + 2], vx = positions[c] - positions[a], vz = positions[c + 2] - positions[a + 2];
    if (uz * vx - ux * vz < 0) { const k = indices[t + 1]; indices[t + 1] = indices[t + 2]; indices[t + 2] = k; }
  }
  return indices;
}

// Triangle strip along the closed loop: vertex 2i sits at offset o0 along the normal (-ty, tx), vertex 2i+1 at o1.
// Sim (x, y) maps to world (x, h, y). Closed: the last pair connects back to the first (2*NTR vertices).
export function buildStrip(tr, o0, o1, h = 0) {
  const n = tr.length, positions = new Float32Array(n * 6), indices = [];
  for (let i = 0; i < n; i++) {
    const p = tr[i], nx = -p.ty, ny = p.tx;
    positions.set([p.x + nx * o0, h, p.y + ny * o0, p.x + nx * o1, h, p.y + ny * o1], i * 6);
    const j = (i + 1) % n;
    indices.push(2 * i, 2 * i + 1, 2 * j, 2 * i + 1, 2 * j + 1, 2 * j);
  }
  return { positions, indices: upFacing(positions, Uint32Array.from(indices)) };
}
export function buildRibbon(tr, w2, h = 0) { return buildStrip(tr, -w2, w2, h); }

// Kerb quads on both outer edges (outer `width` metres), wherever both ends of the segment are kerb points.
// Four vertices per quad, alternating red and white. quads[q] = {i, side, red}.
export function kerbQuads(tr, w2, width = 1.2, h = 0.02) {
  const n = tr.length, quads = [], pos = [], col = [], idx = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    if (!tr[i].kerb || !tr[j].kerb) continue;
    const red = i % 2 === 0, c = red ? C.kr : C.kw;
    for (const side of [-1, 1]) {
      const o0 = side * (w2 - width), o1 = side * w2, b = pos.length / 3;
      for (const [p, o] of [[tr[i], o0], [tr[i], o1], [tr[j], o0], [tr[j], o1]]) {
        pos.push(p.x - p.ty * o, h, p.y + p.tx * o); col.push(c[0] / 255, c[1] / 255, c[2] / 255);
      }
      idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
      quads.push({ i, side, red });
    }
  }
  const P = new Float32Array(pos);
  return { positions: P, colors: new Float32Array(col), indices: upFacing(P, Uint32Array.from(idx)), quads };
}

// Faint dashed centre line: 4 m on, 4 m off (2 samples on, 2 off).
export function dashQuads(tr, hw = 0.12, h = 0.015) {
  const n = tr.length, pos = [], idx = [];
  for (let i = 0; i < n; i += 4) {
    const a = tr[i], b = tr[(i + 2) % n], v = pos.length / 3;
    for (const [p, o] of [[a, -hw], [a, hw], [b, -hw], [b, hw]]) pos.push(p.x - p.ty * o, h, p.y + p.tx * o);
    idx.push(v, v + 1, v + 2, v + 1, v + 3, v + 2);
  }
  const P = new Float32Array(pos);
  return { positions: P, indices: upFacing(P, Uint32Array.from(idx)) };
}

// White start line across TR[0], `thick` metres deep along the track.
export function startLineQuad(tr, w2, thick = 0.8, h = 0.03) {
  const p = tr[0], pos = [];
  for (const [d, o] of [[0, -w2], [0, w2], [thick, -w2], [thick, w2]]) pos.push(p.x + p.tx * d - p.ty * o, h, p.y + p.ty * d + p.tx * o);
  const P = new Float32Array(pos);
  return { positions: P, indices: upFacing(P, Uint32Array.from([0, 1, 2, 1, 3, 2])) };
}

// ---- the view ----

function geo(THREE, g, withColor) {
  const b = new THREE.BufferGeometry();
  b.setAttribute('position', new THREE.BufferAttribute(g.positions, 3));
  const nv = g.positions.length / 3, nrm = new Float32Array(nv * 3);
  for (let i = 0; i < nv; i++) nrm[i * 3 + 1] = 1;
  b.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  if (withColor) b.setAttribute('color', new THREE.BufferAttribute(g.colors, 3));
  b.setIndex(new THREE.BufferAttribute(g.indices, 1));
  return b;
}

export async function initView3d(viewEl, opts = {}) {
  try {
    if (typeof document === 'undefined') return null;
    const THREE = await loadThree();
    const canvas = document.createElement('canvas');
    if (!(canvas.getContext('webgl2') || canvas.getContext('webgl'))) return null;
    let renderer;
    try { renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' }); }
    catch (e) { return null; }
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    const cv = renderer.domElement;
    cv.className = 'v3d';
    cv.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:none';
    viewEl.insertBefore(cv, viewEl.firstChild);

    let reduced = false, mq = null;
    try {
      mq = window.matchMedia('(prefers-reduced-motion: reduce)'); reduced = mq.matches;
      const on = e => { reduced = e.matches; buildRain(); };
      if (mq.addEventListener) mq.addEventListener('change', on); else if (mq.addListener) mq.addListener(on);
    } catch (e) { /* no matchMedia */ }

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(C.bg);
    scene.fog = new THREE.Fog(C.bg, 90, 700);
    const camera = new THREE.PerspectiveCamera(62, 1.6, 0.25, 2500);
    scene.add(camera);

    scene.add(new THREE.HemisphereLight(0xb9c4dc, 0x2a3a30, 1.7));
    const sun = new THREE.DirectionalLight(0xffe6c8, 1.5); sun.position.set(-60, 90, 40); scene.add(sun);

    // ground
    const cx = (BOUNDS.x0 + BOUNDS.x1) / 2, cz = (BOUNDS.y0 + BOUNDS.y1) / 2;
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(6000, 6000), new THREE.MeshLambertMaterial({ color: C.grass }));
    ground.rotation.x = -Math.PI / 2; ground.position.set(cx, -0.3, cz); scene.add(ground);

    // track
    let layer = 0; // polygonOffset layers keep the flat strips from z-fighting on low-precision depth buffers
    const flat = (g, color, vc) => { layer++; const o = { side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -layer, polygonOffsetUnits: -layer * 2 }; return new THREE.Mesh(geo(THREE, g, vc), new THREE.MeshLambertMaterial(vc ? { vertexColors: true, ...o } : { color, ...o })); };
    const trackG = new THREE.Group(); scene.add(trackG);
    trackG.add(flat(buildRibbon(TR, W2 + 0.35, 0), C.edge));
    trackG.add(flat(buildRibbon(TR, W2, 0.01), C.asphalt));
    trackG.add(flat(dashQuads(TR), 0x5a5a5e));
    trackG.add(flat(kerbQuads(TR, W2 + 0.35, 1.2, 0.02), 0, true));
    trackG.add(flat(startLineQuad(TR, W2), C.text));
    trackG.children[2].material.transparent = true; trackG.children[2].material.opacity = 0.35;

    // car
    const carG = new THREE.Group(); scene.add(carG);
    const mOr = new THREE.MeshLambertMaterial({ color: C.accent }), mDk = new THREE.MeshLambertMaterial({ color: 0x15161a });
    const mBk = new THREE.MeshLambertMaterial({ color: 0x0b0b0c }), mWh = new THREE.MeshLambertMaterial({ color: 0xede8dd });
    const box = (w, h, d, m, x, y, z, parent = carG) => { const o = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); o.position.set(x, y, z); parent.add(o); return o; };
    box(4.6, 0.5, 1.8, mOr, 0, 0.45, 0);                       // tub
    const nose = box(1.4, 0.22, 1.5, mOr, 1.9, 0.58, 0); nose.rotation.z = -0.12; // hood slope
    box(1.3, 0.3, 1.5, mOr, -1.5, 0.78, 0);                    // rear deck
    const cabin = box(1.7, 0.42, 1.25, mDk, -0.35, 0.92, 0); cabin.rotation.z = 0.0;
    box(0.2, 0.08, 1.9, mDk, -2.35, 0.95, 0);                   // spoiler blade
    const wheels = [], pivots = [];
    for (const [wx, wz, front] of [[1.25, -0.95, 1], [1.25, 0.95, 1], [-1.35, -0.95, 0], [-1.35, 0.95, 0]]) {
      const piv = new THREE.Group(); piv.position.set(wx, 0.33, wz); carG.add(piv);
      const g = new THREE.CylinderGeometry(0.33, 0.33, 0.28, 16); g.rotateX(Math.PI / 2);
      const w = new THREE.Mesh(g, mBk); piv.add(w);
      box(0.5, 0.08, 0.02, new THREE.MeshLambertMaterial({ color: 0x55565c }), 0, 0, wz > 0 ? 0.15 : -0.15, w);
      wheels.push(w); if (front) pivots.push(piv);
    }
    // undertray: plate, side skirts, rear plate (cfg.ground)
    const tray = new THREE.Group(); carG.add(tray);
    box(3.7, 0.04, 1.7, mWh, 0, 0.12, 0, tray);
    box(3.7, 0.12, 0.04, mWh, 0, 0.1, -0.88, tray); box(3.7, 0.12, 0.04, mWh, 0, 0.1, 0.88, tray);
    box(0.25, 0.4, 1.9, mWh, -2.5, 0.6, 0, tray);
    // cockpit furniture (visible only from the cockpit)
    const cockFurn = new THREE.Group(); carG.add(cockFurn);
    box(0.5, 0.22, 1.5, mDk, 1.1, 0.62, 0, cockFurn);
    const wheelG = new THREE.Group(); wheelG.position.set(0.6, 0.75, 0); cockFurn.add(wheelG);
    const tg = new THREE.TorusGeometry(0.16, 0.022, 8, 20); tg.rotateY(Math.PI / 2);
    wheelG.add(new THREE.Mesh(tg, mBk));
    // driver's eye
    const cockpit = new THREE.Object3D(); cockpit.position.set(0.15, 1.1, 0); cockpit.rotation.y = -Math.PI / 2; carG.add(cockpit);
    const cockpitBase = cockpit.position.clone(); // xr.js recentres relative to this

    // windshield + wiper (parented to cockpit, -Z forward)
    const WW = 2.6, WH = 1.1;
    const shield = new THREE.Group(); shield.position.set(0, 0.1, -1.2); cockpit.add(shield);
    const glass = new THREE.Mesh(new THREE.PlaneGeometry(WW, WH), new THREE.MeshBasicMaterial({ color: 0x6f9bd0, transparent: true, opacity: 0.05, depthWrite: false }));
    shield.add(glass);
    const dropMesh = new THREE.InstancedMesh(new THREE.CircleGeometry(1, 10), new THREE.MeshBasicMaterial({ color: 0xbfd8f2, transparent: true, opacity: 0.5, depthWrite: false }), 440);
    dropMesh.frustumCulled = false; dropMesh.position.z = 0.002; dropMesh.count = 0; shield.add(dropMesh);
    const pivot = new THREE.Object3D(); pivot.position.set(0, (0.5 - 1.08) * WH, 0.004); shield.add(pivot);
    const bladeLen = 1.02 * WH;
    const blade = new THREE.Mesh(new THREE.PlaneGeometry(bladeLen, 0.035), new THREE.MeshBasicMaterial({ color: 0x0b0b0c, side: THREE.DoubleSide }));
    blade.position.x = bladeLen / 2; pivot.add(blade);
    shield.visible = false;
    const dummy = new THREE.Object3D();

    // rain field
    let rain = null, rainN = 0;
    const RB = { x: 70, y: 30, z: 70 };
    function buildRain() {
      if (rain) { scene.remove(rain); rain.geometry.dispose(); }
      rainN = reduced ? 500 : 1800;
      const pos = new Float32Array(rainN * 6), heads = new Float32Array(rainN * 3);
      for (let i = 0; i < rainN; i++) { heads[i * 3] = (Math.random() - 0.5) * RB.x; heads[i * 3 + 1] = Math.random() * RB.y; heads[i * 3 + 2] = (Math.random() - 0.5) * RB.z; }
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      rain = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x9fbbd8, transparent: true, opacity: 0.35, fog: false }));
      rain.frustumCulled = false; rain.userData.heads = heads; rain.visible = false; scene.add(rain);
    }
    buildRain();

    // state
    let active = false, mode = 'chase', xr = false, camPsi = 0, camInit = false, spin = 0, steerVis = 0, lastRainT = 0;
    const camMain = camera, v = new THREE.Vector3();
    function attachCam() {
      const want = (mode === 'cockpit' || xr) ? cockpit : scene;
      if (camera.parent !== want) { want.add(camera); camera.position.set(0, 0, 0); camera.quaternion.identity(); camera.scale.set(1, 1, 1); }
    }

    function resize() {
      if (renderer.xr.isPresenting) return;
      const w = Math.max(1, viewEl.clientWidth), h = Math.max(1, viewEl.clientHeight);
      renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
    }
    let ro = null;
    try { ro = new ResizeObserver(resize); ro.observe(viewEl); } catch (e) { /* ignore */ }
    resize();

    function render(dt) {
      if (!active && !renderer.xr.isPresenting) return;
      dt = clamp(dt || 0.016, 0.001, 0.1);
      const cockpitView = mode === 'cockpit' || xr;
      carG.position.set(car.x, 0, car.y); carG.rotation.y = -car.psi;
      const steer = inp.steer || 0;
      const k = reduced ? 1 : 1 - Math.pow(0.0001, dt); steerVis += (steer - steerVis) * k;
      for (const p of pivots) p.rotation.y = -steerVis * 0.45;
      spin += (car.vx || 0) * dt / 0.33; for (const w of wheels) w.rotation.z = -spin;
      wheelG.rotation.x = steerVis * 1.6;
      tray.visible = !!cfg.ground; cabin.visible = !cockpitView; cockFurn.visible = cockpitView;
      attachCam();

      const sp = Math.abs(car.vx || 0);
      if (!camInit) { camPsi = car.psi; camInit = true; }
      let d = car.psi - camPsi; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
      camPsi += d * (1 - Math.pow(1 - (reduced ? 0.6 : 0.18), dt * 60));
      const fovK = reduced ? 0 : clamp(sp / 60, 0, 1);
      if (!cockpitView) {
        const back = 8 + fovK * 3, c = Math.cos(camPsi), s = Math.sin(camPsi);
        camera.position.set(car.x - c * back, 3.1 + fovK * 0.4, car.y - s * back);
        camera.lookAt(car.x + c * 6, 1.0, car.y + s * 6);
        const fov = 62 + fovK * 8; if (Math.abs(camera.fov - fov) > 0.01) { camera.fov = fov; camera.updateProjectionMatrix(); }
      } else if (!renderer.xr.isPresenting) {
        const fov = 75 + fovK * 6; if (Math.abs(camera.fov - fov) > 0.01) { camera.fov = fov; camera.updateProjectionMatrix(); }
      }

      // rain
      const wet = !!cfg.rain;
      scene.fog.color.setHex(wet ? 0x141c26 : C.bg); scene.background.setHex(wet ? 0x141c26 : C.bg);
      scene.fog.near = wet ? 40 : 90; scene.fog.far = wet ? 330 : 700;
      rain.visible = wet;
      if (wet) {
        camera.getWorldPosition(v);
        const heads = rain.userData.heads, pos = rain.geometry.attributes.position.array;
        const fall = reduced ? 9 : 16, vxw = Math.cos(car.psi) * (car.vx || 0), vzw = Math.sin(car.psi) * (car.vx || 0);
        const rx = -vxw, rz = -vzw, ry = -fall, len = reduced ? 0.012 : 0.03 + Math.min(sp, 70) * 0.0004;
        for (let i = 0; i < rainN; i++) {
          let hx = heads[i * 3] + rx * dt, hy = heads[i * 3 + 1] + ry * dt, hz = heads[i * 3 + 2] + rz * dt;
          if (hy < 0) { hy += RB.y; hx = (Math.random() - 0.5) * RB.x; hz = (Math.random() - 0.5) * RB.z; }
          if (hx < -RB.x / 2) hx += RB.x; else if (hx > RB.x / 2) hx -= RB.x;
          if (hz < -RB.z / 2) hz += RB.z; else if (hz > RB.z / 2) hz -= RB.z;
          heads[i * 3] = hx; heads[i * 3 + 1] = hy; heads[i * 3 + 2] = hz;
          const j = i * 6;
          pos[j] = v.x + hx; pos[j + 1] = hy; pos[j + 2] = v.z + hz;
          pos[j + 3] = pos[j] - rx * len; pos[j + 4] = hy - ry * len; pos[j + 5] = pos[j + 2] - rz * len;
        }
        rain.geometry.attributes.position.needsUpdate = true;
      }
      // windshield
      shield.visible = wet && cockpitView;
      if (shield.visible) {
        const n = Math.min(drops.length, 440);
        for (let i = 0; i < n; i++) {
          const dr = drops[i];
          dummy.position.set((dr.x - 0.5) * WW, (0.5 - dr.y) * WH, 0); dummy.scale.setScalar(dr.r * WW * 0.3); dummy.updateMatrix();
          dropMesh.setMatrixAt(i, dummy.matrix);
        }
        dropMesh.count = n; dropMesh.instanceMatrix.needsUpdate = true;
        pivot.rotation.z = Math.PI - wiper.ang;
      }
      renderer.render(scene, camera);
    }

    const api = {
      canvas: cv, renderer, scene, THREE,
      get camera() { return camMain; },
      cockpit, cockpitBase, car: carG,
      setActive(on) { active = !!on; cv.style.display = active ? 'block' : 'none'; if (active) resize(); },
      render,
      setCam(m) { mode = m === 'cockpit' ? 'cockpit' : 'chase'; camInit = false; attachCam(); },
      getCam() { return mode; },
      isPresenting() { return renderer.xr.isPresenting; },
      setXRMode(on) {
        xr = !!on;
        // Leaving VR: three.js left the head pose in the camera and xr.js may have recentred the cockpit; undo both.
        if (!xr) { cockpit.position.copy(cockpitBase); camera.position.set(0, 0, 0); camera.quaternion.identity(); }
        attachCam(); if (!xr) resize();
      },
    };
    return api;
  } catch (e) {
    try { console.warn('3D view unavailable:', e && e.message ? e.message : e); } catch (e2) { /* ignore */ }
    return null;
  }
}
