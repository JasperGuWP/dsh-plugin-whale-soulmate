import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { bundleSource } from '../browser/build.mjs';

const root = new URL('../', import.meta.url);
const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));

test('bundle identity: the client bundle registers under the package name', async () => {
  // Regression: build.mjs used to hardcode the bundle id. After the package was renamed
  // the id stayed on the old name, so DSH registered a factory under one name while the
  // package mounted as another, and the web boot died with
  //   "duplicate factory registration for \"dsh-plugins-soulmate\""
  // The id is the plugin's identity to the host loader, so it must track package.json.
  const source = await bundleSource();
  // Accept either quote style: the id must equal the package name, the quoting is cosmetic.
  const idLine = /id:\s*(['"])([^'"]+)\1/.exec(source);
  assert.ok(idLine, 'the bundle must declare a loader id');
  assert.equal(idLine[2], pkg.name, `client bundle must register as "${pkg.name}"`);
  // Only the *loader id* must track the package name. `KIND` (the tool-card type) and
  // `CSS_KEY` (the stylesheet dedupe key) are two-sided internal contracts — node and
  // browser must agree on them — so they are deliberately left on the original value.
  assert.ok(
    !/id:\s*(['"])dsh-plugins-soulmate\1/.test(source),
    'the pre-rename loader id must not survive in the generated bundle',
  );
});

test('bundle identity: client.js is a build artifact, built on demand', async () => {
  // client.js is generated from browser/ and is NOT tracked by git, so a clean checkout
  // has no client.js at all until `pretest` / `prepack` builds it. Testing "the committed
  // file is not stale" only worked while the artifact was checked in — and checking it in
  // is what let a bundle built from uncommitted sources get committed. So assert the build
  // produces a file that parses and carries the current identity instead.
  const built = await bundleSource();
  const onDisk = await readFile(new URL('client.js', root), 'utf8');
  assert.equal(onDisk.trimEnd(), built.trimEnd(), 'client.js on disk must match a fresh build');
  // It must at least parse as a script, or the host would die loading it.
  assert.doesNotThrow(() => new vm.Script(built, { filename: 'client.js' }));
});

test('bundle identity: the bundle patch mounts soulmate plus the shipped QQ bot', async () => {
  const patch = await readFile(new URL('cordis.patch.yml', root), 'utf8');
  const names = [...patch.matchAll(/^\s+name:\s*['"]?([^'"\s]+)['"]?\s*$/gm)].map((m) => m[1]);
  assert.deepEqual(
    names,
    [pkg.name, `${pkg.name}/qqbot-server`],
    'the bundle patch must mount soulmate and the QQ bot through its server-only subpath',
  );
  // Installing soulmate alone must pull the official package transitively.
  assert.ok(
    pkg.dependencies && pkg.dependencies['@tencent-connect/dsh-qqbot'],
    'package.json must depend on @tencent-connect/dsh-qqbot',
  );
  // The subpath must be exported, or the loader cannot resolve the patch row.
  assert.equal(
    pkg.exports && pkg.exports['./qqbot-server'],
    './packages/soulmate-core/qqbot-server.mjs',
    'package.json must export ./qqbot-server',
  );
});

test('bundle identity: the QQ server wrapper delegates to the official node half', async () => {
  // Mounting the official package root also pulls its browser surface, which
  // registers a second standalone 「QQ 机器人」 sidebar. The subpath installs
  // only a small model-sync hook, then delegates every QQ feature to upstream.
  const source = await readFile(new URL('packages/soulmate-core/qqbot-server.mjs', root), 'utf8');
  const code = source.replace(/\/\/[^\n]*/g, '').trim();
  assert.match(code, /import \{ apply as applyOfficial \} from '@tencent-connect\/dsh-qqbot'/);
  assert.match(code, /export \{ name, inject, Config \} from '@tencent-connect\/dsh-qqbot'/);
  assert.match(code, /installQqModelSync\(ctx\)/);
  assert.match(code, /await applyOfficial\(ctx, config\)/);
  assert.doesNotMatch(code, /dsh-qqbot\/client/);
});

test('bundle identity: the node half reports the same name', async () => {
  const { name } = await import('../packages/soulmate-core/index.mjs');
  assert.equal(name, pkg.name);
});
