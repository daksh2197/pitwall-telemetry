// Tire monitor (1987): compare diagonal wheel-speed sums. DOM-free.
export const tire = { ema: 0, dev: [0, 0, 0, 0], warn: null };

export function tireReset() { tire.ema = 0; tire.dev = [0, 0, 0, 0]; tire.warn = null; }

// opts: {tw: half track width, rw: wheel radius, rnd: random source}
export function tireTick(dt, car, cfg, opts) {
  const { tw, rw } = opts, rnd = opts.rnd || Math.random;
  if (car.vx > 12 && Math.abs(car.ay) < 1.2) {
    const vl = car.vx - car.r * tw, vr = car.vx + car.r * tw, n = () => 1 + (rnd() - 0.5) * 0.0008;
    const w = [vl / rw * n(), vr / rw * n(), vl / (rw * (cfg.flat ? 0.996 : 1)) * n(), vr / rw * n()]; // FL FR RL RR
    const sum = w[0] + w[1] + w[2] + w[3], mean = sum / 4;
    const DEL = ((w[0] + w[3]) - (w[1] + w[2])) / (sum / 2) * 100;
    const k = Math.min(1, dt / 1.5);
    tire.ema += (DEL - tire.ema) * k;
    for (let i = 0; i < 4; i++) tire.dev[i] += (((w[i] - mean) / mean * 100) - tire.dev[i]) * k;
    const a = Math.abs(tire.ema), mx = Math.max(...tire.dev);
    if (a > 0.05 && a < 0.6 && mx > 0.1) tire.warn = ['front-left', 'front-right', 'rear-left', 'rear-right'][tire.dev.indexOf(mx)];
  }
}
