import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseFrame, parseMessage, parseRecording } from './messages';

const replayText = readFileSync(new URL('../../public/replay.json', import.meta.url), 'utf8');

const link = { delivered: 1, lost: 0, duplicates: 0, late: 0, malformed: 0, held: 0, behind: 0 };
const sample = { seq: 0, ts: 0, rx: 45, id: 256, tx: 1, v: { EngineRPM: 8000, Throttle: 50 } };
const meta = {
  source: 'recorded replay',
  seed: 1,
  duration_s: 10,
  loss: 0,
  delay_ms: 40,
  jitter_ms: 8,
  outages_s: [[2, 4]],
  buffer: 2048,
  batch_ms: 50,
  frames_per_second: 220,
  messages: { '256': 'ENGINE' },
  signals: { EngineRPM: { unit: 'rpm', min: 0, max: 16383.75, message: 'ENGINE' } },
};

describe('parsing messages from a server that may be wrong', () => {
  it('accepts a good batch', () => {
    const p = parseMessage({ type: 'batch', rx_ms: 50, samples: [sample], link });
    expect(p.dropped).toBe(0);
    expect(p.message?.type).toBe('batch');
  });

  it('accepts a good hello and keeps the outage list', () => {
    const p = parseMessage({ type: 'hello', v: 1, meta });
    expect(p.message?.type === 'hello' && p.message.meta.outages_s).toEqual([[2, 4]]);
  });

  it('throws away a sample that arrives before it was made', () => {
    const p = parseMessage({ type: 'batch', rx_ms: 50, samples: [{ ...sample, ts: 100, rx: 50 }, sample], link });
    expect(p.dropped).toBe(1);
    expect(p.message?.type === 'batch' && p.message.samples).toHaveLength(1);
  });

  it.each([
    ['a string where a number goes', { ...sample, seq: '1' }],
    ['a negative sequence number', { ...sample, seq: -1 }],
    ['an infinite time', { ...sample, rx: Number.POSITIVE_INFINITY }],
    ['a missing field', { seq: 1, ts: 0, rx: 5, id: 1 }],
    ['a signal that is not a number', { ...sample, v: { Speed: 'fast' } }],
    ['a signal value of null', { ...sample, v: { Speed: null } }],
    ['signals that are an array', { ...sample, v: [1, 2] }],
    ['nothing at all', null],
  ])('drops a sample with %s and keeps the batch', (_name, bad) => {
    const p = parseMessage({ type: 'batch', rx_ms: 50, samples: [bad, sample], link });
    expect(p.dropped).toBe(1);
    expect(p.message?.type === 'batch' && p.message.samples).toHaveLength(1);
  });

  it.each([
    ['no type', {}],
    ['an unknown type', { type: 'explode' }],
    ['a batch with no link stats', { type: 'batch', rx_ms: 1, samples: [] }],
    ['a batch with samples that are not a list', { type: 'batch', rx_ms: 1, samples: 'x', link }],
    ['a batch with a negative time', { type: 'batch', rx_ms: -5, samples: [], link }],
    ['a hello with no signals', { type: 'hello', meta: { ...meta, signals: undefined } }],
    ['a hello with a zero batch time', { type: 'hello', meta: { ...meta, batch_ms: 0 } }],
    ['an end with no summary', { type: 'end', rx_ms: 5 }],
    ['an array', []],
    ['a number', 7],
    ['null', null],
  ])('rejects %s', (_name, bad) => {
    const p = parseMessage(bad);
    expect(p.message).toBeNull();
    expect(p.dropped).toBe(1);
  });

  it('drops a bad outage entry instead of failing the hello', () => {
    const p = parseMessage({ type: 'hello', meta: { ...meta, outages_s: [[5, 2], [1, 3], 'x'] } });
    expect(p.message?.type === 'hello' && p.message.meta.outages_s).toEqual([[1, 3]]);
  });
});

describe('parsing a WebSocket frame', () => {
  it('survives junk text, binary and nonsense', () => {
    for (const junk of ['', 'not json', '{', '[1,2', 'null', '"hello"', new ArrayBuffer(4), 42, undefined, null]) {
      const p = parseFrame(junk);
      expect(p.message).toBeNull();
      expect(p.dropped).toBe(1);
    }
  });

  it('parses a valid frame', () => {
    const p = parseFrame(JSON.stringify({ type: 'end', rx_ms: 9, summary: { generated: 2, delivered: 2, lost: 0, unresolved: 0 } }));
    expect(p.message?.type).toBe('end');
  });
});

describe('parsing a recording', () => {
  it('reads the committed replay with nothing dropped', () => {
    const r = parseRecording(replayText);
    expect(r).not.toBeNull();
    expect(r?.dropped).toBe(0);
    expect(r?.messages[0]?.type).toBe('hello');
    expect(r?.messages.at(-1)?.type).toBe('end');
    expect(r?.messages.length).toBe(803);
  });

  it.each([
    ['not JSON', 'oops'],
    ['an object', '{"a":1}'],
    ['an empty list', '[]'],
    ['a list with no hello first', JSON.stringify([{ type: 'batch', rx_ms: 1, samples: [], link }, { type: 'batch', rx_ms: 2, samples: [], link }])],
    ['a hello and nothing else', JSON.stringify([{ type: 'hello', meta }, { type: 'hello', meta }])],
  ])('refuses %s', (_name, text) => {
    expect(parseRecording(text)).toBeNull();
  });

  it('drops a batch that goes back in time', () => {
    const text = JSON.stringify([
      { type: 'hello', meta },
      { type: 'batch', rx_ms: 100, samples: [], link },
      { type: 'batch', rx_ms: 50, samples: [], link },
      { type: 'batch', rx_ms: 150, samples: [], link },
    ]);
    const r = parseRecording(text);
    expect(r?.messages.map((m) => (m.type === 'hello' ? 0 : m.rx_ms))).toEqual([0, 100, 150]);
    expect(r?.dropped).toBe(1);
  });
});
