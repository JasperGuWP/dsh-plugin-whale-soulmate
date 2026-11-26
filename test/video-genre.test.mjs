// Genre-aware「观感」: a drama is judged on story, a funny edit on which bits are
// funny, a news clip on the events — not one generic "值不值得看" paragraph.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GENRE_RULES,
  classifyVideoGenre,
  opinionInstruction,
} from '../packages/soulmate-bili/video-genre.mjs';
import {
  VISION_OPINION_MAX_CHARS,
  buildVisionPrompt,
  formatVisionTakeaway,
  visionFrameBudget,
} from '../packages/soulmate-bili/vision-summary.mjs';

test('genre: the 153-minute zombie drama compilation classifies as 剧情', () => {
  const g = classifyVideoGenre({
    title: '153分钟超长大合集！【末日来临，我从吃丧尸开始成神！】第1季+第2季完整版【AI全民制作人】',
    desc: '这是第一季+第二季的完整版大合集。',
    tags: ['AI全民制作人', '影视剪辑'],
  });
  assert.equal(g.id, 'drama');
  assert.equal(g.label, '剧情/短剧');
  assert.match(g.opinion, /剧情|人物动机|反转/);
});

test('genre: funny / news / knowledge / review are recognised from local metadata', () => {
  assert.equal(classifyVideoGenre({ title: '沙雕网友整活名场面合集，笑死我了' }).id, 'funny');
  assert.equal(classifyVideoGenre({ title: '今日国际时事：停火谈判最新进展' }).id, 'news');
 assert.ok(['knowledge', 'tech'].includes(classifyVideoGenre({ title: '一口气吃透整个AI产业：从大模型到资本' }).id));
  assert.equal(classifyVideoGenre({ title: '新手机实测开箱：值不值得买' }).id, 'review');
  assert.equal(classifyVideoGenre({ title: '深夜食堂探店：这家烧烤翻车了' }).id, 'food');
  assert.equal(classifyVideoGenre({ title: '翻唱《起风了》现场版' }).id, 'music');
  assert.equal(classifyVideoGenre({ title: '' }).id, 'other');
});

test('genre: prompt carries type-specific opinion + timeline rules and a 500-char cap', () => {
  const drama = buildVisionPrompt({
    title: '末日丧尸第1季+第2季完整版合集',
    durationSec: 153 * 60,
    frames: [{ tSec: 0, label: '00:00' }],
  });
  assert.match(drama, /按【类型：剧情\/短剧】/);
  assert.match(drama, /主线是什么|人物动机|反转/);
  assert.match(drama, /按剧情节点切章/);
  assert.match(drama, /8–16 段/);
  assert.match(drama, /不超过 500 字/);
  assert.match(drama, /3–6 句/);
  assert.match(drama, /必须覆盖全片/);

  const funny = buildVisionPrompt({ title: '沙雕整活名场面，笑死', frames: [] });
  assert.match(funny, /按【类型：搞笑\/整活】/);
  assert.match(funny, /哪个梗最好笑|笑点/);

  const news = buildVisionPrompt({ title: '今日国际时事：停火谈判', frames: [] });
  assert.match(news, /按【类型：新闻\/时事】/);
  assert.match(news, /重要的时事|关键数字/);

  // Short videos keep 3–6 chapters; long compilations get 8–16.
  assert.match(funny, /3–6 段/);
  assert.match(drama, /8–16 段/);
});

test('genre: opinion is truncated to 500 chars, and long-video frame budget is batch-aligned', () => {
  const long = '好'.repeat(800);
  const take = formatVisionTakeaway({ overview: '总览', chapters: [], opinion: long, worthScore: 14 });
  const op = (take.split('\n').find((l) => l.startsWith('观感：')) || '').replace(/^观感：/, '');
  assert.ok(op.length <= VISION_OPINION_MAX_CHARS + 1, `观感 length ${op.length}`);

  assert.equal(visionFrameBudget(153 * 60), 112); // 7 batches × 16
  assert.equal(visionFrameBudget(153 * 60, { deep: true }), 160); // 10 batches × 16
  assert.equal(visionFrameBudget(30 * 60), 160); // short videos unchanged
  assert.equal(visionFrameBudget(65 * 60), 48); // 3 batches
});

test('genre: every rule has an opinion and timeline focus (no generic-only types)', () => {
  for (const rule of GENRE_RULES) {
    assert.ok(rule.id && rule.label, rule.id);
    assert.ok(rule.opinion.length >= 20, `${rule.id} opinion too short`);
    assert.ok(rule.timeline.length >= 10, `${rule.id} timeline too short`);
  }
  assert.match(opinionInstruction({ label: '剧情/短剧', opinion: '说剧情' }, { voice: '嘴硬', maxChars: 500 }), /不超过 500 字/);
});