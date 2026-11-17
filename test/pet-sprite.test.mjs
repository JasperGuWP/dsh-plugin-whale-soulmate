import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../index.js';
import { DEFAULT_CONFIG, deepMerge, loadConfig } from '../packages/soulmate-core/state.mjs';
import { createPetMachine } from '../packages/soulmate-home/pet-machine.mjs';

/** Minimal Cordis mock (same shape as test/plugin-integration.test.mjs). */
function createMockCtx(dir) {
  const disposers = [];
  const routes = new Map();
  const promptSections = [];
  const mockCtx = {
    tools: { register() { return () => {}; } },
    systemPrompt: {
      section(s) {
        promptSections.push(s);
        return () => {
          const i = promptSections.indexOf(s);
          if (i >= 0) promptSections.splice(i, 1);
        };
      },
      context() { return () => {}; },
    },
    effect(fn) { const d = fn(); if (typeof d === 'function') disposers.push(d); },
    provide() {},
    set(k, v) { mockCtx[k] = v; },
    get(k) {
      if (k === 'dshHomePath') return (...segs) => join(dir, ...segs);
      if (k === 'webServer') return mockCtx._webServer();
      return mockCtx[k];
    },
    inject(deps, callback) {
      const inner = callback({ ...mockCtx, webServer: mockCtx._webServer(), get: mockCtx.get });
      return typeof inner === 'function' ? inner : () => {};
    },
    _webServer() {
      return {
        registerRoute(method, path, handler) {
          routes.set(`${method} ${path}`, handler);
          return () => routes.delete(`${method} ${path}`);
        },
      };
    },
  };
  const dispose = () => { while (disposers.length) disposers.pop()(); };
  return { mockCtx, routes, promptSections, dispose };
}

const body = (out) => JSON.parse(out.body);

test('pet-machine: ambient walk after the idle threshold, gated by the switch', async () => {
  const manifest = JSON.parse(await readFile(new URL('../assets/pet-winterboy-chibi/pet.json', import.meta.url), 'utf8'));
  let t = 0;
  const m = createPetMachine(manifest, { now: () => t, random: () => 0, sleepAfterIdleSec: 600 });
  t = 5000; m.update(t); // before threshold: dwell rolls sit, never walk
  assert.notEqual(m.state, 'walk');
  t = 20000; m.update(t); // sit → idle
  t = 23000; m.update(t); // idle dwell expired + idleFor ≥ 15s + roll 0 → ambient walk
  assert.equal(m.state, 'walk');
  let t2 = 0;
  const off = createPetMachine(manifest, { now: () => t2, random: () => 0, sleepAfterIdleSec: 600, ambientWalk: false });
  t2 = 5000; off.update(t2);
  t2 = 20000; off.update(t2);
  t2 = 23000; off.update(t2);
  assert.notEqual(off.state, 'walk', 'ambientWalk=false keeps her put');
});

test('pet-machine: run mirror follows declared native facing (blue-winter faces right)', async () => {
  const manifest = JSON.parse(await readFile(new URL('../assets/pet-blue-winter/pet.json', import.meta.url), 'utf8'));
  let t = 0;
  // rand sequence: idle dwell, idle blink, idle→run roll (0.7), run dwell+facing (0.2 → -1), walk dwell+facing (0.2 → -1)
  const seq = [0.5, 0.5, 0.7, 0.2, 0.2, 0.2, 0.2];
  let ri = 0;
  const m = createPetMachine(manifest, { now: () => t, random: () => (ri < seq.length ? seq[ri++] : 0.5), sleepAfterIdleSec: 600 });
  t = 5000; m.update(t); // idle dwell expired; roll 0.7 lands on run
  assert.equal(m.state, 'run');
  // facing -1 (travel left); run faces right → must mirror
  assert.equal(m.current(t).mirror, true, 'leftward run mirrors a right-facing video');
  m.event('walk', t);
  // walk faces left; facing -1 → no mirror
  assert.equal(m.current(t).mirror, false, 'leftward walk keeps a left-facing video unmirrored');
});

test('pet: config defaults ship enabled and deep-merge keeps untouched fields', () => {
  assert.deepEqual(DEFAULT_CONFIG.pet, {
    enabled: true, sizePx: 180, sleepAfterIdleSec: 300, thinkQuietSec: 1.5, skin: 'winterboy-chibi', skinAuto: true,
    physics: { gravity: 1400, restitution: 0.78, groundFriction: 2.5, throwPower: 1 },
    windowEnabled: false, windowElectronPath: '',
    ambientWalk: true, ambientWalkAfterSec: 15, ambientWalkChance: 0.35,
  });
  const merged = deepMerge(DEFAULT_CONFIG, { pet: { enabled: false } });
  assert.equal(merged.pet.enabled, false);
  assert.equal(merged.pet.sizePx, 180);
  assert.equal(merged.pet.physics.gravity, 1400, 'nested physics defaults survive an unrelated pet patch');
  const tuned = deepMerge(DEFAULT_CONFIG, { pet: { physics: { throwPower: 1.5 } } });
  assert.equal(tuned.pet.physics.throwPower, 1.5);
  assert.equal(tuned.pet.physics.gravity, 1400, 'partial physics patch keeps the other knobs');
  assert.equal(merged.appearance.customSpriteUrl, '/dsh-soulmate/api/sprite');
});

test('pet: manifest + frame routes serve the bundled sprite pack and clean up on dispose', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sm-pet-'));
  try {
    const { mockCtx, routes, promptSections, dispose } = createMockCtx(dir);
    apply(mockCtx, {});
    await mockCtx.soulmate.ready;

    assert.ok(routes.has('GET /dsh-soulmate/api/pet/manifest'));
    assert.ok(routes.has('GET /dsh-soulmate/api/pet/frame'));

    const manifest = body(await routes.get('GET /dsh-soulmate/api/pet/manifest')({ method: 'GET', url: '/dsh-soulmate/api/pet/manifest' }));
    assert.equal(manifest.ok, true);
    assert.ok(Object.values(manifest.frameUrls)[0].includes('skin=winterboy-chibi'), 'default skin is winterboy-chibi');
    const ids = Object.keys(manifest.frameUrls).sort();
    assert.equal(ids.length, 18);
    assert.ok(ids.includes('pet-eat') && ids.includes('pet-game') && ids.includes('pet-ski') && ids.includes('pet-run'));
    assert.ok(ids.includes('pet-idle-01') && ids.includes('pet-idle-02') && ids.includes('pet-drag'));
    assert.ok(ids.includes('pet-think-01') && ids.includes('pet-think-02') && ids.includes('pet-eureka'));
    assert.equal(manifest.states.walk.fps, 6);

    // only bundled skin: manifest + frames honour ?skin=, unknown skin fails loud
    const manifestHandler = routes.get('GET /dsh-soulmate/api/pet/manifest');
    const chibi = body(await manifestHandler({ method: 'GET', url: '/dsh-soulmate/api/pet/manifest?skin=winterboy-chibi' }));
    assert.equal(chibi.ok, true);
    assert.ok(Object.values(chibi.frameUrls)[0].includes('skin=winterboy-chibi'));
    const badSkin = body(await manifestHandler({ method: 'GET', url: '/dsh-soulmate/api/pet/manifest?skin=nope' }));
    assert.equal(badSkin.ok, false);
    // retired maid folds into the default skin and drops out of the catalog
    const maidManifest = body(await manifestHandler({ method: 'GET', url: '/dsh-soulmate/api/pet/manifest?skin=maid' }));
    assert.equal(maidManifest.ok, true);
    assert.ok(Object.values(maidManifest.frameUrls)[0].includes('skin=winterboy-chibi'));
    const skinsOut = body(await routes.get('GET /dsh-soulmate/api/pet/skins')({ method: 'GET', url: '/dsh-soulmate/api/pet/skins' }));
    assert.ok(!skinsOut.skins.some((s) => s.id === 'maid'), 'maid no longer listed');

    const frameHandler = routes.get('GET /dsh-soulmate/api/pet/frame');
    const chibiFrame = await frameHandler({ method: 'GET', url: '/dsh-soulmate/api/pet/frame?id=pet-idle-01&skin=underwater' });
    assert.equal(chibiFrame.status, 200);
    assert.equal(chibiFrame.headers['content-type'], 'image/png');
    const ok = await frameHandler({ method: 'GET', url: '/dsh-soulmate/api/pet/frame?id=pet-idle-01', query: new URLSearchParams('id=pet-idle-01') });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers['content-type'], 'image/png');
    assert.ok(ok.body.length > 1000);
    assert.equal(ok.body[1], 0x50); // 'P' of PNG signature

    const bad = body(await frameHandler({ method: 'GET', url: '/x', query: new URLSearchParams('id=../etc') }));
    assert.equal(bad.ok, false);
    const missing = body(await frameHandler({ method: 'GET', url: '/x', query: new URLSearchParams('id=pet-nope') }));
    assert.equal(missing.ok, false);

    // pet config writes go through the generic config patch route
    const cfgOut = body(await routes.get('POST /dsh-soulmate/api/config')({
      method: 'POST', url: '/dsh-soulmate/api/config', body: { pet: { enabled: true, sizePx: 160 } },
    }));
    assert.equal(cfgOut.ok, true);
    const cfg = await loadConfig(mockCtx.soulmate.home);
    assert.equal(cfg.pet.enabled, true);
    assert.equal(cfg.pet.sizePx, 160);
    assert.equal(cfg.pet.sleepAfterIdleSec, 300);

    // petThinking latches on persona/tool activity; quiet window is the no-whenIdle fallback
    const stateRoute = routes.get('GET /dsh-soulmate/api/state');
    const getState = async () => body(await stateRoute({ method: 'GET', url: '/dsh-soulmate/api/state' }));
    assert.equal((await getState()).petThinking, false);
    await mockCtx.soulmate.getPersonaPrompt({});
    assert.equal((await getState()).petThinking, true);
    await routes.get('POST /dsh-soulmate/api/config')({ method: 'POST', url: '/x', body: { pet: { thinkQuietSec: 0.05 } } });
    // Re-touch so the watch picks up the shortened quiet window (no sessionController here).
    await mockCtx.soulmate.getPersonaPrompt({});
    assert.equal((await getState()).petThinking, true);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal((await getState()).petThinking, false);

    // Host assemble() only reads section.text(ctx) — never render/getPersonaPrompt.
    // That path must also light petThinking, or the corner pet ignores chat.
    const personaSection = promptSections.find((s) => s && s.name === 'soulmate:persona');
    assert.ok(personaSection, 'persona section registered');
    assert.equal(typeof personaSection.text, 'function', 'text must be a function so DSH assemble calls it each turn');
    personaSection.text({ sessionId: 'chat-1', lastUserMessage: '帮我看看这个插件' });
    const thinkingState = await getState();
    assert.equal(thinkingState.petThinking, true);
    assert.equal(thinkingState.sessionId, 'chat-1');
    assert.equal(thinkingState.petTurnPhase, 'thinking');
    assert.match(String(thinkingState.petTurnPreview || ''), /插件/);

    const icon = await routes.get('GET /dsh-soulmate/api/notify-icon')({ method: 'GET', url: '/dsh-soulmate/api/notify-icon' });
    assert.equal(icon.status, 200);
    assert.ok(Buffer.isBuffer(icon.body) || icon.body?.length > 0);

    dispose();
    assert.ok(!routes.has('GET /dsh-soulmate/api/pet/manifest'), 'pet routes removed on dispose');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('pet: whenIdle drops petThinking so the widget can flash eureka immediately', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sm-pet-idle-'));
  try {
    let releaseIdle;
    const idle = new Promise((resolve) => { releaseIdle = resolve; });
    const { mockCtx, routes, promptSections, dispose } = createMockCtx(dir);
    mockCtx.sessionController = {
      async resolveAgent() {
        return { whenIdle: () => idle };
      },
    };
    apply(mockCtx, {});
    await mockCtx.soulmate.ready;

    await routes.get('POST /dsh-soulmate/api/config')({
      method: 'POST', url: '/x', body: { pet: { thinkQuietSec: 30 } },
    });
    const getState = async () => body(await routes.get('GET /dsh-soulmate/api/state')({
      method: 'GET', url: '/dsh-soulmate/api/state',
    }));
    const personaSection = promptSections.find((s) => s && s.name === 'soulmate:persona');
    assert.ok(personaSection);

    personaSection.text({ sessionId: 'chat-idle-1' });
    assert.equal((await getState()).petThinking, true);

    // Still thinking through the settle delay + while the turn is in flight.
    await new Promise((r) => setTimeout(r, 450));
    assert.equal((await getState()).petThinking, true);

    releaseIdle();
    await new Promise((r) => setTimeout(r, 80));
    assert.equal((await getState()).petThinking, false, 'answer done → thinking clears for eureka');

    dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('pet-machine: blink, click, drag, sleep and walk frames follow pet.json timings', async () => {
  const manifest = JSON.parse(await readFile(new URL('../assets/pet-winterboy-chibi/pet.json', import.meta.url), 'utf8'));
  let t = 0;
  const m = createPetMachine(manifest, { now: () => t, random: () => 0.42, sleepAfterIdleSec: 60 });

  assert.equal(m.current(t).frame, 'pet-idle-01');

  // blink window: enteredAt 0 + 1200 + 0.42*2600 = 2292ms
  t = 2300;
  assert.equal(m.current(t).frame, 'pet-idle-02');
  t = 2600;
  assert.equal(m.current(t).frame, 'pet-idle-01');

  // click -> wave (hold 0.8s) -> idle
  m.event('click', t);
  assert.equal(m.current(t).frame, 'pet-wave');
  t += 1000;
  m.update(t);
  assert.equal(m.state, 'idle');

  // drag -> dangle frame; release -> happy -> idle
  m.event('dragStart', t);
  assert.equal(m.current(t).frame, 'pet-drag');
  m.event('dragEnd', t);
  assert.equal(m.current(t).frame, 'pet-happy');
  t += 1000;
  m.update(t);
  assert.equal(m.state, 'idle');

  // idle no longer wanders off on a dice roll: walking is a conversation-switch gesture,
  // so an idle dwell that rolls the old "walk" branch must stay put (never walk).
  const entered = t;
  t = entered + 3100;
  m.update(t);
  assert.notEqual(m.state, 'walk', 'idle must not randomly transition into walk');

  // The walk itself still works when it is explicitly requested (conversation switch).
  m.event('walk', t);
  assert.equal(m.state, 'walk');
  const first = m.current(t);
  assert.match(first.frame, /^pet-walk-0[12]$/);
  t += 200; // 6fps => next frame after ~167ms
  assert.equal(m.current(t).frame, first.frame === 'pet-walk-01' ? 'pet-walk-02' : 'pet-walk-01');
  m.event('turn', t);
  assert.equal(m.current(t).mirror, true);

  // think persists + cycles at fps 2; eureka ends it with a flash then idle
  m.event('think', t);
  assert.equal(m.state, 'think');
  assert.equal(m.current(t).frame, 'pet-think-01');
  t += 600;
  assert.equal(m.current(t).frame, 'pet-think-02');
  t += 5000;
  m.update(t);
  assert.equal(m.state, 'think');
  m.event('eureka', t);
  assert.equal(m.current(t).frame, 'pet-eureka');
  t += 1500;
  m.update(t);
  assert.equal(m.state, 'idle');

  // long idle -> sleep; click wakes into happy (walk dwell expires first, then idle's)
  t += 70_000;
  m.update(t);
  assert.equal(m.state, 'sleep');
  assert.equal(m.current(t).frame, 'pet-sleep');
  m.event('click', t);
  assert.equal(m.current(t).frame, 'pet-happy');
});

test('pet: browser half wires the sprite layer without touching the static PNG card', async () => {
  const src = await readFile(new URL('../client.js', import.meta.url), 'utf8');
  // Assert the *behaviour* (both cards mounted under the identity tab), not a local
  // variable name: the panel was split into panel-forms.mjs, so the old literal
  // `identity: [identity, spriteCard, petCard]` is an implementation detail.
  for (const needle of ['桌面小伙伴', "api('pet/manifest", 'petEvent(', 'identity: [identity, lookPetCardEl]', 'petThinking', "addEventListener('wheel'", 'pet/manifest?skin=', 'petskin']) {
    assert.ok(src.includes(needle), `client.js should contain ${needle}`);
  }
  // static card still explains image formats for uploads (Q版 default since 0.2.83)
  assert.ok(src.includes('选已有形象会同步页内头像与桌面小伙伴皮肤'));
  assert.ok(src.includes('sm-pet-ops'), 'pet card ops column must use the vertical layout class');
});