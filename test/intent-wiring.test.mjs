// Intent layer wiring: tick integration, opportunity sourcing, decision audit, restraint note.
// Mock ctx / inject pattern mirrors test/proactive-wiring.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../index.js';
import { saveConfigAuto } from '../packages/soulmate-core/state.mjs';

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

// 2026-11-09T23:40Z = 07:40 local (UTC+8) morning slot; off-peak UTC for cheap calls.
const AT = Date.parse('2026-11-09T23:40:00Z');

async function bootWith(dir, { verdict, cfgPatch = {} } = {}) {
  const prompts = [];
  const { mockCtx, dispose } = createMockCtx(dir);
  apply(mockCtx, {
    listLlmModels: async () => [{ id: 'cheap-flash', pricing: { input: 1 } }],
    llmOneShot: async ({ prompt, kind }) => {
      prompts.push({ prompt, kind });
      return { text: verdict ?? '{"action":"silent","reason":"测试保持安静"}', usage: { totalTokens: 400 } };
    },
  });
  await mockCtx.soulmate.ready;
  await saveConfigAuto(mockCtx.soulmate.home, {
    proactive: {
      intentEnabled: true,
      dreamLlmEnabled: false,
      distillLlmEnabled: false,
      dailyDiary: false,
      ...cfgPatch,
    },
    // Intent tests must not surf: a real round would hit the network and feed extra events.
    extensions: { biliAutoSurfEnabled: false },
  });
  return { mockCtx, dispose, prompts };
}

test('intent wiring: slot becomes an opportunity; her speak verdict is logged and audited', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sm-intent-'));
  try {
    // The fake model picks whatever event the prompt offers first.
    let offeredId = '';
    const { mockCtx, dispose, prompts } = await bootWith(dir, {
      verdict: 'PLACEHOLDER',
    });
    // Two-phase: first tick with silent verdict to learn the event id, then act on a fresh key.
    const first = await mockCtx.soulmate.runProactiveTick(AT);
    assert.equal(first.ok, true);
    assert.equal(first.intent.ran, true, JSON.stringify(first.intent));
    assert.equal(first.intent.action, 'silent');
    // Old direct delivery must NOT have fired while intent is on.
    assert.equal(first.delivery.via, 'silent');
    const proRaw = await readFile(join(mockCtx.soulmate.home.logsDir, 'proactive.jsonl'), 'utf8');
    assert.ok(proRaw.includes('intent-source'), 'schedule gate demoted to opportunity source');
    // The decision call saw her persona and the morning opportunity.
    const intentPrompt = prompts.find((p) => p.kind === 'intent-llm');
    assert.ok(intentPrompt, 'intent-llm call happened');
    assert.match(intentPrompt.prompt, /此刻的机会/);
    assert.match(intentPrompt.prompt, /早安/);
    offeredId = (intentPrompt.prompt.match(/\[(ev-[a-z0-9-]+)\]/) || [])[1] || '';
    assert.ok(offeredId);

    // Decision journal exists with a machine-readable reason.
    const decisionsRaw = await readFile(join(mockCtx.soulmate.home.logsDir, 'intent-decisions.jsonl'), 'utf8');
    const decision = JSON.parse(decisionsRaw.split('\n').filter(Boolean)[0]);
    assert.equal(decision.action, 'silent');
    assert.equal(decision.delivered, 'silent');
    assert.ok(decision.reason.length > 0);

    // usage row recorded under intent-llm
    const usageRaw = await readFile(mockCtx.soulmate.home.usagePath, 'utf8');
    assert.ok(usageRaw.includes('"kind":"intent-llm"'));

    dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('intent wiring: unbound silent verdict is a general restraint — audited, no event resolved', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sm-intent-restraint-'));
  try {
    const { mockCtx, dispose } = await bootWith(dir, {
      verdict: '{"action":"silent","reason":"他在忙"}',
    });
    const res = await mockCtx.soulmate.runProactiveTick(AT);
    assert.equal(res.intent.ran, true);
    assert.equal(res.intent.action, 'silent');
    const raw = await readFile(join(mockCtx.soulmate.home.logsDir, 'intent-decisions.jsonl'), 'utf8');
    const rows = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(rows[0].action, 'silent');
    assert.equal(rows[0].parse, 'ok');
    // No event bound → nothing declined in the ledger.
    const ledgerRaw = await readFile(join(mockCtx.soulmate.home.logsDir, 'intent-events.jsonl'), 'utf8');
    assert.ok(!ledgerRaw.includes('"status":"declined"'));
    dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('intent wiring: bound silent verdict declines the event and writes 欲言又止 to the inner notebook', async () => {
  const dir2 = await mkdtemp(join(tmpdir(), 'sm-intent-decline2-'));
  try {
    const { mockCtx, dispose } = createMockCtx(dir2);
    apply(mockCtx, {
      listLlmModels: async () => [{ id: 'cheap-flash', pricing: { input: 1 } }],
      llmOneShot: async ({ prompt }) => {
        const id = (prompt.match(/\[(ev-[a-z0-9-]+)\]/) || [])[1] || '';
        return { text: `{"action":"silent","eventId":"${id}","reason":"他在赶工，不想吵他"}`, usage: { totalTokens: 400 } };
      },
    });
    await mockCtx.soulmate.ready;
    await saveConfigAuto(mockCtx.soulmate.home, {
      proactive: { intentEnabled: true, dreamLlmEnabled: false, distillLlmEnabled: false, dailyDiary: false },
      extensions: { biliAutoSurfEnabled: false },
    });
    const res = await mockCtx.soulmate.runProactiveTick(AT);
    assert.equal(res.intent.ran, true);
    assert.equal(res.intent.action, 'silent');

    // The restraint note landed in the private notebook directory.
    const names = await readdir(mockCtx.soulmate.home.privateDir).catch(() => []);
    let epsRaw = '';
    for (const n of names) epsRaw += await readFile(join(mockCtx.soulmate.home.privateDir, n), 'utf8').catch(() => '');
    assert.match(epsRaw, /欲言又止/);
    assert.match(epsRaw, /他在赶工/);

    // Event resolved as declined in the ledger journal.
    const ledgerRaw = await readFile(join(mockCtx.soulmate.home.logsDir, 'intent-events.jsonl'), 'utf8');
    assert.ok(ledgerRaw.includes('"status":"declined"'));

    // Second tick soon after: the declined event stays resolved, nothing new to consider.
    const again = await mockCtx.soulmate.runProactiveTick(AT + 60_000);
    assert.equal(again.intent.ran, false);
    assert.equal(again.intent.reason, 'no-events');
    dispose();
  } finally {
    await rm(dir2, { recursive: true, force: true });
  }
});

test('intent wiring: speak verdict delivers via event tier and consumes the event', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sm-intent-act-'));
  try {
    const { mockCtx, dispose } = createMockCtx(dir);
    apply(mockCtx, {
      listLlmModels: async () => [{ id: 'cheap-flash', pricing: { input: 1 } }],
      llmOneShot: async ({ prompt }) => {
        const id = (prompt.match(/\[(ev-[a-z0-9-]+)\]/) || [])[1] || '';
        return { text: `{"action":"speak","eventId":"${id}","angle":"早上好，按性格聊一句","reason":"早晨想跟他说说话","steps":1}`, usage: { totalTokens: 400 } };
      },
    });
    await mockCtx.soulmate.ready;
    await saveConfigAuto(mockCtx.soulmate.home, {
      proactive: { intentEnabled: true, dreamLlmEnabled: false, distillLlmEnabled: false, dailyDiary: false },
      extensions: { biliAutoSurfEnabled: false },
    });
    const res = await mockCtx.soulmate.runProactiveTick(AT);
    assert.equal(res.intent.ran, true, JSON.stringify(res.intent));
    assert.equal(res.intent.action, 'speak');
    // No host controller in the mock → delivery degrades to the activity-event tier.
    assert.ok(['event', 'host'].includes(res.intent.via), res.intent.via);

    const ledgerRaw = await readFile(join(mockCtx.soulmate.home.logsDir, 'intent-events.jsonl'), 'utf8');
    assert.ok(ledgerRaw.includes('"status":"consumed"'));
    const decisionsRaw = await readFile(join(mockCtx.soulmate.home.logsDir, 'intent-decisions.jsonl'), 'utf8');
    assert.ok(decisionsRaw.includes('"action":"speak"'));
    dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('intent wiring: intent off keeps the legacy direct-delivery path untouched', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sm-intent-off-'));
  try {
    const { mockCtx, dispose, prompts } = await bootWith(dir, { cfgPatch: { intentEnabled: false } });
    const res = await mockCtx.soulmate.runProactiveTick(AT);
    assert.equal(res.plan.speak, true);
    assert.ok(['event', 'host', 'silent'].includes(res.delivery.via));
    assert.equal(res.intent.ran, false);
    assert.equal(res.intent.reason, 'disabled');
    assert.equal(prompts.filter((p) => p.kind === 'intent-llm').length, 0);
    dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('growth snapshot: weekly gate appends one traits+graph row to growth.jsonl', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sm-growth-'));
  try {
    const { mockCtx, dispose } = await bootWith(dir, { cfgPatch: { intentEnabled: false } });
    const res = await mockCtx.soulmate.runProactiveTick(AT);
    assert.equal(res.gate.ran, true, JSON.stringify(res.gate));
    const raw = await readFile(join(mockCtx.soulmate.home.logsDir, 'growth.jsonl'), 'utf8');
    const row = JSON.parse(raw.split('\n').filter(Boolean)[0]);
    assert.ok(row.week.match(/^\d{4}-W\d{2}$/));
    assert.equal(typeof row.traits, 'object');
    assert.equal(typeof row.nodes, 'number');
    // Same week never re-snapshots.
    await mockCtx.soulmate.runProactiveTick(AT + 3600_000);
    const raw2 = await readFile(join(mockCtx.soulmate.home.logsDir, 'growth.jsonl'), 'utf8');
    assert.equal(raw2.split('\n').filter(Boolean).length, 1);
    dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});