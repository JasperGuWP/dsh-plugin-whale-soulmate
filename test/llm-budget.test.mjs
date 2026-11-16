import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildUsageRow,
  checkKindDailyCap,
  localDateKey,
  AUTO_KINDS,
} from '../packages/soulmate-core/usage.mjs';
import { rankModelsCheapest, resolveLlmModel } from '../packages/soulmate-core/llm-model-pick.mjs';
import {
  composeDreamLlmPrompt,
  parseDreamLlmReply,
  composeDistillLlmPrompt,
  parseDistillLlmReply,
} from '../packages/soulmate-core/proactive.mjs';

const TZ = 480;
const noon = () => {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  return d.getTime();
};

test('AUTO_KINDS includes dream-llm and distill-llm', () => {
  assert.ok(AUTO_KINDS.includes('dream-llm'));
  assert.ok(AUTO_KINDS.includes('distill-llm'));
});

test('checkKindDailyCap: empty ledger has full remaining', () => {
  const r = checkKindDailyCap({
    rows: [],
    kind: 'dream-llm',
    cap: 300_000,
    nowMs: noon(),
    tzOffsetMinutes: TZ,
  });
  assert.equal(r.allow, true);
  assert.equal(r.used, 0);
  assert.equal(r.remaining, 300_000);
});

test('checkKindDailyCap: accumulates only the matching kind', () => {
  const nowMs = noon();
  const rows = [
    buildUsageRow({ kind: 'dream-llm', trigger: 'auto', usage: { totalTokens: 1000, real: true }, nowMs }),
    buildUsageRow({ kind: 'proactive', trigger: 'auto', usage: { totalTokens: 50_000, real: true }, nowMs }),
    buildUsageRow({ kind: 'distill-llm', trigger: 'auto', usage: { totalTokens: 2000, real: true }, nowMs }),
  ];
  const dream = checkKindDailyCap({ rows, kind: 'dream-llm', cap: 3000, nowMs, tzOffsetMinutes: TZ });
  assert.equal(dream.used, 1000);
  assert.equal(dream.remaining, 2000);
  assert.equal(dream.allow, true);
  const distill = checkKindDailyCap({ rows, kind: 'distill-llm', cap: 2000, nowMs, tzOffsetMinutes: TZ });
  assert.equal(distill.allow, false);
  assert.equal(distill.remaining, 0);
});

test('checkKindDailyCap: zero cap refuses', () => {
  const r = checkKindDailyCap({ rows: [], kind: 'dream-llm', cap: 0, nowMs: noon(), tzOffsetMinutes: TZ });
  assert.equal(r.allow, false);
  assert.equal(r.remaining, 0);
});

test('checkKindDailyCap: next local day resets used', () => {
  const today = noon();
  const yesterday = today - 86_400_000;
  const rows = [
    buildUsageRow({ kind: 'dream-llm', trigger: 'auto', usage: { totalTokens: 300_000, real: true }, nowMs: yesterday }),
  ];
  // Force dateKey on the old row to yesterday's key
  rows[0].dateKey = localDateKey(yesterday, TZ);
  const r = checkKindDailyCap({
    rows,
    kind: 'dream-llm',
    cap: 300_000,
    nowMs: today,
    tzOffsetMinutes: TZ,
  });
  assert.equal(r.allow, true);
  assert.equal(r.used, 0);
  assert.equal(r.remaining, 300_000);
});

test('rankModelsCheapest: priced models beat heuristics', () => {
  const ranked = rankModelsCheapest([
    { id: 'big', pricing: { input: 10 } },
    { id: 'cheap-flash', pricing: { input: 1 } },
    { id: 'mid-flash' },
  ]);
  assert.equal(ranked[0]._pickId, 'cheap-flash');
});

test('rankModelsCheapest: flash before generic when unpriced', () => {
  const ranked = rankModelsCheapest([{ id: 'gpt-heavy' }, { id: 'x-flash-1' }, { id: 'y-mini' }]);
  assert.equal(ranked[0]._pickId, 'x-flash-1');
});

test('resolveLlmModel: empty preferred picks cheapest; missing preferred falls back', () => {
  const models = [{ id: 'b-flash' }, { id: 'a-opus' }];
  const auto = resolveLlmModel({ models, preferredId: '' });
  assert.equal(auto.id, 'b-flash');
  assert.equal(auto.auto, true);
  const pinned = resolveLlmModel({ models, preferredId: 'a-opus' });
  assert.equal(pinned.id, 'a-opus');
  assert.equal(pinned.auto, false);
  const missing = resolveLlmModel({ models, preferredId: 'gone' });
  assert.equal(missing.id, 'b-flash');
});

test('dream LLM prompt + parse', () => {
  const { prompt, sourceFactIds } = composeDreamLlmPrompt({
    facts: [{ id: 'f1', text: '喜欢螺蛳粉' }],
    persona: { name: '小海', callUser: '老板' },
    dateKey: '2026-11-11',
  });
  assert.match(prompt, /小海/);
  assert.match(prompt, /螺蛳粉/);
  assert.deepEqual(sourceFactIds, ['f1']);
  const page = parseDreamLlmReply('# 小海的梦 · 2026-11-11\n\n今晚梦见螺蛳粉。', {
    dateKey: '2026-11-11',
    displayName: '小海',
    sourceFactIds,
  });
  assert.equal(page.slug, 'dream-2026-11-11');
  assert.match(page.content, /螺蛳粉/);
});

test('distill LLM parse', () => {
  const built = composeDistillLlmPrompt({ cluster: { title: '偏好 主题蒸馏', category: 'preference', sourceFactIds: ['a'] } });
  assert.match(built.prompt, /TITLE:/);
  const parsed = parseDistillLlmReply('TITLE: 口味偏好\nSUMMARY: 喜欢辣的面食');
  assert.equal(parsed.title, '口味偏好');
  assert.match(parsed.summary, /辣/);
});
