import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTEXT_BUDGET,
  classifyHeading,
  describeBudget,
  estimateTokens,
  fitMemoryDigest,
  measurePromptBudget,
  splitPromptBlocks,
} from '../packages/soulmate-core/budget.mjs';
import { buildPersonaSystemPrompt } from '../packages/soulmate-core/persona.mjs';

test('budget: the published split stays the one the design promised', () => {
  assert.deepEqual(CONTEXT_BUDGET, { identity: 15, relationship: 10, memory: 45, reserved: 30 });
  assert.equal(CONTEXT_BUDGET.identity + CONTEXT_BUDGET.relationship + CONTEXT_BUDGET.memory + CONTEXT_BUDGET.reserved, 100);
});

test('budget: token estimate is stable and treats CJK as one token per char', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens('记忆'), 2);
  // 2 CJK + 4 latin chars ≈ 2 + 1 tokens.
  assert.equal(estimateTokens('记忆abcd'), 3);
  // An emoji is one code point, not two UTF-16 halves.
  assert.equal(estimateTokens('🐳'), 1);
});

test('budget: headings route into the right block', () => {
  assert.equal(classifyHeading('你的身份（Soulmate 伴侣人设）'), 'identity');
  assert.equal(classifyHeading('五维性格'), 'identity');
  assert.equal(classifyHeading('当前状态'), 'identity');
  assert.equal(classifyHeading('关系阶段'), 'relationship');
  assert.equal(classifyHeading('不变量（永久冻结）'), 'relationship');
  assert.equal(classifyHeading('记忆'), 'memory');
  assert.equal(classifyHeading('Soulmate 记忆工具使用守则'), 'memory');
});

test('budget: a real persona prompt splits into all three blocks', () => {
  // index.mjs appends the memory guide to the persona prompt; the budget must see the
  // combined text, since that is what actually goes to the model.
  const prompt =
    buildPersonaSystemPrompt(
      { persona: { preset: 'rice-whale', name: '小汐', callUser: '搭档' }, appearance: {} },
      { mood: 'happy', energy: 80, affinity: 40, activity: '正在写代码' },
    ) + '\n\n## Soulmate 记忆工具使用守则\n- 先翻小本本再回答。';
  const blocks = splitPromptBlocks(prompt);
  for (const key of ['identity', 'relationship', 'memory']) {
    assert.ok(blocks[key].length > 0, `${key} block must not be empty`);
  }
  // Nothing may be silently dropped or duplicated: every non-empty line lands in exactly
  // one bucket. Order changes by design (relationship readings are lifted out of the
  // "当前状态" block), so this is a multiset comparison.
  const rejoinLines = [blocks.identity, blocks.relationship, blocks.memory, blocks.other]
    .filter(Boolean)
    .join('\n')
    .split('\n')
    .filter((l) => l.trim())
    .sort();
  const promptLines = prompt.split('\n').filter((l) => l.trim()).sort();
  assert.deepEqual(rejoinLines, promptLines);
});

test('budget: only the block that can grow without bound is a hard ceiling', () => {
  const memoryHeavy = [
    '## 你的身份',
    '你是鱼。',
    '## 记忆',
    ...Array.from({ length: 40 }, (_, i) => `- 事实第 ${i} 条：用户喜欢冰美式`),
  ].join('\n');
  const m = measurePromptBudget(memoryHeavy);
  assert.equal(m.ok, true);
  assert.ok(m.measured.memory.share > m.measured.identity.share);
  assert.ok(m.overBudget.includes('memory'), 'a memory-heavy prompt must be flagged');
  assert.equal(m.withinBudget, false);
  assert.match(m.note, /记忆占比偏高/);

  // Identity is authored constant text: its share shrinking as memory grows is not a
  // failure, so it must never be reported as over budget.
  assert.ok(!m.overBudget.includes('identity'));
  assert.ok(!m.overBudget.includes('relationship'));

  const balanced = '## 你的身份\n你是鱼。\n## 记忆\n- 一条\n## 关系\n- 亲近';
  const b = measurePromptBudget(balanced);
  assert.equal(b.totalTokens > 0, true);
  assert.equal(b.withinBudget, true);
});

test('budget: an empty prompt is measured honestly instead of dividing by zero', () => {
  const m = measurePromptBudget('');
  assert.equal(m.totalTokens, 0);
  assert.equal(m.measured.memory.share, 0);
  assert.equal(m.withinBudget, true);
  assert.match(m.note, /还没有可统计/);
});

test('budget: the recall digest is trimmed to its character ceiling from the tail', () => {
  const items = [
    { id: 'a', text: '最重要的一条', score: 9 },
    { id: 'b', text: '次重要的一条', score: 5 },
    { id: 'c', text: '最不重要的一条', score: 1 },
  ];
  const render = (list) => list.map((i) => i.text).join('\n');
  // Each item renders to 6 chars; joined by newlines three items are 20 chars.
  const one = fitMemoryDigest(items, { maxChars: 6, render });
  assert.deepEqual(one.items.map((i) => i.id), ['a']);
  assert.equal(one.dropped, 2);
  assert.equal(one.chars, 6);

  const two = fitMemoryDigest(items, { maxChars: 13, render });
  assert.deepEqual(two.items.map((i) => i.id), ['a', 'b']);
  assert.equal(two.dropped, 1);

  const all = fitMemoryDigest(items, { maxChars: 21, render });
  assert.equal(all.dropped, 0);

  // No ceiling: keep everything rather than silently truncating.
  assert.equal(fitMemoryDigest(items, { render }).items.length, 3);
});

test('budget: the panel snapshot carries the measurement, not only the percentages', () => {
  const snap = describeBudget('## 你的身份\n你是鱼。\n## 记忆\n- 一条\n## 关系\n- 亲近');
  assert.equal(snap.identity, 15);
  assert.equal(snap.relationship, 10);
  assert.equal(snap.memory, 45);
  assert.equal(snap.reserved, 30);
  assert.ok(snap.measured.memory.tokens >= 0);
  assert.equal(typeof snap.withinBudget, 'boolean');
  assert.match(snap.note, /记忆占比正常|还没有可统计/);
});

test('budget: an empty prompt still reports the design split as the target', () => {
  const snap = describeBudget('');
  assert.equal(snap.totalTokens, 0);
  assert.equal(snap.identity, 15);
  assert.equal(snap.memory, 45);
  assert.equal(snap.withinBudget, true);
});