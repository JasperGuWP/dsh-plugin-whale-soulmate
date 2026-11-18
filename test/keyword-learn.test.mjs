import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  extractKeywordsFromText,
  normalizeKeywordList,
  proposeSurfKeywords,
  appendLearnedKeywords,
  mergeSurfKeywords,
} from '../packages/soulmate-bili/keyword-learn.mjs';

test('extractKeywordsFromText pulls CN/EN topic tokens', () => {
  const ks = extractKeywordsFromText('我想看量子计算和 Rust 编程，顺便关注国际新闻');
  assert.ok(ks.some((k) => /量子|Rust|国际新闻|编程/i.test(k)));
  assert.ok(!ks.includes('我想'));
});

test('proposeSurfKeywords keeps seed and promotes cued chat interests', () => {
  const next = proposeSurfKeywords({
    seed: ['AI', '编程'],
    current: ['AI', '编程', '科技'],
    chatTexts: [
      '你好',
      '最近想看量子计算入门，有没有推荐',
      '国际新闻也继续盯着',
      '专属窗里也聊了 Rust 异步',
    ],
    factSnippets: ['兴趣：硬件茶谈 装机'],
    max: 6,
  });
  assert.ok(next.includes('AI') || next.includes('编程'));
  assert.ok(next.some((k) => /量子|国际新闻|硬件|装机|Rust/.test(k)));
  assert.equal(normalizeKeywordList(next, 6).length, next.length);
  assert.ok(next.length <= 6);
});

test('junk internal tokens never become keywords', () => {
  const ks = normalizeKeywordList(['identity', 'following', 'system-reminder', 'worthScore', 'bvid', 'https', 'www.bilibili.com/vide', '编程']);
  assert.deepEqual(ks, ['编程']);
});

test('appendLearnedKeywords dedupes, appends, caps at 20', () => {
  const existing = ['AI', '科技'];
  const next = appendLearnedKeywords(existing, ['科技', '编程', ...Array.from({ length: 25 }, (_, i) => '话题' + i)], 20);
  assert.equal(next.length, 20);
  assert.equal(next[0], 'AI');
  assert.equal(next[1], '科技');
  assert.equal(new Set(next.map((k) => k.toLowerCase())).size, next.length);
});

test('mergeSurfKeywords keeps manual first and never drops it', () => {
  const merged = mergeSurfKeywords(['编程', '科技'], ['AI', '编程', '数码']);
  assert.deepEqual(merged, ['编程', '科技', 'AI', '数码']);
});

test('refreshSurfKeywords: no chat → no learning, manual untouched', async () => {
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { saveConfigAuto, loadConfig, resolveSoulmateHome } = await import('../packages/soulmate-core/state.mjs');
  const { refreshSurfKeywords } = await import('../packages/soulmate-bili/keyword-learn.mjs');
  const home = resolveSoulmateHome(await mkdtemp(join(tmpdir(), 'sm-kw-')));
  await saveConfigAuto(home, { extensions: { biliKeywords: ['AI', '编程'], biliLearnedKeywords: [], onboardingCompleted: true } });
  const r = await refreshSurfKeywords(home, {});
  assert.equal(r.ran, false);
  assert.equal(r.reason, 'no-chat');
  const conf = await loadConfig(home);
  assert.deepEqual(conf.extensions.biliKeywords, ['AI', '编程'], 'manual list untouched');
  assert.deepEqual(conf.extensions.biliLearnedKeywords, [], 'no learned entries written');
});
