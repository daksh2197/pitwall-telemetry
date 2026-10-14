/**
 * The messages the pit wall sends, and a parser that trusts none of them.
 *
 * The same shapes come from two places: the recorded replay file and the live WebSocket.
 * Both can be wrong (a corrupt file, a different server, someone typing a stranger's address
 * into the page), so every field is checked before it gets near a chart.
 *
 * The Python side documents the shapes in pitwall/pipeline.py.
 */

export interface Sample {
  seq: number; // the link's sequence number
  ts: number; // when the car made it, ms
  rx: number; // when the pit wall delivered it, ms
  id: number; // CAN frame id
  tx: number; // which send got through: 1 is the first, 2 or more were resends
  v: Record<string, number>; // decoded signals, by name
}

export interface LinkStats {
  delivered: number;
  lost: number;
  duplicates: number;
  late: number;
  malformed: number;
  held: number;
  behind: number;
}

export interface SignalInfo {
  unit: string;
  min: number | null;
  max: number | null;
  message: string;
}

export interface Meta {
  source: string;
  seed: number;
  duration_s: number;
  loss: number;
  delay_ms: number;
  jitter_ms: number;
  outages_s: [number, number][];
  buffer: number;
  batch_ms: number;
  frames_per_second: number;
  messages: Record<string, string>;
  signals: Record<string, SignalInfo>;
}

export interface Summary {
  generated: number;
  delivered: number;
  lost: number;
  unresolved: number;
}

export type Message =
  | { type: 'hello'; meta: Meta }
  | { type: 'batch'; rx_ms: number; samples: Sample[]; link: LinkStats }
  | { type: 'end'; rx_ms: number; summary: Summary };

export interface Parsed {
  message: Message | null;
  /** Samples or whole messages thrown away because they were not what they claimed to be. */
  dropped: number;
}

type Obj = Record<string, unknown>;

function isObj(x: unknown): x is Obj {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function num(x: unknown): number | null {
  return typeof x === 'number' && Number.isFinite(x) ? x : null;
}

function nonNeg(x: unknown): number | null {
  const n = num(x);
  return n !== null && n >= 0 ? n : null;
}

// Times are milliseconds since the run began. 1e9 ms is 11 days, far past any run, and keeps
// every later sum and loop on numbers that still count in whole steps.
export const MAX_TIME_MS = 1e9;

function time(x: unknown): number | null {
  const n = nonNeg(x);
  return n !== null && n <= MAX_TIME_MS ? n : null;
}

function parseSample(x: unknown): Sample | null {
  if (!isObj(x)) return null;
  const seq = nonNeg(x.seq);
  const ts = time(x.ts);
  const rx = time(x.rx);
  const id = nonNeg(x.id);
  const tx = nonNeg(x.tx);
  if (seq === null || ts === null || rx === null || id === null || tx === null) return null;
  if (rx < ts) return null; // it cannot arrive before it was made
  if (!isObj(x.v)) return null;
  const v: Record<string, number> = {};
  for (const [name, value] of Object.entries(x.v)) {
    const n = num(value);
    if (n === null) return null;
    v[name] = n;
  }
  return { seq, ts, rx, id, tx, v };
}

function parseLink(x: unknown): LinkStats | null {
  if (!isObj(x)) return null;
  const out: Partial<LinkStats> = {};
  for (const key of ['delivered', 'lost', 'duplicates', 'late', 'malformed', 'held', 'behind'] as const) {
    const n = nonNeg(x[key]);
    if (n === null) return null;
    out[key] = n;
  }
  return out as LinkStats;
}

function parseMeta(x: unknown): Meta | null {
  if (!isObj(x) || !isObj(x.signals) || !isObj(x.messages)) return null;
  const duration = nonNeg(x.duration_s);
  const batchMs = num(x.batch_ms);
  if (duration === null || batchMs === null || batchMs <= 0) return null;
  const signals: Record<string, SignalInfo> = {};
  for (const [name, raw] of Object.entries(x.signals)) {
    if (!isObj(raw)) return null;
    signals[name] = {
      unit: typeof raw.unit === 'string' ? raw.unit : '',
      min: num(raw.min),
      max: num(raw.max),
      message: typeof raw.message === 'string' ? raw.message : '',
    };
  }
  const messages: Record<string, string> = {};
  for (const [id, name] of Object.entries(x.messages)) {
    if (typeof name === 'string') messages[id] = name;
  }
  const outages: [number, number][] = [];
  if (Array.isArray(x.outages_s)) {
    for (const o of x.outages_s) {
      const a = Array.isArray(o) ? num(o[0]) : null;
      const b = Array.isArray(o) ? num(o[1]) : null;
      if (a !== null && b !== null && b > a) outages.push([a, b]);
    }
  }
  return {
    source: typeof x.source === 'string' ? x.source : 'unknown',
    seed: num(x.seed) ?? 0,
    duration_s: duration,
    loss: num(x.loss) ?? 0,
    delay_ms: num(x.delay_ms) ?? 0,
    jitter_ms: num(x.jitter_ms) ?? 0,
    outages_s: outages,
    buffer: num(x.buffer) ?? 0,
    batch_ms: batchMs,
    frames_per_second: num(x.frames_per_second) ?? 0,
    messages,
    signals,
  };
}

function parseSummary(x: unknown): Summary | null {
  if (!isObj(x)) return null;
  const generated = nonNeg(x.generated);
  const delivered = nonNeg(x.delivered);
  const lost = nonNeg(x.lost);
  const unresolved = nonNeg(x.unresolved);
  if (generated === null || delivered === null || lost === null || unresolved === null) return null;
  return { generated, delivered, lost, unresolved };
}

/** Check one decoded JSON value. Never throws. */
export function parseMessage(x: unknown): Parsed {
  if (!isObj(x)) return { message: null, dropped: 1 };
  if (x.type === 'hello') {
    const meta = parseMeta(x.meta);
    return meta ? { message: { type: 'hello', meta }, dropped: 0 } : { message: null, dropped: 1 };
  }
  if (x.type === 'batch') {
    const rx = time(x.rx_ms);
    const link = parseLink(x.link);
    if (rx === null || link === null || !Array.isArray(x.samples)) return { message: null, dropped: 1 };
    const samples: Sample[] = [];
    let dropped = 0;
    for (const raw of x.samples) {
      const s = parseSample(raw);
      if (s) samples.push(s);
      else dropped++;
    }
    return { message: { type: 'batch', rx_ms: rx, samples, link }, dropped };
  }
  if (x.type === 'end') {
    const rx = time(x.rx_ms);
    const summary = parseSummary(x.summary);
    if (rx === null || summary === null) return { message: null, dropped: 1 };
    return { message: { type: 'end', rx_ms: rx, summary }, dropped: 0 };
  }
  return { message: null, dropped: 1 };
}

/** Parse the text of one WebSocket frame. */
export function parseFrame(text: unknown): Parsed {
  if (typeof text !== 'string') return { message: null, dropped: 1 };
  try {
    return parseMessage(JSON.parse(text));
  } catch {
    return { message: null, dropped: 1 };
  }
}

export interface Recording {
  messages: Message[];
  dropped: number;
}

/** Parse a whole replay file. Null if it is not a usable recording at all. */
export function parseRecording(text: string): Recording | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(raw) || raw.length < 2) return null;
  const messages: Message[] = [];
  let dropped = 0;
  for (const item of raw) {
    const p = parseMessage(item);
    dropped += p.dropped;
    if (p.message) messages.push(p.message);
  }
  const first = messages[0];
  if (!first || first.type !== 'hello') return null; // a recording must start with its hello
  if (!messages.some((m) => m.type === 'batch')) return null;
  // Batches must go forward in time, or the player would skip or repeat them.
  let last = -1;
  const ordered = messages.filter((m) => {
    if (m.type === 'hello') return true;
    if (m.rx_ms < last) {
      dropped++;
      return false;
    }
    last = m.rx_ms;
    return true;
  });
  return { messages: ordered, dropped };
}
