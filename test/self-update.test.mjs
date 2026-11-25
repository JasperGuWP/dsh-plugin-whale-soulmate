import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSelfUpdate, cmpVer } from '../packages/soulmate-core/runtime/self-update.mjs';

/**
 * 自更新:版本比较 / 源目录扫描 / profile 守卫 / 一键 pnpm add / 桌面端自重启。
 */

function fakeSpawn(exitCode = 0) {
  const calls = [];
  const impl = (exe, args, opts) => {
    const handlers = {};
    const child = {
      exe, args, opts,
      once(ev, fn) { handlers[ev] = fn; return child; },
      unref() { child.unrefed = true; return child; },
    };
    calls.push(child);
    queueMicrotask(() => handlers.exit && handlers.exit(exitCode));
    return child;
  };
  return { impl, calls };
}

async function env({ version = '0.2.119', inProfile = true, source = true, cfg = {} } = {}) {
  const base = await mkdtemp(join(tmpdir(), 'sm-selfupd-'));
  const pkgRoot = inProfile
    ? join(base, 'profile', 'node_modules', 'dsh-plugin-whale-soulmate')
    : join(base, 'repo');
  await mkdir(pkgRoot, { recursive: true });
  await writeFile(join(pkgRoot, 'package.json'), JSON.stringify({ name: 'dsh-plugin-whale-soulmate', version }));
  const src = join(base, 'source');
  await mkdir(src, { recursive: true });
  if (source) {
    await writeFile(join(src, 'dsh-plugin-whale-soulmate-0.2.119.tgz'), 'x');
    await writeFile(join(src, 'dsh-plugin-whale-soulmate-0.2.120.tgz'), 'x');
    await writeFile(join(src, 'unrelated-1.0.0.tgz'), 'x');
  }
  const conf = { update: { enabled: true, sourceDir: src, intervalSec: 3600, checkNpm: false, checkGithub: false }, ...cfg };
  return { base, pkgRoot, src, conf };
}

const tick = () => new Promise((r) => setTimeout(r, 30));

test('self-update: cmpVer orders semver numerically', () => {
  assert.equal(cmpVer('0.2.120', '0.2.119'), 1);
  assert.equal(cmpVer('0.2.9', '0.2.10'), -1);
  assert.equal(cmpVer('1.0.0', '1.0.0'), 0);
});

test('self-update: poll finds the newest matching tarball above installed version', async () => {
  const { pkgRoot, src, conf } = await env();
  const su = createSelfUpdate({ getConfig: async () => conf, packageRoot: pkgRoot, warn: () => {} });
  await su.begin();
  await tick();
  const st = su.status();
  assert.equal(st.current, '0.2.119');
  assert.equal(st.latest, '0.2.120');
  assert.equal(st.available, true);
  assert.ok(st.tgz.endsWith('dsh-plugin-whale-soulmate-0.2.120.tgz'));
  su.dispose();
});

test('self-update: up-to-date or empty source or disabled → not available', async () => {
  const a = await env({ version: '0.2.120' });
  const suA = createSelfUpdate({ getConfig: async () => a.conf, packageRoot: a.pkgRoot, warn: () => {} });
  await suA.begin(); await tick();
  assert.equal(suA.status().available, false);
  suA.dispose();
  const b = await env({ source: false });
  const suB = createSelfUpdate({ getConfig: async () => b.conf, packageRoot: b.pkgRoot, warn: () => {} });
  await suB.begin(); await tick();
  assert.equal(suB.status().available, false);
  suB.dispose();
  const c = await env();
  c.conf.update.enabled = false;
  const suC = createSelfUpdate({ getConfig: async () => c.conf, packageRoot: c.pkgRoot, warn: () => {} });
  await suC.begin(); await tick();
  assert.equal(suC.status().available, false);
  suC.dispose();
});

test('self-update: dev copy (no node_modules in path) never self-installs', async () => {
  const { pkgRoot, conf } = await env({ inProfile: false });
  const { impl, calls } = fakeSpawn();
  const su = createSelfUpdate({ getConfig: async () => conf, packageRoot: pkgRoot, warn: () => {}, spawnImpl: impl, bins: { node: process.execPath, pnpm: join(pkgRoot, 'package.json') } });
  await su.begin(); await tick();
  assert.equal(su.status().available, false);
  assert.equal(su.status().inProfile, false);
  const r = await su.install();
  assert.equal(r.ok, false);
  assert.equal(calls.length, 0);
  su.dispose();
});

test('self-update: install runs pnpm add in the profile dir and flips to installed', async () => {
  const { pkgRoot, conf } = await env();
  const { impl, calls } = fakeSpawn(0);
  const su = createSelfUpdate({ getConfig: async () => conf, packageRoot: pkgRoot, warn: () => {}, spawnImpl: impl, bins: { node: process.execPath, pnpm: join(pkgRoot, 'package.json') } });
  await su.begin(); await tick();
  const r = await su.install();
  assert.equal(r.ok, true);
  assert.equal(r.needRestart, true);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].args.includes('add'));
  assert.ok(calls[0].args.some((a) => a.endsWith('dsh-plugin-whale-soulmate-0.2.120.tgz')));
  assert.equal(calls[0].opts.cwd, join(pkgRoot, '..', '..'));
  const st = su.status();
  assert.equal(st.phase, 'installed');
  assert.equal(st.current, '0.2.120');
  assert.equal(st.available, false);
  su.dispose();
});

test('self-update: pnpm failure surfaces error phase and retry is possible', async () => {
  const { pkgRoot, conf } = await env();
  const { impl } = fakeSpawn(1);
  const su = createSelfUpdate({ getConfig: async () => conf, packageRoot: pkgRoot, warn: () => {}, spawnImpl: impl, bins: { node: process.execPath, pnpm: join(pkgRoot, 'package.json') } });
  await su.begin(); await tick();
  const r = await su.install();
  assert.equal(r.ok, false);
  assert.equal(su.status().phase, 'error');
  assert.ok(su.status().error.includes('exited 1'));
  su.dispose();
});

test('self-update: restart only self-restarts the desktop exe host', async () => {
  if (process.platform !== 'win32') {
    console.log(`skip: self-update restart requires win32 (got ${process.platform})`);
    return;
  }
  const { pkgRoot, conf } = await env();
  const { impl, calls } = fakeSpawn();
  const su = createSelfUpdate({
    getConfig: async () => conf, packageRoot: pkgRoot, warn: () => {}, spawnImpl: impl,
    execPath: 'C:/self/dsh/DeepSeek Harness.exe',
  });
  const r = await su.restart();
  assert.equal(r.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].exe, 'powershell');
  assert.equal(calls[0].opts.detached, true);
  assert.ok(calls[0].args[2].includes('Stop-Process'));
  assert.ok(calls[0].args[2].includes('Start-Process'));
  su.dispose();
  const su2 = createSelfUpdate({
    getConfig: async () => conf, packageRoot: pkgRoot, warn: () => {}, spawnImpl: impl,
    execPath: 'C:/Program Files/nodejs/node.exe',
  });
  assert.equal((await su2.restart()).ok, false);
  su2.dispose();
});