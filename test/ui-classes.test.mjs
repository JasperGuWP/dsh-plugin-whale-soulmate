import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The Token tab shipped with markup that referenced `sm-eng-num` / `sm-eng-h3` / `sm-form-*`
 * while the stylesheet only defined `sm-eng-idx` / `sm-eng-title`. Nothing throws: the card
 * just renders unstyled, so the flaw is only visible by looking at it. That is exactly the
 * class of bug a test should catch instead of a human.
 *
 * Every `sm-*` class used in a browser module must therefore have a rule in styles.mjs.
 */

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const BROWSER = path.join(ROOT, '..', 'browser');

const SKIP_DIRS = new Set(['node_modules', '.git']);

async function walk(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else if (entry.name.endsWith('.mjs') || entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

/** Classes that legitimately have no rule: runtime-toggled modifiers documented below. */
const ALLOW_UNSTYLED = new Set([
  // state flags applied alongside a styled base class; each has a `.x.warn` companion rule
  'warn',
  'ok',
  'blocked',
  'active',
]);

async function collect() {
  const css = await readFile(path.join(BROWSER, 'styles.mjs'), 'utf8');
  const defined = new Set();
  for (const m of css.matchAll(/\.(sm-[a-z0-9-]+)/g)) defined.add(m[1]);

  const used = new Map(); // class -> Set(files)
  for (const file of await walk(BROWSER)) {
    if (path.basename(file) === 'styles.mjs') continue;
    const src = await readFile(file, 'utf8');
    for (const m of src.matchAll(/className:\s*'([^']*)'/g)) add(used, m[1], file);
    for (const m of src.matchAll(/className:\s*"([^"]*)"/g)) add(used, m[1], file);
    // template literals: className: 'a' + (cond ? ' b' : '')
    for (const m of src.matchAll(/\?\s*'([^']+)'\s*:\s*''/g)) add(used, m[1], file);
    for (const m of src.matchAll(/\.sm-[a-z0-9-]+/g)) {
      // classes only referenced from JS lookups (e.g. querySelector) still need a rule
      defined.size && used.set(m[0].slice(1), used.get(m[0].slice(1)) || new Set());
    }
  }
  return { defined, used };
}

function add(used, raw, file) {
  for (const token of String(raw).split(/\s+/)) {
    if (!token || !token.startsWith('sm-')) continue;
    if (!used.has(token)) used.set(token, new Set());
    used.get(token).add(path.basename(file));
  }
}

test('every sm-* class used in the browser has a style rule', async () => {
  const { defined, used } = await collect();
  const missing = [...used.keys()]
    .filter((cls) => !defined.has(cls) && !ALLOW_UNSTYLED.has(cls))
    .sort();

  const detail = missing
    .map((cls) => `  ${cls}  (used in ${[...(used.get(cls) || [])].join(', ')})`)
    .join('\n');
  assert.equal(missing.length, 0, `classes with no CSS rule:\n${detail}`);
});

test('the Token card header uses the shared card-title classes', async () => {
  const src = await readFile(path.join(BROWSER, 'panel-usage.mjs'), 'utf8');
  assert.match(src, /className: 'sm-eng-title'/, 'the card title must use sm-eng-title');
  assert.doesNotMatch(src, /sm-eng-idx.*05|'05'/, 'Token card must not show a decorative 05 index');
  assert.doesNotMatch(src, /sm-eng-num|sm-eng-h3/, 'those classes have no rule and render unstyled');
});