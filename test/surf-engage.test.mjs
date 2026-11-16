import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { sanitizeCommentText, decideSurfEngageHeuristic, composeSurfSummary } from '../packages/soulmate-bili/engage.mjs';
import { scrubTranscriptNoise, composeVideoTakeaway } from '../packages/soulmate-bili/index.mjs';
import { appendSurfLog, listSurfLog, normalizeSurfEntry } from '../packages/soulmate-core/surf-log.mjs';

test('sanitizeCommentText blocks abuse and offsite promo', () => {
  assert.equal(sanitizeCommentText('加微信 abc').ok, false);
  assert.equal(sanitizeCommentText('你真是傻逼').ok, false);
  assert.equal(sanitizeCommentText('官方认证来了').ok, false);
  const ok = sanitizeCommentText('这个分镜好有意思');
  assert.equal(ok.ok, true);
  assert.match(ok.text, /分镜/);
});

test('decideSurfEngageHeuristic respects low score and talkative', () => {
  const low = decideSurfEngageHeuristic({
    digest: { worthScore: 3, title: '水' },
    persona: { traits: { talkative: 80 }, selfRef: '本鱼' },
  });
  assert.equal(low.like, false);
  assert.equal(low.comment, false);

  const high = decideSurfEngageHeuristic({
    digest: { worthScore: 16, title: '好片' },
    persona: { traits: { talkative: 70, clingy: 60 }, selfRef: '本鱼' },
  });
  assert.equal(high.like, true);
  assert.ok(high.favorite || high.comment || high.follow);
});

test('surf-log append + filter by platform engagement', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sm-surf-'));
  const home = { rootDir: dir };
  try {
    await appendSurfLog(home, {
      videoId: 'BVtest1',
      title: '仅看',
      url: 'https://www.bilibili.com/video/BVtest1',
      worthScore: 8,
      summary: '扫了一眼',
      actions: { like: false, favorite: false, comment: false, follow: false, skippedReasons: ['no-engage'] },
    }, 'bilibili');
    await appendSurfLog(home, {
      videoId: 'BVtest2',
      title: '互动',
      url: 'https://www.bilibili.com/video/BVtest2',
      worthScore: 15,
      summary: '喜欢',
      actions: { like: true, favorite: false, comment: true, commentText: '好看', follow: false },
    }, 'bilibili');

    const all = await listSurfLog(home, { platform: 'bilibili', filter: 'all', limit: 10 });
    assert.ok(all.length >= 2);
    const engaged = await listSurfLog(home, { platform: 'bilibili', filter: 'engaged', limit: 10 });
    assert.ok(engaged.some((e) => e.videoId === 'BVtest2'));
    assert.ok(!engaged.some((e) => e.videoId === 'BVtest1'));
    const watch = await listSurfLog(home, { platform: 'bilibili', filter: 'watch-only', limit: 10 });
    assert.ok(watch.some((e) => e.videoId === 'BVtest1'));

    const n = normalizeSurfEntry({ bvid: 'BVx', title: 't' }, 'bilibili');
    assert.equal(n.platform, 'bilibili');
    assert.equal(n.videoId, 'BVx');
    assert.match(composeSurfSummary({ title: 'A', author: 'U', worthScore: 12 }, { selfRef: '我' }), /评分 12/);
    assert.match(
      composeSurfSummary({
        title: 'A',
        author: 'U',
        worthScore: 17,
        takeaway: '讲了什么：装机流程演示。观感：信息密度还可以，值得记一笔。',
      }, { selfRef: '我' }),
      /讲了什么：装机流程/,
    );
    assert.doesNotMatch(
      composeSurfSummary({
        title: 'A',
        author: 'U',
        worthScore: 17,
        takeaway: '讲了什么：干净要点。',
        summary: '《A》投降 包村 拥 威信 扫',
      }, { selfRef: '我' }),
      /投降/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('scrubTranscriptNoise drops WeChat-ad OCR loops', () => {
  const junk = '敲重点 ↓↓↓敲重点 投降 包村 拥 威信 扫 投降 包村 拥 威信 扫 投降 包村 拥 威信 扫';
  assert.equal(scrubTranscriptNoise(junk), '');
  const mixed = '先装主板，再接电源。敲重点 ↓↓↓投降 包村 拥 威信 扫 然后走线收尾。';
  const cleaned = scrubTranscriptNoise(mixed);
  assert.match(cleaned, /主板/);
  assert.doesNotMatch(cleaned, /投降|威信/);
});

test('composeVideoTakeaway prefers cleaned content over spam subtitles', () => {
  const spam = '敲重点 ↓↓↓投降 包村 拥 威信 扫 投降 包村 拥 威信 扫';
  const out = composeVideoTakeaway({
    title: '【装机教程】全网最好的装机教程，没有之一',
    desc: '三维建模演示开箱、主板、散热到走线。',
    transcript: spam,
    tags: ['装机', '硬件'],
    worthScore: 17,
  });
  assert.match(out, /讲了什么/);
  assert.match(out, /观感/);
  assert.match(out, /三维建模|主板|装机/);
  assert.doesNotMatch(out, /投降|包村|威信/);
});
