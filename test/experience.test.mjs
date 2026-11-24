// Phase-4 experience layer: outcome pairing, aggregation, lesson composition, wiring.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  aggregateExperience,
  composeExperienceNotes,
  experiencePromptBlock,
  mergeExperienceNotes,
  pairOutcomes,
  periodOf,
} from '../packages/soulmate-core/experience.mjs';
import { composeIntentPrompt } from '../packages/soulmate-core/intent.mjs';
import { apply } from '../index.js';
import { saveConfigAuto, appendJsonl } from '../packages/soulmate-core/state.mjs';

const T0 = Date.parse('2026-11-23T10:00:00Z'); // 18:00 UTC+8 evening
const iso = (ms) => new Date(ms).toISOString();

test('experience: pairing marks warm / answered / cold by his next turn', () => {
  const attempts = [
    { at: iso(T0), action: 'speak', eventKind: 'slot', hour: 18 },
    { at: iso(T0 + 3600_000), action: 'share', eventKind: 'video-found', hour: 19 },
    { at: iso(T0 + 7200_000), action: 'speak', eventKind: 'slot', hour: 20 },
    { at: iso(T0 + 9000_000), action: 'silent', eventKind: 'slot', hour: 20 },
  ];
  const interactions = [iso(T0 + 3 * 60_000), iso(T0 + 3600_000 + 20 * 60_000)];
  const out = pairOutcomes(attempts, interactions);
  assert.equal(out.length, 3); // silent excluded
  assert.equal(out[0].outcome, 'warm');
  assert.equal(out[1].outcome, 'answered');
  assert.equal(out[2].outcome, 'cold');
});

test('experience: aggregation needs ≥3 samples and buckets by kind × period', () => {
  const mk = (i, outcome) => ({ at: iso(T0 + i * 86400_000), action: 'speak', eventKind: 'slot', hour: 23, outcome });
  const outcomes = [mk(0, 'cold'), mk(1, 'cold'), mk(2, 'cold'), mk(3, 'warm'),
    { at: iso(T0), action: 'speak', eventKind: 'slot', hour: 9, outcome: 'warm' }];
  const stats = aggregateExperience(outcomes);
  assert.equal(stats.length, 1); // the single morning sample is noise
  assert.equal(stats[0].period, 'night');
  assert.equal(stats[0].coldRate, 0.75);
  assert.equal(periodOf(23), 'night');
  assert.equal(periodOf(9), 'morning');
});

test('experience: lessons are first-person memory, not rules; prompt block says so', () => {
  const stats = [{ kind: 'slot', period: 'night', total: 4, warm: 1, answered: 0, cold: 3, coldRate: 0.75, warmRate: 0.25 }];
  const notes = composeExperienceNotes(stats, { persona: { selfRef: '本鱼' } });
  assert.equal(notes.length, 1);
  assert.match(notes[0].text, /本鱼/);
  assert.match(notes[0].text, /4 次里 3 次/);
  assert.equal(notes[0].tone, 'restraint');
  const block = experiencePromptBlock(notes);
  assert.match(block, /相处经验/);
  assert.match(block, /不是命令/);
  assert.match(block, /判断仍归你/);
  // and it rides the intent prompt
  const prompt = composeIntentPrompt({ events: [], experience: block, persona: {} });
  assert.match(prompt, /相处经验/);
});

test('experience: merge updates in place, accumulates revisions, unlearns stale lessons', () => {
  const old = [{ key: 'slot|night', text: '旧结论', evidence: 4, firstLearnedAt: iso(T0 - 60 * 86400_000), updatedAt: iso(T0 - 40 * 86400_000), revisions: 2 }];
  const fresh = [{ key: 'slot|night', text: '新结论', evidence: 6, tone: 'restraint' }];
  const merged = mergeExperienceNotes(old, fresh, T0);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].text, '新结论');
  assert.equal(merged[0].revisions, 3);
  assert.equal(merged[0].firstLearnedAt, old[0].firstLearnedAt);
  // a lesson absent from fresh stats for >30 days decays out
  const decayed = mergeExperienceNotes(old, [], T0);
  assert.equal(decayed.length, 0);
});

// --- wiring ------------------------------------------------------------------

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

test('experience wiring: weekly pass learns from real decision+interaction logs; intent prompt carries the lesson', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sm-exp-'));
  try {
    const prompts = [];
    const { mockCtx, routes, dispose } = createMockCtx(dir);
    apply(mockCtx, {
      listLlmModels: async () => [{ id: 'cheap-flash', pricing: { input: 1 } }],
      llmOneShot: async ({ prompt, kind }) => {
        prompts.push({ prompt, kind });
        return { text: '{"action":"silent","reason":"先安静"}', usage: { totalTokens: 300 } };
      },
    });
    await mockCtx.soulmate.ready;
    const home = mockCtx.soulmate.home;
    await saveConfigAuto(home, {
      proactive: { intentEnabled: true, dreamLlmEnabled: false, distillLlmEnabled: false, dailyDiary: false, experienceLlmEnabled: false },
      extensions: { biliAutoSurfEnabled: false },
    });

    // Seed history: three night slot attempts he ignored, one morning share he answered.
    const nightBase = Date.parse('2026-11-16T15:30:00Z'); // 23:30 local
    for (let i = 0; i < 3; i += 1) {
      await appendJsonl(join(home.logsDir, 'intent-decisions.jsonl'), {
        at: iso(nightBase + i * 86400_000), action: 'speak', eventKind: 'slot', delivered: 'event', hour: 23,
      });
    }
    const morningAt = Date.parse('2026-11-17T00:30:00Z'); // 08:30 local
    await appendJsonl(join(home.logsDir, 'intent-decisions.jsonl'), {
      at: iso(morningAt), action: 'share', eventKind: 'video-found', delivered: 'event', hour: 8,
    });
    await appendJsonl(join(home.logsDir, 'interactions.jsonl'), { at: iso(morningAt + 4 * 60_000), action: 'chat' });
    // need ≥3 morning samples for a lesson; add two more warm shares
    for (let i = 1; i < 3; i += 1) {
      const at = morningAt + i * 86400_000;
      await appendJsonl(join(home.logsDir, 'intent-decisions.jsonl'), {
        at: iso(at), action: 'share', eventKind: 'video-found', delivered: 'event', hour: 8,
      });
      await appendJsonl(join(home.logsDir, 'interactions.jsonl'), { at: iso(at + 3 * 60_000), action: 'chat' });
    }

    // Weekly gate tick → experience pass runs.
    const res = await mockCtx.soulmate.runProactiveTick(Date.parse('2026-11-23T10:00:00Z'));
    assert.equal(res.gate.ran, true);
    assert.equal(res.experience.ran, true, JSON.stringify(res.experience));
    assert.ok(res.experience.learned >= 1);

    const store = JSON.parse(await readFile(join(home.rootDir, 'memory', 'experience.json'), 'utf8'));
    assert.ok(store.notes.some((n) => n.key === 'slot|night' && n.tone === 'restraint'));
    assert.ok(store.notes.some((n) => n.key === 'video-found|morning' && n.tone === 'encourage'));

    // Route exposes the lessons.
    const api = body(await routes.get('GET /dsh-soulmate/api/experience')({ method: 'GET', url: '/x', query: new URLSearchParams() }));
    assert.equal(api.ok, true);
    assert.ok(api.notes.length >= 2);

    // A later intent decision (past the gap guard) carries the lesson in its prompt.
    await mockCtx.soulmate.runProactiveTick(Date.parse('2026-11-23T13:00:00Z')); // 21:00 local, no slot but...
    // force an opportunity: retain a promise due today so the gate has events
    await mockCtx.soulmate.retainFact({ topic: '约定', content: '周末陪看片', importance: 4 });
    await mockCtx.soulmate.runProactiveTick(Date.parse('2026-11-24T04:30:00Z')); // 12:30 local lunch slot
    const intentPrompt = prompts.filter((p) => p.kind === 'intent-llm').pop();
    assert.ok(intentPrompt, 'an intent call happened');
    assert.match(intentPrompt.prompt, /相处经验/);

    // Idempotent per week: rerunning the gate week does not re-learn.
    const again = await mockCtx.soulmate.runProactiveTick(Date.parse('2026-11-23T10:00:00Z') + 3600_000);
    assert.equal(again.experience.reason, 'gate-not-due');

    dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});