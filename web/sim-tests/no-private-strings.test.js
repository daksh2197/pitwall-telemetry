import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// The public sim carries only the drivable part. This keeps the private parts out of it.
const SIM = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'sim');
const BANNED = ['feel', 'debrief', 'pitwall-session', 'session.js'];
const TEXT = new Set(['.html', '.css', '.js', '.json', '.md', '.txt', '.svg']);

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else yield p;
  }
}

test('sim folder has none of the banned strings', () => {
  let scanned = 0;
  const hits = [];
  for (const file of walk(SIM)) {
    // Vendored third-party files are not ours to edit; the check is for our own code and copy.
    if (file.includes(join('public', 'sim', 'vendor'))) continue;
    if (!TEXT.has(extname(file))) continue;
    scanned++;
    const text = (readFileSync(file, 'utf8') + '\n' + file).toLowerCase();
    for (const word of BANNED) if (text.includes(word)) hits.push(`${file}: ${word}`);
  }
  assert.ok(scanned >= 15, 'scanned ' + scanned + ' files');
  assert.deepEqual(hits, []);
});
