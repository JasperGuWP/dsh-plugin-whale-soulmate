import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { assetRoutes } from '../packages/soulmate-core/routes/asset-routes.mjs';

const body = (out) => JSON.parse(out.body);

function tarHeader(name, size, type = '0') {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write('0000644\0', 100, 8, 'ascii');
  header.write('0000000\0', 108, 8, 'ascii');
  header.write('0000000\0', 116, 8, 'ascii');
  header.write(size.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
  header.write('00000000000\0', 136, 12, 'ascii');
  header.write(type, 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return header;
}

function tarGz(entries) {
  const chunks = [];
  for (const entry of entries) {
    const data = Buffer.from(entry.data || '');
    chunks.push(tarHeader(entry.name, data.length, entry.type));
    if (data.length) {
      chunks.push(data, Buffer.alloc((512 - (data.length % 512)) % 512));
    }
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks), { level: 9 });
}

function archiveFor(id = 'testskin', label = '测试皮肤') {
  return tarGz([
    { name: 'pet-' + id + '/pet.json', data: JSON.stringify({ displayName: label, states: { idle: { frames: ['pet-idle-01'] } } }) },
    { name: 'pet-' + id + '/pet-idle-01.png', data: Buffer.from('not-a-real-png') },
  ]);
}

function responseFor(archive) {
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => name.toLowerCase() === 'content-length' ? String(archive.length) : null },
    arrayBuffer: async () => archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength),
  };
}

test('pet skins: optional catalog is downloadable until installed, then becomes local', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sm-skin-download-'));
  try {
    const archive = archiveFor();
    let fetches = 0;
    let fetchedUrl = '';
    const spec = {
      label: '测试可选皮肤',
      filename: 'pet-testskin.tar.gz',
      bytes: archive.length,
      sha256: createHash('sha256').update(archive).digest('hex'),
    };
    const routes = assetRoutes({
      home: { rootDir: root },
      skins: {},
      downloads: { testskin: spec },
      skinsRoot: join(root, 'assets'),
      fetchImpl: async (url) => { fetches += 1; fetchedUrl = url; return responseFor(archive); },
    });
    const catalog = async () => body(await routes.find((r) => r.method === 'GET' && r.paths.includes('/dsh-soulmate/api/pet/skins')).handler({}));
    const install = routes.find((r) => r.method === 'POST' && r.paths.includes('/dsh-soulmate/api/pet/skins/install')).handler;

    const before = await catalog();
    assert.deepEqual(before.skins.find((s) => s.id === 'testskin'), {
      id: 'testskin',
      label: '测试可选皮肤',
      preview: '/dsh-soulmate/api/pet/frame?id=pet-idle-01&skin=testskin',
      installed: false,
      downloadable: true,
    });

    const installed = body(await install({ body: { id: 'testskin' } }));
    assert.equal(installed.ok, true);
    assert.equal(installed.installed, true);
    assert.equal(fetches, 1);
    assert.equal(fetchedUrl, 'https://github.com/JasperGuWP/dsh-plugin-whale-soulmate/releases/download/pet-packs-v2/pet-testskin.tar.gz');
    assert.equal(JSON.parse(await readFile(join(root, 'cache', 'pet-skins', 'pet-testskin', 'pet.json'), 'utf8')).displayName, '测试皮肤');

    const after = await catalog();
    assert.equal(after.skins.find((s) => s.id === 'testskin').installed, true);
    const manifest = routes.find((r) => r.method === 'GET' && r.paths.includes('/dsh-soulmate/api/pet/manifest'))
    const m = body(await manifest.handler({ query: new URLSearchParams('skin=testskin') }));
    assert.equal(m.ok, true);
    assert.equal(m.displayName, '测试皮肤');

    const again = body(await install({ body: { id: 'testskin' } }));
    assert.equal(again.ok, true);
    assert.equal(fetches, 1, 'already installed packs do not re-download');

    // A cache from an older release has no verified .pack.json marker. It must
    // be treated as stale and replaced using the current release digest.
    await rm(join(root, 'cache', 'pet-skins', 'pet-testskin', '.pack.json'));
    const stale = await catalog();
    assert.equal(stale.skins.find((s) => s.id === 'testskin').installed, false);
    const repaired = body(await install({ body: { id: 'testskin' } }));
    assert.equal(repaired.ok, true);
    assert.equal(fetches, 2, 'stale cache is replaced once');
    assert.equal((await catalog()).skins.find((s) => s.id === 'testskin').installed, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('pet skins: checksum, size and traversal checks reject a downloaded pack', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sm-skin-reject-'));
  try {
    const archive = archiveFor();
    const base = {
      label: '测试皮肤',
      filename: 'pet-testskin.tar.gz',
      bytes: archive.length,
      sha256: '0'.repeat(64),
      url: 'https://example.test/pet-testskin.tar.gz',
    };
    const routes = assetRoutes({
      home: { rootDir: root },
      skins: {},
      downloads: { testskin: base },
      skinsRoot: join(root, 'assets'),
      fetchImpl: async () => responseFor(archive),
    });
    const install = routes.find((r) => r.method === 'POST' && r.paths.includes('/dsh-soulmate/api/pet/skins/install')).handler;
    const badSha = body(await install({ body: { id: 'testskin' } }));
    assert.equal(badSha.ok, false);
    assert.match(badSha.error, /SHA-256/);

    const wrongSizeRoutes = assetRoutes({
      home: { rootDir: root },
      skins: {},
      downloads: { testskin: { ...base, sha256: createHash('sha256').update(archive).digest('hex'), bytes: archive.length + 1 } },
      skinsRoot: join(root, 'assets'),
      fetchImpl: async () => responseFor(archive),
    });
    const wrongSizeInstall = wrongSizeRoutes.find((r) => r.method === 'POST' && r.paths.includes('/dsh-soulmate/api/pet/skins/install')).handler;
    const badSize = body(await wrongSizeInstall({ body: { id: 'testskin' } }));
    assert.equal(badSize.ok, false);
    assert.match(badSize.error, /大小/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  const root2 = await mkdtemp(join(tmpdir(), 'sm-skin-traversal-'));
  try {
    const traversal = tarGz([
      { name: '../evil.txt', data: 'nope' },
      { name: 'pet-testskin/pet.json', data: '{}' },
    ]);
    const spec = {
      label: '测试皮肤',
      filename: 'pet-testskin.tar.gz',
      bytes: traversal.length,
      sha256: createHash('sha256').update(traversal).digest('hex'),
      url: 'https://example.test/pet-testskin.tar.gz',
    };
    const routes = assetRoutes({
      home: { rootDir: root2 },
      skins: {},
      downloads: { testskin: spec },
      skinsRoot: join(root2, 'assets'),
      fetchImpl: async () => responseFor(traversal),
    });
    const install = routes.find((r) => r.method === 'POST' && r.paths.includes('/dsh-soulmate/api/pet/skins/install')).handler;
    const out = body(await install({ body: { id: 'testskin' } }));
    assert.equal(out.ok, false);
    assert.match(out.error, /路径/);
  } finally {
    await rm(root2, { recursive: true, force: true });
  }
});

test('pet skins: client contains the first-download interaction', async () => {
  const src = await readFile(new URL('../client.js', import.meta.url), 'utf8');
  for (const needle of ['pet/skins/install', '首次使用，正在从 GitHub Release 下载皮肤包', '首次下载', '从 GitHub Releases 下载并缓存']) {
    assert.ok(src.includes(needle), `client.js should contain ${needle}`);
  }
});
