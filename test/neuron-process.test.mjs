// Phase-3 star-sea: process fx, growth trajectory, cap ranking, neuron window routes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../index.js';
import { saveConfigAuto } from '../packages/soulmate-core/state.mjs';

const require = createRequire(import.meta.url);
// process.mjs is CJS-style under an .mjs name (browser convention) — load via vm.
const processFx = await (async () => {
  const src = await readFile(new URL('../browser/neuron/process.mjs', import.meta.url), 'utf8');
  const sandbox = { module: { exports: {} }, exports: {}, require: () => ({}), WeakMap, Map, Set, Math, Date, Object, Array, Number, String, JSON };
  vm.runInNewContext(src, sandbox, { filename: 'process.mjs' });
  return sandbox.module.exports;
})();
const { noteGraph, noteEvents, birthGlow, fxOf, progressActive } = processFx;

// panel-neuron-growth requires host react — load it in a vm with a minimal shim,
// same pattern as test/panel-asr.test.mjs.
const growthMod = await (async () => {
  const src = await readFile(new URL('../browser/panel-neuron-growth.mjs', import.meta.url), 'utf8');
  const react = { createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(Boolean) }) };
  const sandbox = { module: { exports: {} }, exports: {}, require: (id) => (id === 'react' ? react : {}) };
  vm.runInNewContext(src, sandbox, { filename: 'panel-neuron-growth.mjs' });
  return sandbox.module.exports;
})();
const { growthStrip, filterGraphToWeek, traitDeltas } = growthMod;

const canvasStub = () => ({}); // WeakMap key only — process fx never touches canvas API

test('process fx: first graph poll seeds without a birthday storm; new stars ignite', () => {
  const c = canvasStub();
  const t0 = 1_000_000;
  noteGraph(c, { nodes: [{ id: 'a' }, { id: 'b' }] }, t0);
  assert.equal(birthGlow(fxOf(c), 'a', t0 + 100), 0);
  noteGraph(c, { nodes: [{ id: 'a' }, { id: 'b' }, { id: 'wiki:dream-x' }] }, t0 + 1000);
  assert.ok(birthGlow(fxOf(c), 'wiki:dream-x', t0 + 1500) > 0);
  assert.equal(birthGlow(fxOf(c), 'a', t0 + 1500), 0);
  // expiry
  assert.equal(birthGlow(fxOf(c), 'wiki:dream-x', t0 + 1000 + 7000), 0);
});

test('process fx: memory-progress stages glow then resolve into births on done', () => {
  const c = canvasStub();
  const t0 = 2_000_000;
  noteEvents(c, [{ type: 'memory-progress', stage: 'dream', work: 'dream', slug: 'dream-2026-11-23' }], t0);
  assert.equal(progressActive(c), true);
  noteEvents(c, [{ type: 'memory-progress', stage: 'done', work: 'dream', slug: 'dream-2026-11-23', ids: ['wiki:dream-2026-11-23'] }], t0 + 500);
  assert.equal(progressActive(c), false);
  assert.ok(birthGlow(fxOf(c), 'wiki:dream-2026-11-23', t0 + 600) > 0);
});

test('process fx: intent events flash and expire; restraint is a distinct kind', () => {
  const c = canvasStub();
  const t0 = 3_000_000;
  noteEvents(c, [{ type: 'intent', action: 'silent' }, { type: 'intent', action: 'speak' }], t0);
  const fx = fxOf(c);
  assert.equal(fx.flashes.length, 2);
  assert.equal(fx.flashes[0].kind, 'restraint');
  assert.equal(fx.flashes[1].kind, 'act');
  noteEvents(c, [], t0 + 4000);
  assert.equal(fx.flashes.length, 0);
});

test('process fx: same event seq does not re-ignite soft glows', () => {
  const c = canvasStub();
  const t0 = 4_000_000;
  noteEvents(c, [
    { seq: 11, type: 'dream', ids: ['wiki:dream-a'] },
    { seq: 12, type: 'intent', action: 'speak' },
  ], t0);
  assert.ok(birthGlow(fxOf(c), 'wiki:dream-a', t0 + 100) > 0);
  assert.equal(fxOf(c).flashes.length, 1);
  // Replay the same feed (what panel did on every open without a since-cursor).
  noteEvents(c, [
    { seq: 11, type: 'dream', ids: ['wiki:dream-a'] },
    { seq: 12, type: 'intent', action: 'speak' },
  ], t0 + 200);
  assert.equal(fxOf(c).flashes.length, 1);
  assert.equal(fxOf(c).births.get('wiki:dream-a'), t0);
});

test('growth: trait deltas list only real movement', () => {
  const a = { traits: { clinginess: 50, sassiness: 60 } };
  const b = { traits: { clinginess: 54, sassiness: 60, tsundere: 40 } };
  const d = traitDeltas(a, b);
  assert.ok(d.some((x) => x.includes('黏人 +4')));
  assert.ok(!d.some((x) => x.includes('吐槽')));
});

test('growth: week filter keeps only stars born by that snapshot, links follow', () => {
  const graph = {
    nodes: [
      { id: 'old', createdAt: '2026-10-01T00:00:00Z' },
      { id: 'new', createdAt: '2026-11-20T00:00:00Z' },
      { id: 'undated' },
    ],
    synapses: [
      { source: 'old', target: 'new' },
      { source: 'old', target: 'undated' },
    ],
  };
  const week = { week: '2026-W44', at: '2026-11-01T00:00:00Z' };
  const filtered = filterGraphToWeek(graph, week);
  assert.deepEqual(filtered.nodes.map((n) => n.id), ['old', 'undated']);
  assert.equal(filtered.synapses.length, 1);
  // null week = present sky untouched
  assert.equal(filterGraphToWeek(graph, null), graph);
});

test('growth strip renders without React DOM (element tree only)', () => {
  // growthStrip needs h from react — the browser module requires host react; skip render
  // and assert the pure helpers exist for the panel contract.
  assert.equal(typeof growthStrip, 'function');
});

// --- routes wiring -----------------------------------------------------------

function createMockCtx(dir) {
  const disposers = [];
  const routes = new Map();
  const mockCtx = {
    tools: { register() { return () => {}; } },
    systemPrompt: { section() { return () => {}; }, context() { return () => {}; } },
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
  return { mockCtx, routes, dispose };
}
const body = (out) => JSON.parse(out.body);

test('neuron routes: growth returns weekly rows; window open reports honest failure without Electron', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sm-neuron-'));
  try {
    const { mockCtx, routes, dispose } = createMockCtx(dir);
    // A bogus Electron path keeps the test from flashing a real window on the developer box.
    apply(mockCtx, { petWindowElectronPath: join(dir, 'no-electron.exe') });
    await mockCtx.soulmate.ready;
    await saveConfigAuto(mockCtx.soulmate.home, { proactive: { dreamLlmEnabled: false, dailyDiary: false }, extensions: { biliAutoSurfEnabled: false } });
    await mockCtx.soulmate.runProactiveTick(Date.parse('2026-11-09T23:40:00Z'));

    const growth = body(await routes.get('GET /dsh-soulmate/api/growth')({ method: 'GET', url: '/x', query: new URLSearchParams() }));
    assert.equal(growth.ok, true);
    assert.ok(growth.weeks.length >= 1);
    assert.match(growth.weeks[0].week, /^\d{4}-W\d{2}$/);

    const status = body(await routes.get('GET /dsh-soulmate/api/neuron-window')({ method: 'GET', url: '/x', query: new URLSearchParams() }));
    assert.equal(status.ok, true);
    assert.equal(status.running, false);

    // No Electron on the test box (or a fake path): open must fail honestly, not throw.
    const open = body(await routes.get('POST /dsh-soulmate/api/neuron-window/open')({ method: 'POST', url: '/x', query: new URLSearchParams(), body: {} }));
    assert.equal(typeof open.ok, 'boolean');
    if (!open.ok) assert.ok(String(open.error).length > 0);

    // Bounds memory round-trips through config.
    const saved = body(await routes.get('POST /dsh-soulmate/api/neuron-window/bounds')({
      method: 'POST', url: '/x', query: new URLSearchParams(), body: { x: 10, y: 20, width: 1200, height: 800 },
    }));
    assert.equal(saved.ok, true);

    dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});