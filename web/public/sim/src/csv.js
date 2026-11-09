// Lap list to CSV. DOM-free. Pass laps oldest first.
const COLS = ['lap', 'time_s', 'valid', 'delta_s', 'rotary', 'rain', 'ground', 'inerter', 'soft_rl', 'aids', 'test_driver', 'top_kmh', 'off_track_s'];
const f = v => (v === null || v === undefined || !Number.isFinite(v) ? '' : v.toFixed(3));
const b = v => (v === null || v === undefined ? '' : v ? 'true' : 'false');
export function lapsToCSV(list) {
  const rows = [COLS.join(',')];
  for (const l of list) {
    const t = l.switches || {};
    rows.push([l.n === null || l.n === undefined ? '' : String(l.n), f(l.time), b(l.valid), f(l.delta), b(t.rotary), b(t.rain), b(t.ground), b(t.inerter), b(t.flat), b(t.assist), b(l.auto), f(l.top), f(l.off)].join(','));
  }
  return rows.join('\n') + '\n';
}
