// Takes the README screenshots, the demo GIF frames and the link-preview image from the real build.
// Needs: the build served at BASE, Playwright, and (for the GIF) Python with Pillow:  python3 scripts/assemble-gif.py
//   OUT=docs/screenshots FRAMES=/tmp/frames node scripts/media.mjs
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';

const BASE = process.env.BASE ?? 'http://localhost:4173/';
const OUT = process.env.OUT ?? 'docs/screenshots';
const FRAMES = process.env.FRAMES ?? '/tmp/pitwall-frames';
mkdirSync(OUT, { recursive: true });
mkdirSync(FRAMES, { recursive: true });
const browser = await chromium.launch();

async function load(width, height, dpr = 1) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: dpr, reducedMotion: 'reduce' });
  const page = await context.newPage();
  await page.goto(BASE);
  await page.waitForFunction(() => !document.getElementById('play').disabled);
  await page.waitForFunction(() => document.fonts.status === 'loaded');
  return { page, context };
}

async function seek(page, ms) {
  await page.evaluate((v) => {
    const s = document.getElementById('scrub');
    s.value = String(v);
    s.dispatchEvent(new Event('input', { bubbles: true }));
    s.dispatchEvent(new Event('change', { bubbles: true }));
  }, ms);
  await page.waitForTimeout(220);
}

// Full-page screenshots at the moment the backfill is under way
for (const [name, w, h, ms] of [['desktop', 1280, 900, 18_400], ['phone', 390, 844, 18_400]]) {
  const { page, context } = await load(w, h);
  await seek(page, ms);
  console.log(name, await page.textContent('#chip-label'), await page.textContent('#chip-detail'));
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
  await context.close();
}

// GIF frames: the trace card, every 150 ms of the pit wall's clock, from before the outage to after the backfill
{
  const { page, context } = await load(1000, 800);
  const card = page.locator('.trace-card');
  let i = 0;
  for (let ms = 10_500; ms <= 23_000; ms += 150) {
    await seek(page, ms);
    await card.screenshot({ path: `${FRAMES}/f${String(i++).padStart(4, '0')}.png` });
  }
  console.log('frames', i);
  await context.close();
}

// Link-preview image: title plus a fresh crop of the trace
{
  const { page, context } = await load(1000, 800);
  await seek(page, 19_000);
  const png = await page.locator('.trace-card').screenshot();
  await context.close();
  const woff = (f) => readFileSync(new URL(`../web/node_modules/@fontsource-variable/${f}`, import.meta.url)).toString('base64');
  const html = `<!doctype html><meta charset="utf-8"><style>
    @font-face{font-family:B;src:url(data:font/woff2;base64,${woff('bricolage-grotesque/files/bricolage-grotesque-latin-opsz-normal.woff2')});font-weight:200 800}
    @font-face{font-family:G;src:url(data:font/woff2;base64,${woff('geist/files/geist-latin-wght-normal.woff2')});font-weight:100 900}
    body{margin:0;width:1200px;height:630px;background:#111214;color:#ede8dd;font-family:G;position:relative;overflow:hidden}
    h1{position:absolute;left:64px;top:48px;margin:0;font:800 72px/0.95 B;letter-spacing:-0.04em}
    p{position:absolute;left:64px;top:206px;margin:0;font-size:28px;color:#a9a498;width:620px;line-height:1.3}
    img{position:absolute;left:64px;top:318px;width:1072px;border-radius:16px;border:1px solid rgba(237,232,221,.22)}
    .tile{position:absolute;right:64px;top:60px;width:64px;height:64px;border-radius:16px;background:#ff5a1f;color:#120a05;font:800 26px/64px B;text-align:center}
  </style><h1>Pitwall<br>Telemetry</h1><p>CAN frames from a fake car, over a bad radio link, onto a pit-wall screen.</p><div class="tile">DD</div>
  <img src="data:image/png;base64,${png.toString('base64')}">`;
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 630 } });
  const p = await ctx.newPage();
  await p.setContent(html);
  await p.waitForTimeout(300);
  await p.screenshot({ path: 'web/public/og.png' });
  await ctx.close();
}
await browser.close();
