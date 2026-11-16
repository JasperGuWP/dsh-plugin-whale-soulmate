import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../index.js';

/**
 * Token metering, end to end through the plugin's HTTP surface.
 *
 * The gap this closes: the plugin had no real token accounting at all. `budget.mjs` only
 * estimated prompt *size* before sending and nothing ever read the host's `usage`, so
 * scheduled work spent tokens with no record and no limit. Now every model call appends a
 * ledger row, and automatic calls can be refused by a daily cap the user sets in the panel.
 */

function createMockCtx(dir) {
  const routes = new Map();
  const disposers = [];
  const webServer = {
    registerRoute(method, path, handler) {
      routes.set(`${method} ${path}`, handler);
      return () => {};
    },
  };
  const mockCtx = {
    tools: { register: () => () => {} },
    systemPrompt: { section: () => () => {}, context: () => () => {} },
    effect(fn) {
      const dispose = fn();
      if (typeof dispose === 'function') disposers.push(dispose);
    },
    provide() {},
    set(k, v) {
      mockCtx[k] = v;
    },
    get(k) {
      if (k === 'dshHomePath') return (...segs) => join(dir, ...segs);
      if (k === 'webServer') return webServer;
      return mockCtx[k];
    },
    inject(deps, callback) {
      const inner = callback({ ...mockCtx, webServer, get: mockCtx.get });
      return typeof inner === 'function' ? inner : () => {};
    },
  };
  return { mockCtx, routes, dispose: () => { for (const d of disposers) d(); } };
}

const body = (out) => JSON.parse(out.body);
const GET = (routes, path) => routes.get(`GET ${path}`)({ method: 'GET', url: path });
const POST = (routes, path, payload, headers) =>
  routes.get(`POST ${path}`)({
    method: 'POST',
    url: path,
    body: payload,
    headers: { 'content-type': 'application/json', ...(headers || {}) },
  });

async function withCtx(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'sm-usage-api-'));
  const { mockCtx, routes, dispose } = createMockCtx(dir);
  apply(mockCtx, {});
  try {
    await mockCtx.soulmate.ready;
    await fn({ routes, dir });
  } finally {
    dispose();
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  }
}

test('usage: a fresh install reports zero spend and ships a sane default cap', async () => {
  await withCtx(async ({ routes }) => {
    const out = await GET(routes, '/dsh-soulmate/api/usage');
    const json = body(out);
    assert.equal(out.status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.today.totalTokens, 0);
    assert.equal(json.today.calls, 0);
    assert.ok(json.config.dailyAutoTokenCap > 0, 'the cap has a default the panel can show');
    assert.equal(json.cap.unlimited, false);
    assert.equal(json.trend.length, 7, 'the tab needs a 7-day trend to draw');
  });
});

test('usage: the cap round-trips through POST /api/usage', async () => {
  await withCtx(async ({ routes }) => {
    const saved = body(await POST(routes, '/dsh-soulmate/api/usage', { dailyAutoTokenCap: 1234, onCapReached: 'warn' }));
    assert.equal(saved.ok, true);
    assert.equal(saved.config.cap, 1234);
    assert.equal(saved.config.onCapReached, 'warn');

    const snap = body(await GET(routes, '/dsh-soulmate/api/usage'));
    assert.equal(snap.config.dailyAutoTokenCap, 1234, 'the panel reads back what it wrote');
    assert.equal(snap.cap.unlimited, false);
  });
});

test('usage: 0 means "no cap" — a legitimate setting, not an error', async () => {
  await withCtx(async ({ routes }) => {
    const res = body(await POST(routes, '/dsh-soulmate/api/usage', { dailyAutoTokenCap: 0 }));
    assert.equal(res.ok, true);
    const snap = body(await GET(routes, '/dsh-soulmate/api/usage'));
    assert.equal(snap.cap.unlimited, true);
  });
});

test('usage: invalid knobs fail loudly instead of being silently clamped', async () => {
  await withCtx(async ({ routes }) => {
    const neg = await POST(routes, '/dsh-soulmate/api/usage', { dailyAutoTokenCap: -5 });
    assert.equal(neg.status, 400);
    assert.match(String(body(neg).error), /dailyAutoTokenCap/);

    const badMode = await POST(routes, '/dsh-soulmate/api/usage', { onCapReached: 'explode' });
    assert.equal(badMode.status, 400);
    assert.match(String(body(badMode).error), /onCapReached/);
  });
});

test('usage: unknown knobs are dropped by the allow-list', async () => {
  await withCtx(async ({ routes, dir }) => {
    const res = body(await POST(routes, '/dsh-soulmate/api/usage', { dailyAutoTokenCap: 500, evil: 'x' }));
    assert.equal(res.ok, true);
    const conf = JSON.parse(await readFile(join(dir, 'soulmate', 'config.json'), 'utf8'));
    assert.equal(conf.usage.dailyAutoTokenCap, 500);
    assert.equal(conf.usage.evil, undefined, 'the allow-list must drop unknown keys');
  });
});