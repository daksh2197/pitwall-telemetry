// A browser walkthrough of the built dashboard with named pass/fail checks.
//
//   cd web && npm ci && npm run build && npx vite preview --port 4173 --strictPort &
//   uv run python -m pitwall serve --replay-run --speed 8 --port 8799 &
//   npm i --no-save playwright && npx playwright install chromium     (once, outside this repo's lockfile)
//   node scripts/walkthrough.mjs
//
// Environment: BASE (default http://localhost:4173/), LIVE_WS (default ws://127.0.0.1:8799, skipped if unreachable),
// PLAYWRIGHT_MODULE (path to playwright's index.mjs if it is not installed normally).
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');

const BASE = process.env.BASE ?? 'http://localhost:4173/';
const LIVE_WS = process.env.LIVE_WS ?? 'ws://127.0.0.1:8799';
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

const browser = await chromium.launch();
const BAD_TEXT = /NaN|Infinity|undefined|\bnull\b|(^|\s)-0(\s|$)/;

async function open(url, { width = 1280, height = 900, reducedMotion = 'no-preference', routes } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion });
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));
  if (routes) await routes(page);
  await page.goto(url);
  return { page, errors, context };
}

const chip = (page) => page.textContent('#chip-label');
const ready = (page) => page.waitForFunction(() => !document.getElementById('play').disabled, null, { timeout: 15000 });

// 1. First load
{
  const { page, errors, context } = await open(`${BASE}?speed=8`);
  await ready(page);
  check('the recording loads and the controls turn on', true);
  await page.waitForFunction(() => document.getElementById('c-delivered').textContent !== '0');
  check('the source note says it is a replay of a recorded run', /replay of a recorded run/.test(await page.textContent('#source-note')));
  check('the canvas has a real size', (await page.evaluate(() => document.getElementById('trace').width)) > 300);
  await page.waitForFunction(() => document.getElementById('end-note') && !document.getElementById('end-note').hidden, null, { timeout: 30000 });
  const end = await page.textContent('#end-note');
  check('the run ends with a summary that adds up', /8,800 frames/.test(end) && /8,800 reached the pit wall and 0 were lost/.test(end), end);
  check('the play button offers to play again', (await page.textContent('#play')) === 'Play again');
  check('no console errors on a full run', errors.length === 0, errors.join(' | '));
  const body = await page.innerText('body');
  check('no NaN, Infinity, undefined or -0 anywhere on the page at the end', !BAD_TEXT.test(body), body.match(BAD_TEXT)?.[0]);
  await page.click('#play');
  await page.waitForFunction(() => document.getElementById('end-note').hidden);
  check('play again starts over and hides the end note', true);
  await context.close();
}

// 2. The story: live, no data, catching up, live
{
  const { page, context } = await open(`${BASE}?speed=4`);
  await ready(page);
  await page.evaluate(() => {
    window.__states = [];
    new MutationObserver(() => {
      const s = document.getElementById('chip').dataset.state;
      if (window.__states.at(-1) !== s) window.__states.push(s);
    }).observe(document.getElementById('chip'), { attributes: true });
  });
  await page.click('#jump');
  await page.waitForFunction(() => window.__states.includes('catching-up') && window.__states.at(-1) === 'live', null, { timeout: 30000 });
  const states = await page.evaluate(() => window.__states);
  const order = states.filter((s) => ['live', 'no-data', 'catching-up'].includes(s));
  const expected = ['no-data', 'catching-up', 'live'];
  const tail = order.slice(-3);
  check('around the outage the link goes no data, catching up, live in that order', JSON.stringify(tail) === JSON.stringify(expected), order.join(' > '));
  check('the late count grew during backfill', Number((await page.textContent('#c-late')).replace(/,/g, '')) > 500);
  await context.close();
}

// 3. Scrub, pause, restart, speed
{
  const { page, context } = await open(`${BASE}`);
  await ready(page);
  await page.click('#play'); // pause
  check('pause works', (await page.textContent('#play')) === 'Play');
  await page.evaluate(() => {
    const s = document.getElementById('scrub');
    s.value = '30000';
    s.dispatchEvent(new Event('input', { bubbles: true }));
    s.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForFunction(() => /^0:30/.test(document.getElementById('clock').textContent));
  const p95 = await page.textContent('#lat-sum');
  check('scrubbing to 0:30 rebuilds the numbers from the recording', /p95 [\d.,]+ (ms|s)/.test(p95) && /frames/.test(p95), p95);
  await page.selectOption('#speed', '2');
  await page.click('#restart');
  await page.waitForTimeout(400);
  check('restart goes back to the beginning and plays', /^0:0/.test(await page.textContent('#clock')) && (await page.textContent('#play')) === 'Pause');
  await context.close();
}

// 4. Layout at every width
for (const width of [320, 390, 768, 1280, 1440]) {
  const { page, context } = await open(`${BASE}`, { width, height: 900 });
  await ready(page);
  await page.click('#jump');
  await page.waitForTimeout(3600);
  const m = await page.evaluate(() => {
    const doc = document.documentElement;
    const tooWide = [...document.querySelectorAll('body *')].filter((e) => {
      if (e.closest('.skip, .vh')) return false; // parked off screen on purpose
      const r = e.getBoundingClientRect();
      return r.width > 0 && (r.right > doc.clientWidth + 1 || r.left < -1);
    }).map((e) => e.id || e.className || e.tagName);
    return { scrollW: doc.scrollWidth, clientW: doc.clientWidth, tooWide: tooWide.slice(0, 5), canvasH: document.getElementById('trace').clientHeight };
  });
  check(`no horizontal scroll at ${width}px`, m.scrollW <= m.clientW, `scroll ${m.scrollW} client ${m.clientW}`);
  check(`nothing pokes outside the screen at ${width}px`, m.tooWide.length === 0, m.tooWide.join(','));
  check(`the trace is tall enough at ${width}px`, m.canvasH >= 240, String(m.canvasH));
  await page.screenshot({ path: process.env.SHOTS ? `${process.env.SHOTS}/w${width}.png` : undefined, fullPage: true }).catch(() => {});
  await context.close();
}

// 5. Embed mode and reduced motion
{
  const { page, context } = await open(`${BASE}?embed=1`);
  await ready(page);
  const hidden = await page.evaluate(() => [...document.querySelectorAll('[data-chrome]')].every((e) => getComputedStyle(e).display === 'none'));
  check('embed=1 hides the page chrome and keeps the dashboard', hidden && (await page.isVisible('#trace')));
  await context.close();
}
{
  const { page, context } = await open(`${BASE}`, { reducedMotion: 'reduce' });
  await ready(page);
  await page.waitForTimeout(500);
  check('with reduced motion it starts paused on the aftermath of the outage', (await page.textContent('#play')) === 'Play' && /^0:2[2-4]/.test(await page.textContent('#clock')), await page.textContent('#clock'));
  await context.close();
}

// 6. Hostile input
{
  const bad = ['?ws=http://example.com', '?ws=javascript:alert(1)', '?ws=', '?ws=%00%00', '?speed=abc', '?speed=-4', '?embed=%3Cscript%3E', '#%3Cimg%20src=x%20onerror=alert(1)%3E'];
  for (const q of bad) {
    const { page, errors, context } = await open(`${BASE}${q}`);
    await page.waitForTimeout(1200);
    const body = await page.innerText('body');
    check(`odd address ${q} does not break the page`, errors.length === 0 && !BAD_TEXT.test(body) && (await page.isVisible('#trace')), errors.join('|'));
    await context.close();
  }
  const { page, context } = await open(`${BASE}?ws=ws://127.0.0.1:1`);
  await page.waitForFunction(() => !document.getElementById('banner').hidden, null, { timeout: 8000 });
  check('a socket that refuses shows how to start the server', /Could not connect/.test(await page.textContent('#banner')));
  await context.close();
}
for (const [name, body, status] of [
  ['a missing recording', 'nope', 404],
  ['a recording that is not JSON', 'this is not json', 200],
  ['a recording that is an empty list', '[]', 200],
  ['a recording that is the wrong shape', '{"hello":1}', 200],
]) {
  const { page, context } = await open(`${BASE}`, { routes: (p) => p.route('**/replay.json', (r) => r.fulfill({ status, body })) });
  await page.waitForFunction(() => !document.getElementById('banner').hidden, null, { timeout: 8000 });
  const text = await page.textContent('#banner');
  check(`${name} shows a clear error with a retry button`, /Could not load/.test(text) && /Try again/.test(text), text);
  check(`${name} leaves the controls off`, await page.isDisabled('#play'));
  await context.close();
}
{
  // A real recording with junk added: bad samples and a bad message. The page should carry on and say how many it ignored.
  const { page, errors, context } = await open(`${BASE}?speed=8`, {
    routes: (p) => p.route('**/replay.json', async (route) => {
      const response = await route.fetch();
      const data = JSON.parse(await response.text());
      data[5].samples.push({ seq: 'x' }, null, { seq: 1, ts: 5, rx: 1, id: 1, tx: 1, v: {} });
      data.splice(6, 0, { type: 'nonsense' }, 42);
      await route.fulfill({ response, body: JSON.stringify(data) });
    }),
  });
  await ready(page);
  await page.waitForFunction(() => !document.getElementById('end-note').hidden, null, { timeout: 30000 });
  const ignored = Number((await page.textContent('#c-ignored')).replace(/,/g, ''));
  check('junk inside a recording is dropped and counted, and the run still completes', ignored === 5 && errors.length === 0, `ignored ${ignored}`);
  await context.close();
}

// 7. Accessibility basics
{
  const { page, context } = await open(`${BASE}`);
  await ready(page);
  const unnamed = await page.evaluate(() =>
    [...document.querySelectorAll('button, input, select, canvas, a')].filter((e) => {
      const name = e.getAttribute('aria-label') || e.labels?.[0]?.textContent || e.textContent;
      return !name || !name.trim();
    }).map((e) => e.outerHTML.slice(0, 60)));
  check('every control, link and the canvas has an accessible name', unnamed.length === 0, unnamed.join(' | '));
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  const focused = await page.evaluate(() => {
    const e = document.activeElement;
    const s = getComputedStyle(e);
    return { tag: e.tagName, outline: s.outlineStyle, width: s.outlineWidth };
  });
  check('keyboard focus is visible', focused.outline !== 'none' && focused.width !== '0px', JSON.stringify(focused));
  const live = await page.evaluate(() => [...document.querySelectorAll('[aria-live], [role=status], [role=alert]')].map((e) => e.id));
  check('there is one polite live region for link changes, and the banner is an alert', live.includes('announce') && live.includes('banner'), live.join(','));
  const changes = await page.evaluate(async () => {
    const node = document.getElementById('announce');
    let n = 0;
    new MutationObserver(() => n++).observe(node, { childList: true, characterData: true, subtree: true });
    await new Promise((r) => setTimeout(r, 3000));
    return n;
  });
  check('the live region does not chatter while the state is steady', changes <= 1, `${changes} changes in 3 s`);
  await context.close();
}

// 8. Live mode against the real Python server
{
  let reachable = true;
  try {
    const probe = await fetch(LIVE_WS.replace(/^ws/, 'http'));
    void probe;
  } catch (e) {
    reachable = !/ECONNREFUSED|fetch failed/.test(String(e?.cause ?? e));
  }
  if (!reachable) {
    console.log(`SKIP  live mode: nothing is listening at ${LIVE_WS}`);
  } else {
    const { page, errors, context } = await open(`${BASE}?ws=${encodeURIComponent(LIVE_WS)}`);
    await page.waitForFunction(() => document.getElementById('c-delivered').textContent !== '0', null, { timeout: 15000 });
    check('live mode: frames arrive over the WebSocket', true);
    check('live mode: the controls for replay are hidden', !(await page.isVisible('#play')) && !(await page.isVisible('#scrub')));
    check('live mode: the note says live and that the page only listens', /Live from 127\.0\.0\.1:8799.*only listens/.test(await page.textContent('#source-note')));
    await page.waitForFunction(() => !document.getElementById('end-note').hidden, null, { timeout: 40000 });
    check('live mode: the run ends and the summary adds up', /8,800 reached the pit wall and 0 were lost/.test(await page.textContent('#end-note')));
    check('live mode: no console errors', errors.length === 0, errors.join('|'));
    await context.close();
  }
}

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} of ${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
