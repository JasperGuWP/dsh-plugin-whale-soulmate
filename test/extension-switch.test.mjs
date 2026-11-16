import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../index.js';
import { saveConfigAuto } from '../packages/soulmate-core/state.mjs';

function createMockCtx(dir) {
  const routes = new Map();
  const mockCtx = {
    tools: { register() { return () => {}; } },
    systemPrompt: { section() { return () => {}; }, context() { return () => {}; } },
    effect(fn) { const d = fn(); if (typeof d === 'function') mockCtx._disposers.push(d); },
    provide() {},
    set(k, v) { mockCtx[k] = v; },
    get(k) {
      if (k === 'dshHomePath') return (...segs) => join(dir, ...segs);
      if (k === 'webServer') {
        return {
          registerRoute(method, path, handler) {
            routes.set(`${method} ${path}`, handler);
            return () => routes.delete(`${method} ${path}`);
          },
        };
      }
      return mockCtx[k];
    },
    _disposers: [],
    _routes: routes,
  };
  return mockCtx;
}

const stateHandler = (ctx) => ctx._routes.get('GET /dsh-soulmate/api/state');

async function readExtensions(ctx) {
  const handler = stateHandler(ctx);
  assert.ok(handler, 'state route must be mounted');
  const out = await handler({ method: 'GET', url: '/dsh-soulmate/api/state', query: new URLSearchParams() });
  return JSON.parse(out.body).extensions;
}

test('extension switch: the panel reports the real config switch instead of a hardcoded active', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sm-ext-'));
  try {
    const ctx = createMockCtx(dir);
    apply(ctx, {});
    await ctx.soulmate.ready;

    const before = await readExtensions(ctx);
    const bili = before.find((e) => e.id === 'soulmate-bili');
    const im = before.find((e) => e.id === 'soulmate-im');
    assert.ok(bili, 'bili extension card must exist');
    assert.ok(im, 'im extension card must exist');
    assert.equal(bili.enabled, true, 'defaults stay on');
    assert.equal(bili.status, 'active');

    await saveConfigAuto(ctx.soulmate.home, { extensions: { biliEnabled: false, imEnabled: false } });

    const after = await readExtensions(ctx);
    assert.equal(after.find((e) => e.id === 'soulmate-bili').enabled, false);
    assert.equal(after.find((e) => e.id === 'soulmate-bili').status, 'disabled');
    assert.equal(after.find((e) => e.id === 'soulmate-im').enabled, false);
    assert.equal(after.find((e) => e.id === 'soulmate-im').status, 'disabled');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('extension switch: the card follows the switch at read time, not only at registration', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sm-ext-live-'));
  try {
    const ctx = createMockCtx(dir);
    apply(ctx, {});
    await ctx.soulmate.ready;

    const on = (await readExtensions(ctx)).find((e) => e.id === 'soulmate-bili');
    assert.equal(on.enabled, true);
    assert.equal(on.status, 'active');

    // Simulates the settings panel toggling the switch in a running session.
    const post = ctx._routes.get('POST /dsh-soulmate/api/config');
    const out = await post({
      method: 'POST',
      url: '/dsh-soulmate/api/config',
      body: { extensions: { biliEnabled: false } },
    });
    assert.equal(JSON.parse(out.body).ok, true);

    const off = (await readExtensions(ctx)).find((e) => e.id === 'soulmate-bili');
    assert.equal(off.enabled, false, 'an already-registered card must go disabled too');
    assert.equal(off.status, 'disabled');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('extension switch: turning one off leaves the other card untouched', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sm-ext-one-'));
  try {
    const ctx = createMockCtx(dir);
    apply(ctx, {});
    await ctx.soulmate.ready;

    await saveConfigAuto(ctx.soulmate.home, { extensions: { biliEnabled: false } });

    const cards = await readExtensions(ctx);
    assert.equal(cards.find((e) => e.id === 'soulmate-bili').enabled, false);
    assert.equal(cards.find((e) => e.id === 'soulmate-im').enabled, true, 'im stays on');
    assert.equal(cards.find((e) => e.id === 'soulmate-im').status, 'active');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});