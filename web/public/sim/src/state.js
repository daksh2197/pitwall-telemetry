// Shared, DOM-free state. Every module imports these objects and mutates them in place.
// Rule: never reassign an exported binding; mutate the object instead.
export const G = 9.81;
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const APP = { name: 'pitwall-sim', version: '1.0.0' };
// The patent switches and their defaults.
export const cfg = { rotary: false, rain: false, wiper: 'int', dwell: 4, ground: false, flat: false, inerter: false, assist: true };
// Driver inputs for the current frame: thr 0..1, brk 0..1, steer -1..1 (right positive), src is a label for the dash.
export const inp = { thr: 0, brk: 0, steer: 0, src: 'Keyboard' };
// Test driver (autopilot) flag.
export const auto = { on: false };
// Loop flags: running = the sim clock is ticking (after the first click/keypress); drift = drift score.
export const sim = { running: false, drift: 0 };
