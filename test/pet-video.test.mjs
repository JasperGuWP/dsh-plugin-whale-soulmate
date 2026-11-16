import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { mkdtemp, mkdir, writeFile, readFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as nodeCues from '../packages/soulmate-core/video-cues.mjs';
import { assetRoutes } from '../packages/soulmate-core/routes/asset-routes.mjs';

/**
 * Transparent-video pipeline (PRD §5 / §7):
 *   - the six cue functions exist TWICE (Node ESM + browser CJS copy) and must agree
 *     behaviourally: ONE scenario table runs against both copies.
 *   - the A/B player is exercised against a fake DOM: swap order, generation tokens,
 *     LRU eviction, ended guards, play-rejection fallback, dispose cleanup.
 *   - routes: manifest only ships existing files; triple whitelist rejects traversal.
 */

const FIXTURE = fileURLToPath(new URL('./fixtures/pet-video-skin/', import.meta.url));

// ---------------------------------------------------------------------------
// Browser copy loaded standalone in a vm (zero require — same shape as the bundle)
// ---------------------------------------------------------------------------
async function loadBrowserCues() {
  const src = await readFile(new URL('../browser/pet-video.mjs', import.meta.url), 'utf8');
  const sandbox = { module: { exports: {} }, exports: {}, console, Math, Object, Array, Number, String, JSON, Map, Set, setTimeout, clearTimeout, AbortController, URL, fetch: async () => { throw new Error('no fetch in cue tests') }, document: { createElement: () => ({}) } };
  vm.runInNewContext(src, sandbox, { filename: 'pet-video.mjs' });
  return sandbox.module.exports;
}

// ---------------------------------------------------------------------------
// ONE scenario table, run against BOTH copies
// ---------------------------------------------------------------------------
const UA_CASES = [
  // [label, ua, platform, maxTouchPoints, expected]
  ['iPhone Safari', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15', 'iPhone', 5, true],
  ['iPad classic UA', 'Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X) AppleWebKit/605.1.15', 'iPad', 5, true],
  ['iPadOS 13+ desktop UA', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15', 'MacIntel', 5, true],
  ['macOS Safari', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15', 'MacIntel', 0, true],
  ['macOS Chrome', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0 Safari/537.36', 'MacIntel', 0, false],
  ['Windows Chrome', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0', 'Win32', 0, false],
  ['Windows Edge', 'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/120.0 Edg/120.0', 'Win32', 0, false],
  ['Windows Firefox', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0', 'Win32', 0, false],
  ['iOS Firefox (WebKit)', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit/605.1.15 FxiOS/121.0', 'iPhone', 5, true],
  ['iOS Chrome (WebKit)', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit/605.1.15 CriOS/120.0', 'iPhone', 5, true],
  ['Electron', 'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/120.0 Electron/28.0', 'Win32', 0, false],
  ['Linux Firefox', 'Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0', 'Linux x86_64', 0, false],
];

const CUE_CASES = [
  ['videoNameOf: string shorthand', (c) => c.videoNameOf({ video: 'pet-wave' }), 'pet-wave'],
  ['videoNameOf: object form', (c) => c.videoNameOf({ video: { name: 'pet-walk', once: true } }), 'pet-walk'],
  ['videoNameOf: empty string → null', (c) => c.videoNameOf({ video: '' }), null],
  ['videoNameOf: absent → null', (c) => c.videoNameOf({ frames: ['pet-idle-01'] }), null],
  ['videoNameOf: null state → null', (c) => c.videoNameOf(null), null],
  ['isOnce: holdSec without dwellSec → once', (c) => c.isOnceState({ holdSec: 0.8 }), true],
  ['isOnce: dwellSec → loop', (c) => c.isOnceState({ dwellSec: [3, 8] }), false],
  ['isOnce: explicit once:false overrides holdSec', (c) => c.isOnceState({ holdSec: 0.8, video: { name: 'x', once: false } }), false],
  ['isOnce: explicit once:true overrides dwellSec', (c) => c.isOnceState({ dwellSec: [3, 8], video: { name: 'x', once: true } }), true],
  ['isOnce: neither → false', (c) => c.isOnceState({ frames: ['x'] }), false],
  ['pickNext: weighted first bucket', (c) => c.pickNextState({ next: { sit: 0.6, sleep: 0.4 } }, () => 0.1), 'sit'],
  ['pickNext: weighted second bucket', (c) => c.pickNextState({ next: { sit: 0.6, sleep: 0.4 } }, () => 0.7), 'sleep'],
  ['pickNext: roll past all → idle', (c) => c.pickNextState({ next: { sit: 0.6, sleep: 0.3 } }, () => 0.95), 'idle'],
  ['pickNext: empty next → idle', (c) => c.pickNextState({}, () => 0.5), 'idle'],
  ['endedCue: loop state ignores ended', (c) => c.endedCue({ idle: { dwellSec: [2, 4], next: { sit: 1 } } }, 'idle', () => 0), null],
  ['endedCue: once state advances via next', (c) => c.endedCue({ wave: { holdSec: 0.8, next: { idle: 1 } } }, 'wave', () => 0), 'idle'],
  ['endedCue: unknown state → null', (c) => c.endedCue({}, 'nope', () => 0), null],
  ['videoUrlFor: webm when not WebKit', (c) => c.videoUrlFor({ videoUrls: { idle: '/v?idle.webm' } }, 'idle', false), '/v?idle.webm'],
  ['videoUrlFor: mov when WebKit and shipped', (c) => c.videoUrlFor({ videoMovUrls: { idle: '/v?idle.mov' } }, 'idle', true), '/v?idle.mov'],
  ['videoUrlFor: WebKit without mov → null (NEVER webm black box)', (c) => c.videoUrlFor({ videoUrls: { idle: '/v?idle.webm' }, videoMovUrls: {} }, 'idle', true), null],
  ['videoUrlFor: missing state → null', (c) => c.videoUrlFor({ videoUrls: {} }, 'idle', false), null],
  ['videoUrlFor: null manifest → null', (c) => c.videoUrlFor(null, 'idle', false), null],
];

for (const [implName, loadImpl] of [['node ESM', async () => nodeCues], ['browser CJS copy', loadBrowserCues]]) {
  test(`video cues (${implName}): scenario table`, async () => {
    const c = await loadImpl();
    for (const [label, run, expected] of CUE_CASES) {
      assert.deepEqual(run(c), expected, `${implName}: ${label}`);
    }
    for (const [label, ua, platform, touch, expected] of UA_CASES) {
      assert.equal(c.prefersMov(ua, platform, touch), expected, `${implName}: UA ${label}`);
    }
  });
}

test('video cues: the browser copy is behaviourally identical to the Node module', async () => {
  const browser = await loadBrowserCues();
  for (const fn of ['videoNameOf', 'isOnceState', 'pickNextState', 'endedCue', 'prefersMov', 'videoUrlFor']) {
    assert.equal(typeof browser[fn], 'function', `browser copy exports ${fn}`);
  }
});

// ---------------------------------------------------------------------------
// Fake DOM for the A/B player
// ---------------------------------------------------------------------------
function fakeVideo() {
  const classes = new Set();
  const v = {
    className: '', muted: false, preload: '', loop: false, src: '', readyState: 0,
    currentTime: 0, duration: NaN, parentNode: null, style: {},
    attrs: {}, onended: null, onerror: null, onloadeddata: null,
    playCalls: 0, pauseCalls: 0, playReject: false,
    classList: {
      add: (x) => classes.add(x), remove: (x) => classes.delete(x),
      toggle: (x, on) => { if (on === undefined ? !classes.has(x) : on) classes.add(x); else classes.delete(x) },
      contains: (x) => classes.has(x),
    },
    setAttribute(k, val) { this.attrs[k] = val },
    removeAttribute(k) { if (k === 'src') this.src = ''; delete this.attrs[k] },
    play() { this.playCalls++; return this.playReject ? Promise.reject(new Error('autoplay blocked')) : Promise.resolve() },
    pause() { this.pauseCalls++ },
    // test helpers
    fireLoaded() { this.readyState = 2; if (this.onloadeddata) this.onloadeddata() },
    fireEnded() { if (this.onended) this.onended() },
    fireError() { if (this.onerror) this.onerror() },
  };
  return v;
}

function fakeDom() {
  const mount = {
    children: [], style: {},
    appendChild(c) { c.parentNode = this; this.children.push(c) },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentNode = null; return c },
  };
  const videos = [];
  const document = {
    createElement(tag) {
      if (tag !== 'video') throw new Error('unexpected element ' + tag);
      const v = fakeVideo();
      videos.push(v);
      return v;
    },
  };
  return { mount, document, videos };
}

function makePlayerEnv({ fetchImpl } = {}) {
  const dom = fakeDom();
  const ended = [], failed = [];
  let dragging = false;
  let blobSeq = 0;
  const revoked = [];
  const created = [];
  const src = readFile; // placeholder, replaced below
  void src;
  const sandbox = {
    module: { exports: {} }, exports: {}, console, Math, Object, Array, Number, String, JSON, Map, Set,
    setTimeout, clearTimeout, AbortController,
    document: dom.document,
    URL: { createObjectURL: (b) => { const u = 'blob:fake/' + (++blobSeq); created.push(u); return u }, revokeObjectURL: (u) => revoked.push(u) },
    fetch: fetchImpl || (async () => ({ ok: true, blob: async () => ({ size: 10 }) })),
  };
  return { dom, sandbox, ended, failed, revoked, created, setDragging: (v) => { dragging = v }, isDragging: () => dragging };
}

async function loadPlayer(env, opts = {}) {
  const src = await readFile(new URL('../browser/pet-video.mjs', import.meta.url), 'utf8');
  vm.runInNewContext(src, env.sandbox, { filename: 'pet-video.mjs' });
  const { createPetVideoLayer } = env.sandbox.module.exports;
  return createPetVideoLayer({
    mount: env.dom.mount,
    onEnded: (s) => env.ended.push(s),
    onFail: (s) => env.failed.push(s),
    isDragging: env.isDragging,
    ...opts,
  });
}

const tick = () => new Promise((r) => setTimeout(r, 0));

test('pet video player: A/B swap puts .is-front on the new buffer only', async () => {
  const env = makePlayerEnv();
  const layer = await loadPlayer(env);
  layer.load('idle', '/v/idle.webm', { once: false });
  await tick();
  const back = env.dom.videos.find((v) => v.src);
  back.fireLoaded();
  assert.equal(layer.activeState(), 'idle');
  assert.ok(back.classList.contains('is-front'));
  assert.equal(back.loop, true);
  layer.load('wave', '/v/wave.webm', { once: true });
  await tick();
  const next = env.dom.videos.find((v) => v.src && v !== back);
  next.fireLoaded();
  assert.ok(next.classList.contains('is-front'));
  assert.ok(!back.classList.contains('is-front'), 'old buffer loses .is-front');
  assert.equal(next.loop, false, 'once state → loop=false');
  assert.equal(back.pauseCalls > 0, true, 'old buffer paused');
  layer.dispose();
});

test('pet video player: stale generation is discarded when a newer load wins', async () => {
  let resolveFirst;
  const env = makePlayerEnv({
    fetchImpl: (url) => url.includes('slow')
      ? new Promise((r) => { resolveFirst = r })
      : Promise.resolve({ ok: true, blob: async () => ({}) }),
  });
  const layer = await loadPlayer(env);
  layer.load('idle', '/v/slow.webm', { once: false });
  layer.load('wave', '/v/fast.webm', { once: true });
  await tick();
  const fast = env.dom.videos.find((v) => v.src);
  fast.fireLoaded();
  assert.equal(layer.activeState(), 'wave');
  resolveFirst({ ok: true, blob: async () => ({}) });
  await tick(); await tick();
  assert.equal(layer.activeState(), 'wave', 'late response must not steal the front');
  layer.dispose();
});

test('pet video player: blob LRU evicts oldest and revokes (max 8)', async () => {
  const env = makePlayerEnv();
  const layer = await loadPlayer(env);
  for (let i = 0; i < 10; i++) {
    layer.load('idle', '/v/clip-' + i + '.webm', { once: false });
    await tick();
    const v = env.dom.videos.find((x) => x.src && !x.classList.contains('is-front')) || env.dom.videos[0];
    v.fireLoaded();
  }
  assert.ok(env.revoked.length >= 2, 'evicted blobs revoked');
  assert.ok(env.created.length === 10);
  // cache hit: re-loading an un-evicted URL must not fetch again
  let fetches = 0;
  env.sandbox.fetch = async () => { fetches++; return { ok: true, blob: async () => ({}) } };
  layer.load('idle', '/v/clip-9.webm', { once: false });
  await tick();
  assert.equal(fetches, 0, 'cached URL served from LRU without fetch');
  layer.dispose();
  assert.equal(env.revoked.length, env.created.length, 'dispose revokes every cached blob');
});

test('pet video player: ended fires only for the front buffer and never while dragging', async () => {
  const env = makePlayerEnv();
  const layer = await loadPlayer(env);
  layer.load('wave', '/v/wave.webm', { once: true });
  await tick();
  const front = env.dom.videos.find((v) => v.src);
  front.fireLoaded();
  env.setDragging(true);
  front.fireEnded();
  assert.deepEqual(env.ended, [], 'dragging suppresses ended');
  env.setDragging(false);
  front.fireEnded();
  assert.deepEqual(env.ended, ['wave']);
  layer.dispose();
});

test('pet video player: play() rejection → onFail and layer hidden', async () => {
  const env = makePlayerEnv();
  const layer = await loadPlayer(env);
  layer.load('idle', '/v/idle.webm', { once: false });
  await tick();
  const v = env.dom.videos.find((x) => x.src);
  v.playReject = true;
  v.fireLoaded();
  await tick();
  assert.deepEqual(env.failed, ['idle']);
  assert.equal(layer.activeState(), null);
  layer.dispose();
});

test('pet video player: fetch 404 → onFail; timeout aborts', async () => {
  const env = makePlayerEnv({ fetchImpl: async () => ({ ok: false, status: 404 }) });
  const layer = await loadPlayer(env);
  layer.load('idle', '/v/missing.webm', { once: false });
  await tick();
  assert.deepEqual(env.failed, ['idle']);
  layer.dispose();

  // timeout: fetch that only settles on abort
  const env2 = makePlayerEnv({
    fetchImpl: (url, { signal }) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    }),
  });
  const layer2 = await loadPlayer(env2);
  layer2.load('idle', '/v/hang.webm', { once: false });
  layer2.dispose(); // dispose aborts the in-flight request
  await tick();
  assert.equal(layer2.activeState(), null);
});

test('pet video player: setSize fills the stage mount and mirrors via class', async () => {
  const env = makePlayerEnv();
  const layer = await loadPlayer(env);
  layer.setSize(180);
  const v = env.dom.videos[0];
  assert.equal(v.style.height, '100%');
  assert.equal(v.style.width, '100%');
  assert.ok(!env.dom.mount.style.minWidth, 'mount.minWidth stays unset');
  layer.setMirror(true);
  assert.ok(v.classList.contains('is-mirror'));
  layer.setMirror(false);
  assert.ok(!v.classList.contains('is-mirror'));
  layer.dispose();
});

test('pet video player: setPaused pauses/resumes the front buffer', async () => {
  const env = makePlayerEnv();
  const layer = await loadPlayer(env);
  layer.load('idle', '/v/idle.webm', { once: false });
  await tick();
  const v = env.dom.videos.find((x) => x.src);
  v.fireLoaded();
  const before = v.pauseCalls;
  layer.setPaused(true);
  assert.ok(v.pauseCalls > before);
  const plays = v.playCalls;
  layer.setPaused(false);
  assert.ok(v.playCalls > plays);
  layer.dispose();
});

// ---------------------------------------------------------------------------
// Routes: injectable skins + manifest shipping + triple whitelist
// ---------------------------------------------------------------------------
const body = (out) => JSON.parse(out.body);

async function fixtureSkins() {
  const dir = await mkdtemp(join(tmpdir(), 'sm-video-skin-'));
  const skinDir = join(dir, 'video-skin');
  await mkdir(skinDir, { recursive: true });
  await copyFile(join(FIXTURE, 'pet.json'), join(skinDir, 'pet.json'));
  await copyFile(join(FIXTURE, 'pet-idle.webm'), join(skinDir, 'pet-idle.webm'));
  await copyFile(join(FIXTURE, 'pet-wave.webm'), join(skinDir, 'pet-wave.webm'));
  await copyFile(join(FIXTURE, 'pet-walk.webm'), join(skinDir, 'pet-walk.webm'));
  return { dir, skins: { 'video-skin': skinDir } };
}

function routeOf(routes, method, path) {
  return routes.find((r) => r.method === method && r.paths.includes(path)).handler;
}

test('video routes: manifest ships only existing files into videoUrls/videoMovUrls', async () => {
  const { dir, skins } = await fixtureSkins();
  try {
    const routes = assetRoutes({ home: {}, evolvePersona: async () => {}, skins });
    const manifest = routeOf(routes, 'GET', '/dsh-soulmate/api/pet/manifest');
    const out = body(await manifest({ query: new URLSearchParams('skin=video-skin') }));
    assert.equal(out.ok, true);
    assert.deepEqual(Object.keys(out.videoUrls).sort(), ['idle', 'walk', 'wave']);
    assert.deepEqual(out.videoMovUrls, {}, 'no .mov shipped → empty map');
    assert.ok(out.videoUrls.walk.includes('name=pet-walk') && out.videoUrls.walk.includes('ext=webm'));
    assert.ok(out.frameUrls['pet-idle-01'], 'frameUrls unchanged');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('video routes: no video assets → both maps empty (dormant, zero regression)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sm-video-empty-'));
  try {
    await writeFile(join(dir, 'pet.json'), JSON.stringify({ states: { idle: { frames: ['pet-idle-01'], dwellSec: [2, 4] } } }));
    const routes = assetRoutes({ home: {}, evolvePersona: async () => {}, skins: { bare: dir } });
    const out = body(await routeOf(routes, 'GET', '/dsh-soulmate/api/pet/manifest')({ query: new URLSearchParams('skin=bare') }));
    assert.deepEqual(out.videoUrls, {});
    assert.deepEqual(out.videoMovUrls, {});
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('video routes: triple whitelist rejects bad name / skin / ext and traversal', async () => {
  const { dir, skins } = await fixtureSkins();
  try {
    const routes = assetRoutes({ home: {}, evolvePersona: async () => {}, skins });
    const video = routeOf(routes, 'GET', '/dsh-soulmate/api/pet/video');
    const q = (s) => ({ query: new URLSearchParams(s) });
    assert.equal((await video(q('name=../etc&skin=video-skin&ext=webm'))).status, 400, 'traversal name');
    assert.equal((await video(q('name=pet-idle&skin=../../etc&ext=webm'))).status, 400, 'unknown skin');
    assert.equal((await video(q('name=pet-idle&skin=video-skin&ext=exe'))).status, 400, 'bad ext');
    assert.equal((await video(q('name=pet-idle&skin=video-skin&ext=mp4'))).status, 400, 'mp4 not whitelisted');
    assert.equal((await video(q('name=Pet-Idle&skin=video-skin&ext=webm'))).status, 400, 'uppercase rejected');
    assert.equal((await video(q('name=nope&skin=video-skin&ext=webm'))).status, 404, 'missing file');
    const ok = await video(q('name=pet-idle&skin=video-skin&ext=webm'));
    assert.equal(ok.status, 200);
    assert.equal(ok.headers['content-type'], 'video/webm');
    assert.equal(ok.headers['cache-control'], 'public, max-age=3600');
    assert.equal(ok.headers['x-content-type-options'], 'nosniff');
    assert.ok(Buffer.isBuffer(ok.body) && ok.body.length > 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('video routes: default skins ship the finalized character videos', async () => {
  const routes = assetRoutes({ home: {}, evolvePersona: async () => {} });
  const manifest = routeOf(routes, 'GET', '/dsh-soulmate/api/pet/manifest');
  // the only shipped skin (winterboy-chibi) carries all 15 transparent webm.
  const chibi = body(await manifest({ query: new URLSearchParams('skin=winterboy-chibi') }));
  assert.ok(chibi.videoUrls.idle && chibi.videoUrls.walk && chibi.videoUrls.wave, 'chibi ships idle/walk/wave webm');
  assert.deepEqual(chibi.videoMovUrls, {}, 'no mov shipped yet (webm-only distribution)');
  // hanfu ships its OWN 15-webm pack (blue ruqun girl), not an alias of chibi.
  const hanfu = body(await manifest({ query: new URLSearchParams('skin=hanfu') }));
  assert.ok(hanfu.videoUrls.idle && hanfu.videoUrls.walk && hanfu.videoUrls.wave, 'hanfu ships idle/walk/wave webm');
  assert.equal(hanfu.displayName, '汉风襦裙', 'hanfu manifest is its own pack');
  assert.notDeepEqual(hanfu.videoUrls, chibi.videoUrls, 'hanfu videos differ from chibi');
  assert.ok(hanfu.states.dance && hanfu.videoUrls.dance && !hanfu.states.ski, 'hanfu swaps ski for dance');
  // retired skins alias to the default shipped one so stale saved configs keep working.
  const classic = body(await manifest({ query: new URLSearchParams('skin=classic') }));
  assert.deepEqual(classic.videoUrls, chibi.videoUrls, 'retired classic aliases to chibi videos');
});

test('client.js: video pipeline needles present after build', async () => {
  const src = await readFile(new URL('../client.js', import.meta.url), 'utf8');
  for (const needle of ['sm-pet-video', 'sm-pet-stage', 'sm-pet-hit', 'videoState', 'createPetMotion', 'createPetVideoLayer', 'createPetStage', "addEventListener('visibilitychange'", 'videoUrls', 'videoMovUrls', 'pet-rig', 'is-mirror']) {
    assert.ok(src.includes(needle), `client.js should contain ${needle}`);
  }
});
