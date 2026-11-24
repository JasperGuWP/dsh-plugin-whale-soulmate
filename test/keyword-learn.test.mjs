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

test('mergeSurfKeywords scrubs legacy polluted config (system words on both sides)', () => {
  const merged = mergeSurfKeywords(
    ['AI', '科技', '编程'],
    ['soulmate-wake', 'current', 'describes', 'information', 'of', 'your', 'system-reminder', 'GTA6'],
  );
  assert.deepEqual(merged, ['AI', '科技', '编程', 'GTA6']);
  const seeded = mergeSurfKeywords(['编程', 'identity', 'following', 'system-reminder'], ['of', 'your']);
  assert.deepEqual(seeded, ['编程']);
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

test('keyword-learn: host plumbing lines never become interest keywords', async () => {
  const { proposeSurfKeywords, isPlumbingText, normalizeKeywordList } = await import('../packages/soulmate-bili/keyword-learn.mjs');
  assert.equal(isPlumbingText('<system-reminder>你是视频内容分析助手，请根据以下画面…</system-reminder>'), true);
  assert.equal(isPlumbingText('Time sampled while preparing turn 7, step 1: 2026-11-24'), true);
  assert.equal(isPlumbingText('【Soulmate 插件·主动开口·勿复述】'), true);
  assert.equal(isPlumbingText('想看装机翻车合集'), false);
  const next = proposeSurfKeywords({
    seed: ['AI'],
    chatTexts: [
      '你是视频内容分析助手，请根据以下时间线输出总结 mm ss 标题',
      '<system-reminder>current session describes information of your workspace</system-reminder>',
      '最近想看装机教程',
    ],
  });
  for (const junk of ['mm', 'ss', '标题', '请根据', '你是视频内容分析', 'current', 'describes']) {
    assert.ok(!next.includes(junk), `junk keyword leaked: ${junk}`);
  }
  assert.ok(next.some((k) => k.includes('装机')), 'real interest survives');
  // stop-list catches legacy pollution on merge
  assert.deepEqual(normalizeKeywordList(['mm', 'ss', '标题', '助手', 'AI']), ['AI']);
});
