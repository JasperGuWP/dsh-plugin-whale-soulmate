// Remote update channels: npm registry + GitHub Releases probes, integrity/size
// verification, cached download, and the three-channel winner logic in self-update.
// All network I/O is injected — no real endpoints in tests.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  probeNpm, probeGithub, probeRemoteChannels, verifyIntegrity, downloadUpdateTgz,
} from '../packages/soulmate-core/runtime/update-channels.mjs';
import { createSelfUpdate } from '../packages/soulmate-core/runtime/self-update.mjs';

const jsonRes = (obj, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => obj });

const NPM_DOC = {
  'dist-tags': { latest: '0.2.201' },
  versions: {
    '0.2.201': { dist: { tarball: 'https://registry.npmjs.org/dsh-plugin-whale-soulmate/-/dsh-plugin-whale-soulmate-0.2.201.tgz', integrity: 'sha512-AAA' } },
  },
};

const GH_LIST = [
  { tag_name: 'v0.2.201', draft: false, assets: [{ name: 'dsh-plugin-whale-soulmate-0.2.201.tgz', size: 24148159, browser_download_url: 'https://github.com/JasperGuWP/dsh-plugin-whale-soulmate/releases/download/v0.2.201/dsh-plugin-whale-soulmate-0.2.201.tgz' }] },
  { tag_name: 'v0.2.199', draft: false, assets: [{ name: 'dsh-plugin-whale-soulmate-0.2.199.tgz', size: 24148112, browser_download_url: 'https://github.com/x/y/releases/download/v0.2.199/dsh-plugin-whale-soulmate-0.2.199.tgz' }] },
  { tag_name: 'v0.3.0', draft: true, assets: [{ name: 'dsh-plugin-whale-soulmate-0.3.0.tgz', size: 1, browser_download_url: 'https://x/draft.tgz' }] },
  { tag_name: 'skinpack-2026', draft: false, assets: [{ name: 'pet-hanfu.zip', size: 5, browser_download_url: 'https://x/skin.zip' }] },
];

test('channels: npm probe reads latest + tarball + integrity', async () => {
  const r = await probeNpm(async () => jsonRes(NPM_DOC));
  assert.equal(r.ok, true);
  assert.equal(r.channel, 'npm');
  assert.equal(r.version, '0.2.201');
  assert.equal(r.integrity, 'sha512-AAA');
  assert.ok(r.url.includes('registry.npmjs.org'));
});

test('channels: github probe picks newest non-draft release with a plugin tgz', async () => {
  const r = await probeGithub(async () => jsonRes(GH_LIST));
  assert.equal(r.ok, true);
  assert.equal(r.version, '0.2.201', 'draft 0.3.0 and skin-only releases are ignored');
  assert.equal(r.bytes, 24148159);
  assert.ok(r.url.startsWith('https://github.com/'));
});

test('channels: one channel failing never sinks the other; errors are surfaced', async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes('registry.npmjs.org')) throw new Error('ECONNREFUSED');
    return jsonRes(GH_LIST);
  };
  const { candidates, errors } = await probeRemoteChannels(fetchImpl);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].channel, 'github');
  assert.match(errors.npm, /ECONNREFUSED/);
});

test('channels: integrity verify matches sha512 base64; empty integrity skips', () => {
  const bytes = Buffer.from('soulmate tarball');
  const good = 'sha512-' + createHash('sha512').update(bytes).digest('base64');
  assert.equal(verifyIntegrity(bytes, good), true);
  assert.equal(verifyIntegrity(bytes, 'sha512-WRONG'), false);
  assert.equal(verifyIntegrity(bytes, ''), true);
});

test('channels: download verifies npm integrity and github size, caches by version', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sm-updch-'));
  const bytes = Buffer.from('fake tgz bytes');
  const integrity = 'sha512-' + createHash('sha512').update(bytes).digest('base64');
  const binRes = { ok: true, status: 200, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
  const okFetch = async () => binRes;

  const p1 = await downloadUpdateTgz(okFetch, { channel: 'npm', version: '0.2.201', url: 'https://registry.npmjs.org/x.tgz', integrity }, dir);
  assert.ok(p1.endsWith('dsh-plugin-whale-soulmate-0.2.201.tgz'));
  assert.deepEqual(await readFile(p1), bytes);

  await assert.rejects(
    downloadUpdateTgz(okFetch, { channel: 'npm', version: '0.2.201', url: 'https://registry.npmjs.org/x.tgz', integrity: 'sha512-WRONG' }, dir),
    /integrity mismatch/,
  );
  await assert.rejects(
    downloadUpdateTgz(okFetch, { channel: 'github', version: '0.2.201', url: 'https://github.com/x.tgz', bytes: 999 }, dir),
    /size mismatch/,
  );
  await assert.rejects(
    downloadUpdateTgz(okFetch, { channel: 'npm', version: '0.2.201', url: 'http://insecure/x.tgz' }, dir),
    /https/,
  );
});

// ---------------------------------------------------------------------------
// self-update with three channels
// ---------------------------------------------------------------------------

function fakeSpawn(exitCode = 0) {
  const calls = [];
  const impl = (exe, args, opts) => {
    const handlers = {};
    const child = { exe, args, opts, once(ev, fn) { handlers[ev] = fn; return child; }, unref() { return child; } };
    calls.push(child);
    queueMicrotask(() => handlers.exit && handlers.exit(exitCode));
    return child;
  };
  return { impl, calls };
}

async function env({ version = '0.2.199' } = {}) {
  const base = await mkdtemp(join(tmpdir(), 'sm-3ch-'));
  const pkgRoot = join(base, 'profile', 'node_modules', 'dsh-plugin-whale-soulmate');
  await mkdir(pkgRoot, { recursive: true });
  await writeFile(join(pkgRoot, 'package.json'), JSON.stringify({ name: 'dsh-plugin-whale-soulmate', version }));
  return { base, pkgRoot };
}

const remoteFetch = (tarBytes) => async (url) => {
  const u = String(url);
  if (u.includes('registry.npmjs.org') && !u.includes('.tgz')) return jsonRes(NPM_DOC);
  if (u.includes('api.github.com')) return jsonRes(GH_LIST);
  if (u.endsWith('.tgz')) return { ok: true, status: 200, arrayBuffer: async () => tarBytes.buffer.slice(tarBytes.byteOffset, tarBytes.byteOffset + tarBytes.byteLength) };
  throw new Error('unexpected url ' + u);
};

test('self-update: highest version across local/npm/github wins; channels reported', async () => {
  const { base, pkgRoot } = await env();
  const src = join(base, 'source');
  await mkdir(src, { recursive: true });
  await writeFile(join(src, 'dsh-plugin-whale-soulmate-0.2.200.tgz'), 'x');
  const conf = { update: { enabled: true, sourceDir: src, checkNpm: true, checkGithub: true } };
  const su = createSelfUpdate({
    getConfig: async () => conf, packageRoot: pkgRoot, warn: () => {},
    fetchImpl: remoteFetch(Buffer.from('x')),
  });
  await su.begin();
  const st = su.status();
  assert.equal(st.latest, '0.2.201');
  assert.equal(st.available, true);
  assert.equal(st.channels.local, '0.2.200');
  assert.equal(st.channels.npm, '0.2.201');
  assert.equal(st.channels.github, '0.2.201');
  assert.ok(['npm', 'github'].includes(st.channel));
  su.dispose();
});

test('self-update: remote install downloads, verifies, then pnpm add the cached tgz', async () => {
  const { base, pkgRoot } = await env();
  const tarBytes = Buffer.from('remote tarball');
  const integrity = 'sha512-' + createHash('sha512').update(tarBytes).digest('base64');
  const doc = { 'dist-tags': { latest: '0.2.201' }, versions: { '0.2.201': { dist: { tarball: 'https://registry.npmjs.org/dsh-plugin-whale-soulmate/-/dsh-plugin-whale-soulmate-0.2.201.tgz', integrity } } } };
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.includes('registry.npmjs.org') && !u.includes('.tgz')) return jsonRes(doc);
    if (u.includes('api.github.com')) return jsonRes([]);
    return { ok: true, status: 200, arrayBuffer: async () => tarBytes.buffer.slice(tarBytes.byteOffset, tarBytes.byteOffset + tarBytes.byteLength) };
  };
  const { impl, calls } = fakeSpawn(0);
  const conf = { update: { enabled: true, sourceDir: '', checkNpm: true, checkGithub: true } };
  const su = createSelfUpdate({
    getConfig: async () => conf, packageRoot: pkgRoot, warn: () => {},
    spawnImpl: impl, bins: { node: process.execPath, pnpm: join(pkgRoot, 'package.json') },
    fetchImpl, cacheDir: join(base, 'cache'),
  });
  await su.begin();
  assert.equal(su.status().channel, 'npm');
  const r = await su.install();
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.channel, 'npm');
  assert.equal(calls.length, 1);
  const added = calls[0].args.find((a) => String(a).endsWith('.tgz'));
  assert.ok(added.includes('cache'), 'pnpm add must use the downloaded cache file');
  assert.deepEqual(await readFile(added), tarBytes);
  su.dispose();
});

test('self-update: integrity mismatch is an honest error, no pnpm spawn', async () => {
  const { base, pkgRoot } = await env();
  const { impl, calls } = fakeSpawn(0);
  const conf = { update: { enabled: true, sourceDir: '', checkNpm: true, checkGithub: false } };
  const su = createSelfUpdate({
    getConfig: async () => conf, packageRoot: pkgRoot, warn: () => {},
    spawnImpl: impl, bins: { node: process.execPath, pnpm: join(pkgRoot, 'package.json') },
    fetchImpl: remoteFetch(Buffer.from('tampered')), cacheDir: join(base, 'cache'),
  });
  await su.begin();
  const r = await su.install();
  assert.equal(r.ok, false);
  assert.match(r.error, /integrity|校验|下载/);
  assert.equal(calls.length, 0);
  assert.equal(su.status().phase, 'error');
  su.dispose();
});

test('self-update: all remote channels down + no local source → honest not-available with errors', async () => {
  const { pkgRoot } = await env();
  const conf = { update: { enabled: true, sourceDir: '', checkNpm: true, checkGithub: true } };
  const su = createSelfUpdate({
    getConfig: async () => conf, packageRoot: pkgRoot, warn: () => {},
    fetchImpl: async () => { throw new Error('offline'); },
  });
  await su.begin();
  const st = su.status();
  assert.equal(st.available, false);
  assert.match(st.channelErrors.npm, /offline/);
  assert.match(st.channelErrors.github, /offline/);
  su.dispose();
});