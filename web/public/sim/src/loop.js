// The frame loop. Normally requestAnimationFrame; while a WebXR session is presenting, the XR renderer drives it
// (window.requestAnimationFrame stops firing on headsets during immersive sessions).
const L = { fn: null, xr: null, raf: 0, go: null };
export function startLoop(fn) {
  L.fn = fn;
  L.go = t => { if (L.xr) return; L.fn(t); L.raf = requestAnimationFrame(L.go); };
  L.raf = requestAnimationFrame(L.go);
}
export function useXRLoop(renderer) {
  L.xr = renderer; cancelAnimationFrame(L.raf);
  renderer.setAnimationLoop(t => L.fn(t));
}
export function endXRLoop() {
  if (!L.xr) return;
  L.xr.setAnimationLoop(null); L.xr = null;
  L.raf = requestAnimationFrame(L.go);
}
