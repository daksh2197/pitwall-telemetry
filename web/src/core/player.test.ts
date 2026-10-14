import { describe, expect, it } from 'vitest';
import type { Message } from './messages';
import { Player } from './player';

const link = { delivered: 0, lost: 0, duplicates: 0, late: 0, malformed: 0, held: 0, behind: 0 };
const hello = { type: 'hello', meta: {} } as unknown as Message;
const batch = (rx_ms: number): Message => ({ type: 'batch', rx_ms, samples: [], link });
const end = (rx_ms: number): Message => ({
  type: 'end',
  rx_ms,
  summary: { generated: 0, delivered: 0, lost: 0, unresolved: 0 },
});
const times = (ms: Message[]) => ms.map((m) => (m.type === 'hello' ? 'hello' : m.rx_ms));

function recording(): Message[] {
  return [hello, batch(50), batch(100), batch(150), batch(200), end(200)];
}

describe('the player', () => {
  it('hands out nothing while paused', () => {
    const p = new Player(recording());
    expect(p.tick(1000)).toEqual([]);
    expect(p.position).toBe(0);
  });

  it('hands out the hello and then each batch when its time comes', () => {
    const p = new Player(recording());
    p.playing = true;
    expect(times(p.tick(60))).toEqual(['hello', 50]);
    expect(times(p.tick(40))).toEqual([100]);
    expect(p.tick(10)).toEqual([]);
    expect(times(p.tick(50))).toEqual([150]);
  });

  it('stops by itself at the end and says it is done', () => {
    const p = new Player(recording());
    p.playing = true;
    const got = [...p.tick(250), ...p.tick(250)];
    expect(times(got)).toEqual(['hello', 50, 100, 150, 200, 200]);
    expect(p.done).toBe(true);
    expect(p.playing).toBe(false);
    expect(p.duration).toBe(200);
  });

  it('plays faster at 4 times speed', () => {
    const p = new Player(recording());
    p.playing = true;
    p.setSpeed(4);
    expect(times(p.tick(30))).toEqual(['hello', 50, 100]);
  });

  it('does not play a minute in one go after the tab was asleep', () => {
    const long = [hello, ...Array.from({ length: 100 }, (_, i) => batch((i + 1) * 50)), end(5000)];
    const p = new Player(long);
    p.playing = true;
    expect(p.tick(60_000).length).toBeLessThanOrEqual(6); // at most 250 ms of recording
  });

  it('ignores nonsense time steps and nonsense speeds', () => {
    const p = new Player(recording());
    p.playing = true;
    for (const dt of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) expect(p.tick(dt)).toEqual([]);
    p.setSpeed(Number.NaN);
    p.setSpeed(-3);
    p.setSpeed(0);
    expect(p.speed).toBe(1);
  });

  it('seeks by returning everything up to that time from the start, then carries on without repeats', () => {
    const p = new Player(recording());
    p.playing = true;
    p.tick(250);
    expect(times(p.seek(120))).toEqual(['hello', 50, 100]);
    expect(p.done).toBe(false);
    p.playing = true;
    expect(times(p.tick(40))).toEqual([150]);
  });

  it('seeks to the very start and to far past the end without breaking', () => {
    const p = new Player(recording());
    expect(times(p.seek(0))).toEqual(['hello']);
    expect(times(p.seek(1e9))).toEqual(['hello', 50, 100, 150, 200, 200]);
    expect(p.done).toBe(true);
    expect(times(p.seek(Number.NaN))).toEqual(['hello']);
    expect(times(p.seek(-5))).toEqual(['hello']);
  });
});
