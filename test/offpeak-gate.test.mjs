import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../index.js';
import { DEFAULT_CONFIG, loadConfig } from '../packages/soulmate-core/state.mjs';
import { isDeepSeekOffPeak } from '../packages/soulmate-core/persona.mjs';
import { isOffPeakUtc } from '../packages/soulmate-core/proactive.mjs';

function createMockCtx(dir) {
  const routes = new Map();
  const mockCtx = {
    tools: { register() { return () => {}; } },
    systemPrompt: { section() { return () => {}; }, context() { return () => {}; } },
    effect(fn) { fn(); },
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
    _routes: routes,
  };
  return mockCtx;
}

/** Off-peak is 16:30–00:30 UTC; both instants are 深夜 locally (UTC+8) but differ in price. */
const PEAK_NIGHT = Date.parse('2026-11-09T15:40:00Z');    // 23:40 local, 15:40 UTC → peak
const OFFPEAK_NIGHT = Date.parse('2026-11-09T17:00:00Z'); // 01:00 local, 17:00 UTC → off-peak

async function seedFacts(service) {
  await service.retainFact({ topic: '饮品偏好', content: '早上一杯冰美式', importance: 4 });
  await service.retainFact({ topic: '代码风格', content: '坚持纯 Node 零依赖', importance: 4 });
}

test('off-peak: the predicate stays the single source of truth for the window', () => {
  assert.equal(isDeepSeekOffPeak(PEAK_NIGHT), false);
  assert.equal(isDeepSeekOffPeak(OFFPEAK_NIGHT), true);
});

test('off-peak: the two copies of the window predicate never drift apart', () => {
  // persona.mjs imports the prompt builders, proactive.mjs stays dependency-free, so the
  // window is duplicated on purpose. This sweep is the guard that keeps the copy honest.
  const start = Date.parse('2026-11-09T00:00:00Z');
  for (let i = 0; i < 96; i += 1) {
    const at = start + i * 15 * 60_000;
    assert.equal(
      isDeepSeekOffPeak(at),
      isOffPeakUtc(at),
      `predicates disagree at ${new Date(at).toISOString()}`,
    );
  }
});

test('off-peak: a dream due in the peak window is deferred, not skipped', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sm-offpeak-'));
  try {
    const ctx = createMockCtx(dir);
    apply(ctx, {});
    await ctx.soulmate.ready;
    await seedFacts(ctx.soulmate);

    const peak = await ctx.soulmate.runProactiveTick(PEAK_NIGHT);
    assert.equal(peak.dream.dream, false);
    assert.equal(peak.dream.reason, 'peak-hours-deferred', 'the dream waits for the cheaper window');
    assert.equal((await loadConfig(ctx.soulmate.home)).proactive.lastDreamAt ?? '', '', 'a deferral must not advance the cursor');

    const off = await ctx.soulmate.runProactiveTick(OFFPEAK_NIGHT);
    assert.equal(off.dream.ok, true, JSON.stringify(off.dream));
    assert.equal(off.dream.dream, true, 'the deferred fact is still pending on the cheap window');
    const page = await readFile(join(ctx.soulmate.home.wikiDir, 'dream-2026-11-10.md'), 'utf8');
    assert.match(page, /冰美式/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('off-peak: preferOffPeak can be switched off so she dreams the moment 23:30 hits', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sm-offpeak-off-'));
  try {
    const ctx = createMockCtx(dir);
    apply(ctx, {});
    await ctx.soulmate.ready;
    assert.equal(DEFAULT_CONFIG.proactive.preferOffPeak, true, 'cheaper first is the default');

    const post = ctx._routes.get('POST /dsh-soulmate/api/config');
    const out = await post({ method: 'POST', url: '/x', body: { proactive: { preferOffPeak: false } } });
    assert.equal(JSON.parse(out.body).ok, true);

    await seedFacts(ctx.soulmate);
    const peak = await ctx.soulmate.runProactiveTick(PEAK_NIGHT);
    assert.equal(peak.dream.dream, true, 'with the preference off, price no longer blocks the dream');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('off-peak: the gate reports the price window so the panel can explain a quiet night', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sm-offpeak-status-'));
  try {
    const ctx = createMockCtx(dir);
    apply(ctx, {});
    await ctx.soulmate.ready;

    const handler = ctx._routes.get('GET /dsh-soulmate/api/proactive/status');
    const at = Date.parse('2026-11-09T15:40:00Z');
    const out = await handler({
      method: 'GET',
      url: `/x?now=${at}`,
      query: new URLSearchParams({ now: String(at) }),
    });
    const status = JSON.parse(out.body);
    assert.equal(status.priceWindow, 'peak');
    assert.equal(status.offPeak, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});