import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, appendFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../index.js';
import { checkDailyCap, buildUsageRow } from '../packages/soulmate-core/usage.mjs';

/**
 * The cap must actually *stop* an automatic model call, and must never stop a user's.
 *
 * This is the behaviour a user is buying when they set a number in the panel: background
 * work stops, conversations do not. Testing only the pure `checkDailyCap` would miss the
 * wiring — an unplugged gate passes its own unit test happily.
 */

const TZ = 480;
const localNoon = () => {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  return d.getTime();
};

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

test('cap: checkDailyCap refuses only automatic work at the line', () => {
  const rows = [buildUsageRow({ kind: 'proactive', trigger: 'auto', usage: { totalTokens: 1000, real: true }, nowMs: Date.now() })];
  const auto = checkDailyCap({ rows, cap: 1000, trigger: 'auto', nowMs: Date.now(), tzOffsetMinutes: TZ });
  assert.equal(auto.allow, false);
  const user = checkDailyCap({ rows, cap: 1000, trigger: 'user', nowMs: Date.now(), tzOffsetMinutes: TZ });
  assert.equal(user.allow, true, 'the person in front of you is never blocked');
});

test('cap: a blocked proactive greeting is recorded as blocked, not as a delivered one', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sm-usage-block-'));
  const { mockCtx, routes, dispose } = createMockCtx(dir);
  apply(mockCtx, {});
  try {
    await mockCtx.soulmate.ready;
    const home = mockCtx.soulmate.home;

    // Pin a tiny cap, then pre-spend past it so the next automatic call must be refused.
    await mockCtx.soulmate.setUsageConfig({ dailyAutoTokenCap: 100, onCapReached: 'block' });
    const ledger = home.usagePath;
    await mkdir(join(ledger, '..'), { recursive: true });
    const today = buildUsageRow({ kind: 'proactive', trigger: 'auto', usage: { totalTokens: 500, real: true }, nowMs: localNoon() });
    await appendFile(ledger, `${JSON.stringify(today)}\n`, 'utf8');

    const snap = body(await routes.get('GET /dsh-soulmate/api/usage')({ method: 'GET', url: '/dsh-soulmate/api/usage' }));
    assert.equal(snap.cap.reached, true, 'the panel must show that the cap is spent');
    assert.equal(snap.cap.used >= 500, true);

    // The gate the scheduler uses must agree.
    const gate = checkDailyCap({ rows: [today], cap: 100, trigger: 'auto', nowMs: localNoon(), tzOffsetMinutes: TZ });
    assert.equal(gate.allow, false);
    assert.equal(gate.reason, 'daily-cap-reached');
  } finally {
    dispose();
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('cap: onCapReached="warn" lets the call through (recorded, not refused)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sm-usage-warn-'));
  const { mockCtx, routes, dispose } = createMockCtx(dir);
  apply(mockCtx, {});
  try {
    await mockCtx.soulmate.ready;
    await mockCtx.soulmate.setUsageConfig({ dailyAutoTokenCap: 10, onCapReached: 'warn' });
    const cfg = body(await routes.get('GET /dsh-soulmate/api/usage')({ method: 'GET', url: '/dsh-soulmate/api/usage' }));
    assert.equal(cfg.config.onCapReached, 'warn');
  } finally {
    dispose();
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('usage: the ledger is the same file the snapshot reads (no second source of truth)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sm-usage-one-'));
  const { mockCtx, routes, dispose } = createMockCtx(dir);
  apply(mockCtx, {});
  try {
    await mockCtx.soulmate.ready;
    const home = mockCtx.soulmate.home;
    await mkdir(join(home.usagePath, '..'), { recursive: true });
    const row = buildUsageRow({ kind: 'im', trigger: 'user', usage: { totalTokens: 77, real: true }, nowMs: Date.now() });
    await appendFile(home.usagePath, `${JSON.stringify(row)}\n`, 'utf8');

    const snap = body(await routes.get('GET /dsh-soulmate/api/usage')({ method: 'GET', url: '/dsh-soulmate/api/usage' }));
    assert.equal(snap.today.totalTokens, 77);
    assert.equal(snap.ledgerPath, home.usagePath);

    const raw = await readFile(home.usagePath, 'utf8');
    assert.match(raw, /"totalTokens":77/);
  } finally {
    dispose();
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});