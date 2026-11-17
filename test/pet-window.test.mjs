import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPetWindowRuntime } from '../packages/soulmate-core/runtime/pet-window-runtime.mjs';
import { saveConfigAuto, resolveSoulmateHome } from '../packages/soulmate-core/state.mjs';

/**
 * 桌面独立窗口形态:
 *   - ignore 纯判定:身体矩形内接住、矩形外穿透、忙碌永远接住
 *   - runtime:开关拉起/收掉 helper 子进程与 loopback 服务;页/client.js/路由同源可fetch
 *   - dispose 可逆收掉一切;Electron 缺失只告警不拉进程
 */

async function loadIgnore() {
  const src = await readFile(new URL('../runtime/pet-window/ignore.cjs', import.meta.url), 'utf8');
  const sandbox = { module: { exports: {} }, exports: {} };
  vm.runInNewContext(src, sandbox, { filename: 'ignore.cjs' });
  return sandbox.module.exports;
}

test('ignore: cursor inside body rect catches, outside passes through', async () => {
  const { decideIgnore } = await loadIgnore();
  const rect = { x: 100, y: 100, w: 200, h: 150 };
  assert.equal(decideIgnore(rect, false, { x: 150, y: 150 }), false, 'inside → catch');
  assert.equal(decideIgnore(rect, false, { x: 50, y: 50 }), true, 'outside → ignore');
  assert.equal(decideIgnore(rect, false, { x: 96, y: 150 }), false, 'pad zone catches');
  assert.equal(decideIgnore(null, false, { x: 150, y: 150 }), true, 'no body reported → ignore');
});

test('ignore: busy (drag / flight) always catches even far from body', async () => {
  const { decideIgnore } = await loadIgnore();
  assert.equal(decideIgnore({ x: 0, y: 0, w: 10, h: 10 }, true, { x: 900, y: 900 }), false);
});

function fakeSpawn() {
  const calls = [];
  const impl = (exe, args, opts) => {
    const handlers = {};
    const child = {
      exe, args, opts, killed: false,
      once(ev, fn) { handlers[ev] = fn; return child; },
      kill() { child.killed = true; queueMicrotask(() => handlers.exit && handlers.exit(0)); },
      emit(ev) { handlers[ev] && handlers[ev](0); },
    };
    calls.push(child);
    return child;
  };
  return { impl, calls };
}

async function env(overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'sm-petwin-'));
  const home = resolveSoulmateHome(dir);
  await saveConfigAuto(home, { pet: { enabled: true, windowEnabled: false } });
  const { impl, calls } = fakeSpawn();
  const routes = [
    { method: 'GET', paths: ['/dsh-soulmate/api/state'], handler: async () => ({ status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ok: true, config: { pet: { enabled: true } } }) }) },
  ];
  const runtime = createPetWindowRuntime({
    home, routes, ready: Promise.resolve(), warn: () => {},
    packageRoot: new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
    spawnImpl: impl,
    electronPath: process.execPath, // 存在的二进制,绕过 ~/.dsh/electron 依赖
    pollMs: 50,
    ...overrides,
  });
  return { dir, home, runtime, calls };
}

const get = async (port, path) => {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: res.status, text: await res.text() };
};

test('window runtime: off by default — no child, no server', async () => {
  const { runtime, calls } = await env();
  runtime.begin();
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(calls.length, 0);
  assert.equal(runtime.alive(), false);
  assert.equal(runtime.port(), null);
  runtime.dispose();
});

test('window runtime: toggle on spawns helper and serves page/client/api same-origin', async () => {
  const { home, runtime, calls } = await env();
  runtime.begin();
  await saveConfigAuto(home, { pet: { windowEnabled: true } });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(calls.length, 1, 'helper spawned once');
  assert.equal(runtime.alive(), true);
  assert.ok(calls[0].args[0].replace(/\\/g, '/').endsWith('runtime/pet-window/main.cjs'));
  assert.ok(calls[0].opts.env.SOULMATE_PET_WINDOW_URL.startsWith('http://127.0.0.1:'));
  const port = runtime.port();
  const page = await get(port, '/');
  assert.equal(page.status, 200);
  assert.ok(page.text.includes('__smPetWindow') && page.text.includes('/client.js'));
  const client = await get(port, '/client.js');
  assert.equal(client.status, 200);
  assert.ok(client.text.includes('createPetThrow'), 'serves the built bundle');
  const state = await get(port, '/dsh-soulmate/api/state');
  assert.equal(state.status, 200);
  assert.ok(JSON.parse(state.text).ok === true, 'route table reused');
  const missing = await get(port, '/nope');
  assert.equal(missing.status, 404);
  runtime.dispose();
});

test('window runtime: toggle off kills helper and closes server; dispose is reversible', async () => {
  const { home, runtime, calls } = await env();
  runtime.begin();
  await saveConfigAuto(home, { pet: { windowEnabled: true } });
  await new Promise((r) => setTimeout(r, 200));
  const port = runtime.port();
  assert.ok(port);
  await saveConfigAuto(home, { pet: { windowEnabled: false } });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(runtime.alive(), false);
  assert.equal(calls[0].killed, true);
  assert.equal(runtime.port(), null);
  await assert.rejects(() => fetch(`http://127.0.0.1:${port}/`), 'server closed');
  runtime.dispose();
  runtime.dispose(); // idempotent
});

test('window runtime: missing electron warns once and never spawns', async () => {
  const warns = [];
  const { home, runtime, calls } = await env({
    electronPath: join(tmpdir(), 'definitely-not-electron.exe'),
    warn: (m) => warns.push(m),
  });
  runtime.begin();
  await saveConfigAuto(home, { pet: { windowEnabled: true } });
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(calls.length, 0);
  assert.equal(runtime.alive(), false);
  assert.equal(warns.filter((w) => w.includes('Electron 运行时不存在')).length, 1);
  runtime.dispose();
});

test('window runtime: apply begins at setup and disposes at teardown (track semantics)', async () => {
  // 回归:track(fn) 立即执行 fn 取 disposer——误传 () => rt.dispose() 会在 setup 就关掉运行时
  const dir = await mkdtemp(join(tmpdir(), 'sm-petwin-apply-'));
  const home = resolveSoulmateHome(dir);
  await saveConfigAuto(home, { pet: { windowEnabled: true } });
  const { impl, calls } = fakeSpawn();
  const disposers = [];
  const mockCtx = {
    tools: { register: () => () => {} },
    systemPrompt: { section: () => () => {}, context: () => () => {} },
    effect(fn) { const d = fn(); if (typeof d === 'function') disposers.push(d); },
    provide() {},
    set(k, v) { mockCtx[k] = v; },
    get(k) {
      if (k === 'dshHomePath') return (...s) => join(dir, ...s);
      if (k === 'webServer') return { registerRoute: () => () => {} };
      return mockCtx[k];
    },
    inject(deps, cb) { const inner = cb({ ...mockCtx, get: mockCtx.get }); return typeof inner === 'function' ? inner : () => {}; },
  };
  const { apply } = await import('../index.js');
  apply(mockCtx, { homeDir: dir, petWindowSpawnImpl: impl, petWindowElectronPath: process.execPath });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(calls.length, 1, 'helper spawned at setup — begin must survive track');
  while (disposers.length) disposers.pop()();
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(calls[0].killed, true, 'teardown kills the helper');
  assert.equal(calls.length, 1, 'no respawn after dispose');
});