import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  extractKeywordsFromText,
  normalizeKeywordList,
  proposeSurfKeywords,
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
