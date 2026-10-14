/**
 * Wires the page together: load a recording (or open a live socket), feed messages into the
 * store, draw the store. The decisions are in src/core; this file only moves things around.
 */

import './styles/fonts.css';
import './styles/brand.css';
import './styles/app.css';

import { fmtClock, fmtDuration } from './core/format';
import { type Message, parseRecording } from './core/messages';
import { Player, SPEEDS } from './core/player';
import { linkStatus } from './core/status';
import { Store } from './core/store';
import { type LiveEvent, connect, parseSocketUrl } from './net/live';
import { buildHistogram, updatePanels } from './ui/panels';
import { type Palette, drawTrace, readPalette } from './ui/trace';

function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`index.html is missing #${id}`);
  return found as T;
}

const params = new URLSearchParams(location.search);
if (params.get('embed') === '1') document.documentElement.dataset.embed = 'true';

const store = new Store();
const canvas = $<HTMLCanvasElement>('trace');
const banner = $('banner');
const announce = $('announce');
let palette: Palette = readPalette(document.documentElement);
let dirty = true;
let parseDropped = 0;
let lastState = '';
let player: Player | null = null;

buildHistogram();

function showBanner(text: string, retry = false): void {
  banner.replaceChildren(document.createTextNode(text));
  if (retry) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn';
    button.textContent = 'Try again';
    button.addEventListener('click', () => location.reload());
    banner.append(' ', button);
  }
  banner.hidden = false;
}

function hideBanner(): void {
  banner.hidden = true;
}

// ---------- controls ----------

const playButton = $<HTMLButtonElement>('play');
const restartButton = $<HTMLButtonElement>('restart');
const speedSelect = $<HTMLSelectElement>('speed');
const jumpButton = $<HTMLButtonElement>('jump');
const scrub = $<HTMLInputElement>('scrub');
const clock = $('clock');
let scrubbing = false;

function setControlsEnabled(on: boolean): void {
  for (const c of [playButton, restartButton, speedSelect, jumpButton, scrub]) c.disabled = !on;
}

function labelPlay(): void {
  if (!player) return;
  const text = player.playing ? 'Pause' : player.done ? 'Play again' : 'Play';
  if (playButton.textContent !== text) playButton.textContent = text;
}

function rebuildTo(ms: number): void {
  if (!player) return;
  const due = player.seek(ms);
  store.reset();
  for (const m of due) store.ingest(m);
  dirty = true;
}

playButton.addEventListener('click', () => {
  if (!player) return;
  if (player.done) rebuildTo(0);
  player.playing = !player.playing;
  labelPlay();
});
restartButton.addEventListener('click', () => {
  if (!player) return;
  rebuildTo(0);
  player.playing = true;
  labelPlay();
});
speedSelect.addEventListener('change', () => player?.setSpeed(Number(speedSelect.value)));
jumpButton.addEventListener('click', () => {
  const outage = store.meta?.outages_s[0];
  if (!player || !outage) return;
  rebuildTo(Math.max(0, outage[0] - 2) * 1000);
  player.playing = true;
  labelPlay();
});
scrub.addEventListener('input', () => {
  scrubbing = true;
  rebuildTo(Number(scrub.value));
  labelPlay();
});
scrub.addEventListener('change', () => {
  scrubbing = false;
});

// ---------- going live or replaying ----------

function startReplay(messages: Message[], dropped: number): void {
  parseDropped += dropped;
  player = new Player(messages);
  const hello = messages[0];
  if (hello?.type === 'hello') store.ingest(hello);
  const wanted = Number(params.get('speed'));
  const speed = (SPEEDS as readonly number[]).includes(wanted) ? wanted : 1;
  player.setSpeed(speed);
  speedSelect.value = String(speed);
  scrub.max = String(player.duration);
  setControlsEnabled(true);
  jumpButton.hidden = !(store.meta && store.meta.outages_s.length > 0);
  $('source-note').textContent =
    'You are watching a replay of a recorded run. The Python pipeline produced every number here. This page only plays the recording back.';
  hideBanner();
  const quiet = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (quiet) {
    // Start paused on a picture that already tells the story: just after the outage.
    const outage = store.meta?.outages_s[0];
    rebuildTo(((outage ? outage[1] : 0) + 6) * 1000);
    player.playing = false;
  } else {
    player.playing = true;
  }
  labelPlay();
}

async function loadReplay(): Promise<void> {
  try {
    const response = await fetch(new URL('replay.json', document.baseURI));
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const recording = parseRecording(await response.text());
    if (!recording) throw new Error('the file is not a recording');
    startReplay(recording.messages, recording.dropped);
  } catch (error) {
    const why = error instanceof Error ? error.message : 'unknown error';
    $('source-note').textContent = 'The recorded run did not load.';
    showBanner(`Could not load the recorded run (${why}).`, true);
  }
}

function startLive(url: URL): void {
  for (const id of ['play', 'restart', 'jump']) $(id).hidden = true;
  $('speed').closest('label')?.setAttribute('hidden', '');
  scrub.closest('label')?.setAttribute('hidden', '');
  clock.hidden = true;
  $('source-note').textContent = `Live from ${url.host}. This page only listens; it sends nothing.`;
  connect(url, (event: LiveEvent) => {
    if (event.kind === 'open') hideBanner();
    else if (event.kind === 'message') {
      store.ingest(event.message);
      parseDropped += event.dropped;
    } else if (event.kind === 'dropped') parseDropped += event.dropped;
    else if (event.kind === 'error' && store.meta === null) {
      showBanner(`Could not connect to ${url.host}. Start the server with: uv run python -m pitwall serve --replay-run`);
    } else if (event.kind === 'closed' && !event.sawEnd && store.meta !== null) {
      showBanner('The connection closed before the run ended.');
    }
    dirty = true;
  });
}

const socketParam = params.get('ws');
if (socketParam !== null) {
  const url = parseSocketUrl(socketParam);
  if (url) startLive(url);
  else {
    $('source-note').textContent = 'The ws address was not usable.';
    showBanner('The ws parameter must be a ws:// or wss:// address, for example ws://127.0.0.1:8765.');
    void loadReplay();
  }
} else {
  void loadReplay();
}

// ---------- the loop ----------

let lastFrame = performance.now();
let lastPanels = 0;
let lastDrawnVersion = -1;

function frame(now: number): void {
  const dt = now - lastFrame;
  lastFrame = now;
  if (player) {
    for (const m of player.tick(dt)) store.ingest(m);
    labelPlay();
  }
  const status = linkStatus({ rxMs: store.rxMs, newest: store.newest, ended: store.ended });
  if (store.version !== lastDrawnVersion || dirty) {
    lastDrawnVersion = store.version;
    dirty = false;
    drawTrace(canvas, { store, state: status.state, palette });
    if (now - lastPanels > 90 || status.state === 'finished') {
      lastPanels = now;
      updatePanels(store, status, parseDropped);
      if (status.state !== lastState) {
        lastState = status.state;
        announce.textContent = `Link ${status.label.toLowerCase()}.`;
      }
      if (player) {
        if (!scrubbing) scrub.value = String(Math.round(player.position));
        const text = `${fmtClock(player.position)} / ${fmtClock(player.duration)}`;
        if (clock.textContent !== text) clock.textContent = text;
      }
      const endNote = $('end-note');
      if (store.ended && store.summary && endNote.hidden) {
        const s = store.summary;
        const m = store.latencyStats();
        endNote.textContent =
          `End of the run. The car made ${s.generated.toLocaleString('en-CA')} frames. ` +
          `${s.delivered.toLocaleString('en-CA')} reached the pit wall and ${s.lost.toLocaleString('en-CA')} were lost. ` +
          `Median latency ${fmtDuration(m.p50)}, 95th percentile ${fmtDuration(m.p95)}.`;
        endNote.hidden = false;
      } else if (!store.ended && !endNote.hidden) {
        endNote.hidden = true;
      }
    }
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

new ResizeObserver(() => {
  dirty = true;
}).observe(canvas);

// Fonts load after first paint; redraw once they are in so the axis labels use them.
void document.fonts?.ready.then(() => {
  palette = readPalette(document.documentElement);
  dirty = true;
});
