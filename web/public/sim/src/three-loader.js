// three.js is the only dependency. It is loaded from the vendored ES module on first use of 3D.
export function loadThree() {
  return import('../vendor/three/three.module.js');
}
