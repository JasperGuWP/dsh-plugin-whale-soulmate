import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  appendEngagePhrase,
  composeVisionTimelineSummary,
  evenIndices,
  formatVisionTakeaway,
  parseVisionTimelineText,
  pickVisionFrames,
  sampleTimes,
} from '../packages/soulmate-bili/vision-summary.mjs';

test('evenIndices caps and spreads', () => {
  assert.deepEqual(evenIndices(4, 16), [0, 1, 2, 3]);
  assert.equal(evenIndices(100, 16).length, 16);
  assert.equal(evenIndices(100, 16)[0], 0);
  assert.equal(evenIndices(100, 16)[15], 99);
});

test('sampleTimes respects density', () => {
  const { times, everySec } = sampleTimes(120, 30);
  assert.equal(everySec, 30);
  assert.ok(times.includes(0));
  assert.ok(times.length >= 4);
});

test('pickVisionFrames prefers live over storyboard and caps at 16', () => {
  const live = Array.from({ length: 40 }, (_, i) => ({
    tSec: i * 15,
    url: `https://example.test/live/${i}.jpg`,
  }));
  const board = [{ tSec: 0, imageUrl: 'https://example.test/board/0.jpg' }];
  const { frames, source } = pickVisionFrames({
    liveFrames: live,
    storyboardFrames: board,
    durationSec: 600,
    everySec: 15,
    maxFrames: 16,
  });
  assert.equal(source, 'live');
  assert.ok(frames.length <= 16);
  assert.ok(frames.every((f) => f.url.includes('/live/')));
});

test('pickVisionFrames falls back to storyboard', () => {
  const board = [
    { tSec: 0, imageUrl: 'https://example.test/b0.jpg' },
    { tSec: 30, imageUrl: 'https://example.test/b1.jpg' },
  ];
  const { frames, source } = pickVisionFrames({
    liveFrames: [],
    storyboardFrames: board,
    durationSec: 60,
    everySec: 30,
  });
  assert.equal(source, 'storyboard');
  assert.equal(frames.length, 2);
});

test('parse + format vision takeaway', () => {
  const raw = `总览：讲 Python 整数与浮点比较
时间线：
· 00:00–00:40 开场：提出 1==1.0 问题
· 00:40–01:20 演示：打印比较结果
观感：短小清楚`;
  const parsed = parseVisionTimelineText(raw);
  assert.match(parsed.overview, /Python/);
  assert.ok(parsed.chapters.length >= 2);
  const takeaway = formatVisionTakeaway({ ...parsed, worthScore: 7 });
  assert.match(takeaway, /讲了什么：/);
  assert.match(takeaway, /时间线：/);
  assert.match(takeaway, /观感：/);
  assert.doesNotMatch(takeaway, /京都|米其林/);
});

test('appendEngagePhrase merges actions', () => {
  const base = '讲了什么：xxx\n观感：一般';
  assert.equal(appendEngagePhrase(base, { like: true, favorite: true }), `${base}｜已点赞、已收藏`);
  assert.equal(appendEngagePhrase(`${base}｜已点赞`, { like: true, comment: true }), `${base}｜已点赞、已评论`);
  assert.match(appendEngagePhrase(base, { skippedReasons: ['score-low'] }), /仅观看/);
});

test('composeVisionTimelineSummary success and soft fails', async () => {
  const digest = {
    title: 'python基础练习题：整数等于浮点数吗',
    desc: '入门比较',
    durationSec: 90,
    worthScore: 8,
    liveFrameStills: [
      { tSec: 0, url: 'https://example.test/a.jpg' },
      { tSec: 30, url: 'https://example.test/b.jpg' },
      { tSec: 60, url: 'https://example.test/c.jpg' },
    ],
  };
  const ok = await composeVisionTimelineSummary({
    digest,
    everySec: 30,
    visionSummarize: async ({ images, prompt }) => {
      assert.ok(images.length >= 1);
      assert.match(prompt, /python/i);
      return {
        text: `总览：整数与浮点相等性\n时间线：\n· 00:00–00:30 提问\n· 00:30–01:00 验证\n观感：清楚`,
      };
    },
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.channel, 'ok:live');
  assert.match(ok.takeaway, /整数/);

  const noFrames = await composeVisionTimelineSummary({
    digest: { title: 'x', storyboardFrames: [], liveFrameStills: [] },
    visionSummarize: async () => ({ text: 'x' }),
  });
  assert.equal(noFrames.channel, 'skip:no-frames');

  const noCb = await composeVisionTimelineSummary({ digest });
  assert.equal(noCb.channel, 'skip:no-vision-model');

  const boom = await composeVisionTimelineSummary({
    digest,
    visionSummarize: async () => { throw new Error('timeout'); },
  });
  assert.equal(boom.channel, 'skip:vision-error');
});
