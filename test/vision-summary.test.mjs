import assert from 'node:assert/strict';
import { test } from 'node:test';

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  appendEngagePhrase,
  composeVisionTimelineSummary,
  composeLongOverview,
  evenIndices,
  formatVisionTakeaway,
  materializeVisionImages,
  parseVisionTimelineText,
  pickVisionFrames,
  resolveLiveFrameDiskPath,
  sampleTimes,
  thinChapters,
  visionResponseLooksBlind,
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

test('resolveLiveFrameDiskPath + materialize reads local stills', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sm-vision-'));
  const bvid = 'BV1uKsM6BExK';
  const dir = join(root, 'cache', 'live-frames', bvid);
  await mkdir(dir, { recursive: true });
  // minimal JPEG (SOI + EOI)
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  await writeFile(join(dir, 'frame_001.jpg'), jpeg);
  const url = `/dsh-soulmate/api/live-frame?bvid=${bvid}&i=0`;
  assert.equal(resolveLiveFrameDiskPath(url, root), join(root, 'cache', 'live-frames', bvid, 'frame_001.jpg'));
  const ready = await materializeVisionImages([{ url, tSec: 0 }], { soulmateRoot: root });
  assert.equal(ready.length, 1);
  assert.match(ready[0].url, /^data:image\/jpeg;base64,/);
  // relative URL without root must not be passed through blindly
  const blind = await materializeVisionImages([{ url }], {});
  assert.equal(blind.length, 0);
});

test('visionResponseLooksBlind detects timestamp-only excuses', () => {
  assert.equal(visionResponseLooksBlind('总览：好看\n观感：还行'), false);
  assert.equal(
    visionResponseLooksBlind('仍无法判断——三个采样点只给了时间戳，没有画面描述。00:00 / 00:15'),
    true,
  );
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
  // 没帧但有字幕/文本通道:纯文本总结,不谎称看过画面(surf-e2e 同断言)
  assert.equal(noFrames.channel, 'ok:text-only');
  assert.equal(noFrames.ok, true);
  assert.equal(noFrames.textOnly, true);

  const noCb = await composeVisionTimelineSummary({ digest });
  assert.equal(noCb.channel, 'skip:no-vision-model');

  const boom = await composeVisionTimelineSummary({
    digest,
    visionSummarize: async () => { throw new Error('timeout'); },
  });
  assert.equal(boom.channel, 'skip:vision-error');

  const blind = await composeVisionTimelineSummary({
    digest,
    visionSummarize: async () => ({
      text: '总览：仍无法判断，三个采样点只给了时间戳，没有画面描述\n时间线：\n· 00:00 无画面\n观感：不可分析样本',
    }),
  });
  assert.equal(blind.ok, false);
  assert.equal(blind.error, 'blind-no-pixels');
});

test('composeVisionTimelineSummary: vision rejection falls back to text-infer timeline', async () => {
  const digest = {
    title: 'x', desc: 'd', durationSec: 90, worthScore: 8,
    liveFrameStills: [{ tSec: 0, url: 'u0' }, { tSec: 30, url: 'u30' }],
    hotComments: [{ text: '前面铺垫太长' }],
    peaks: [{ sec: 30, count: 42 }],
  };
  let calls = 0;
  const res = await composeVisionTimelineSummary({
    digest,
    visionSummarize: async ({ images }) => {
      calls++;
      if (images.length) throw new Error('prompt rejected');
      return { text: '总览:按文案推断的片子\n时间线:\n· 00:00–00:30 铺垫:热评说铺垫长\n· 00:30–01:30 高潮:弹幕高峰\n观感:一般' };
    },
  });
  assert.equal(calls, 2, 'second attempt without images');
  assert.equal(res.ok, true);
  assert.equal(res.channel, 'ok:text-only');
  assert.equal(res.fallback, 'text-infer');
  assert.match(res.takeaway, /铺垫|00:30/);
});

test('vision prompts carry persona voice and ask for a whole-video opinionated 观感', async () => {
  const { buildVisionPrompt, buildTextFallbackPrompt } = await import('../packages/soulmate-bili/vision-summary.mjs');
  const voice = '戏谑、带点压迫感，护短带刺。分寸：吐槽犀利。口吻参考：「敢动你？先过我这关。」';
  const p = buildVisionPrompt({ title: 'T', frames: [{ tSec: 0, label: '00:00' }], persona: voice });
  assert.ok(!p.includes('视频内容分析助手'), '不再自报中性助手身份');
  assert.ok(p.includes('以当前人设的身份'));
  assert.ok(p.includes('【你的性格（只影响观感措辞）】'));
  assert.ok(p.includes('吐槽犀利'));
  assert.match(p, /观感：<不超过 500 字/);
  assert.match(p, /按【类型：/);
  assert.match(p, /不要复述时间线/);
  assert.match(p, /侧重点|落在具体内容上/);
  assert.match(p, /不要评镜头/);
  const plain = buildVisionPrompt({ title: 'T', frames: [] });
  assert.ok(!plain.includes('【你的性格'), '无人设时不加性格块');
  const f = buildTextFallbackPrompt({ title: 'T' }, { persona: voice });
  assert.ok(f.includes('【你的性格（只影响观感措辞）】'));
  assert.match(f, /观感[:：]<不超过 500 字/);
});

test('parseVisionTimelineText keeps multi-line 观感 and compose passes persona through', async () => {
  const raw = '总览：一期讲透 X\n时间线：\n· 00:00–00:30 开场：点题\n· 00:30–01:00 论证：给证据\n观感：这片子有点东西，节奏紧、没废话。\n槽点是结尾恰饭太硬——但整体值得你看一遍。';
  const parsed = parseVisionTimelineText(raw);
  assert.match(parsed.opinion, /有点东西/);
  assert.match(parsed.opinion, /恰饭太硬/, '第二句不丢');
  assert.equal(parsed.chapters.length, 2);
  const take = formatVisionTakeaway({ ...parsed, worthScore: 15 });
  assert.match(take, /观感：这片子有点东西.*恰饭太硬/);

  let seenPrompt = '';
  const res = await composeVisionTimelineSummary({
    digest: { title: 'X', durationSec: 60, worthScore: 15, liveFrameStills: [{ tSec: 0, url: 'u0' }] },
    persona: '嘴硬心软，吐槽犀利',
    visionSummarize: async ({ prompt }) => {
      seenPrompt = prompt;
      return { text: raw };
    },
  });
  assert.equal(res.ok, true);
  assert.ok(seenPrompt.includes('嘴硬心软'), 'persona 传进视觉 prompt');
});

test('composeVisionTimelineSummary: 超过单批上限的帧分批送模，批间携带前情与末帧锚点', async () => {
  const live = Array.from({ length: 40 }, (_, i) => ({
    tSec: i * 15,
    url: `https://example.test/live/${i}.jpg`,
  }));
  const calls = [];
  const res = await composeVisionTimelineSummary({
    digest: { title: '四十帧长片全记录', durationSec: 600, worthScore: 15, liveFrameStills: live },
    persona: '嘴硬心软',
    visionSummarize: async ({ prompt, images }) => {
      calls.push({ prompt, images });
      const n = calls.length;
      const opinion = n === 3 ? '\n观感：全程干货，值得看。' : '';
      return { text: `总览：第${n}段讲了主题${n}\n时间线：\n· 0${n}:00–0${n}:30 章节${n}：要点${n}${opinion}` };
    },
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(calls.length, 3, '40 帧 → 16+16+8 三批');
  assert.ok(calls.every((c) => c.images.length <= 20), '每批不超宿主图片上限');
  assert.equal(res.batches.total, 3);
  assert.equal(res.batches.ok, 3);
  assert.equal(res.frames.length, 40, '全片 40 帧都被看过（不再压到 16）');
  // 批间锚点：第 2 批第一张 = 第 1 批最后一张
  assert.equal(calls[1].images[0].url, calls[0].images[calls[0].images.length - 1].url, '末帧锚点衔接');
  assert.equal(calls[2].images[0].url, calls[1].images[calls[1].images.length - 1].url);
  // 前情传递：第 2/3 批 prompt 带上前面各批结论
  assert.match(calls[1].prompt, /第1批/, '第 2 批带第 1 批结论');
  assert.match(calls[2].prompt, /第2批/, '第 3 批带第 2 批结论');
  assert.match(calls[1].prompt, /第 2\/3 批/);
  assert.match(calls[2].prompt, /最后一批/);
  assert.ok(!calls[0].prompt.includes('观感：<'), '非末批不要求输出观感');
  assert.match(calls[0].prompt, /不要写观感/);
  // 合并：各批章节都在最终时间线里，观感来自末批
  assert.match(res.takeaway, /章节1/);
  assert.match(res.takeaway, /章节2/);
  assert.match(res.takeaway, /章节3/);
  assert.match(res.takeaway, /观感：全程干货/);
});

test('composeVisionTimelineSummary: 分批中间一批失败 → 其余批保留并标 partial；全失败落文本兜底', async () => {
  const live = Array.from({ length: 40 }, (_, i) => ({ tSec: i * 15, url: `https://example.test/p/${i}.jpg` }));
  let n = 0;
  const res = await composeVisionTimelineSummary({
    digest: { title: 'X', durationSec: 600, worthScore: 10, liveFrameStills: live },
    visionSummarize: async () => {
      n += 1;
      if (n === 2) throw new Error('batch-2-rejected');
      return { text: `总览：段${n}\n时间线：\n· 00:00–00:30 章${n}：要点` };
    },
  });
  assert.equal(res.ok, true);
  assert.equal(res.partial, true);
  assert.equal(res.batches.ok, 2);
  assert.equal(res.batches.failed, 1);
  assert.match(res.takeaway, /章1/);
  assert.match(res.takeaway, /章3/);

  const fallback = await composeVisionTimelineSummary({
    digest: { title: 'Y', durationSec: 600, worthScore: 5, liveFrameStills: live, transcript: '字幕内容' },
    visionSummarize: async ({ images }) => {
      if (images.length) throw new Error('no-vision');
      return { text: '总览：按文案推断\n时间线：\n· 00:00–01:00 推断章：内容\n观感：未看画面，按文案聊。' };
    },
  });
  assert.equal(fallback.ok, true);
  assert.equal(fallback.channel, 'ok:text-only');
  assert.equal(fallback.fallback, 'text-infer');
});

test('parse: the type-aware 「（按【类型…】切章）」 header is not a chapter', () => {
  const parsed = parseVisionTimelineText(
    '总览：x\n时间线（按【类型：剧情/短剧】切章）：\n· （按【类型：剧情/短剧】切章）：\n· 00:00–00:30 开场：y\n观感：z'
  );
  assert.equal(parsed.chapters.length, 1);
  assert.match(parsed.chapters[0].text, /开场/);
});

test('compose: multi-batch overview spans all batches and chapter thinning keeps the tail', async () => {
  const live = Array.from({ length: 7 * 16 }, (_, i) => ({ tSec: i * 83, url: `https://example.test/l${i}.jpg` }));
  let calls = 0;
  let synthCalls = 0;
  const res = await composeVisionTimelineSummary({
    digest: { title: '末日丧尸第1季+第2季完整版合集', durationSec: 153 * 60, worthScore: 19, liveFrameStills: live },
    visionSummarize: async ({ prompt }) => {
      if (String(prompt).includes('全片总览')) {
        synthCalls += 1;
        return { text: '全片从末日开智讲到尸潮决战，双季完整收束。' };
      }
      calls += 1;
      const n = calls;
      const lines = [`总览：第${n}段自己的概览`, '时间线（按【类型：剧情/短剧】切章）：'];
      for (let k = 0; k < 4; k += 1) {
        lines.push(`· ${String(n).padStart(2, '0')}:0${k}–${String(n).padStart(2, '0')}:1${k} 第${n}批章${k + 1}：要点`);
      }
      lines.push('观感：整片不错。');
      return { text: lines.join('\n') };
    },
  });
  assert.equal(res.ok, true);
  assert.equal(res.batches.total, 7);
  assert.equal(calls, 7);
  assert.equal(synthCalls, 1);
  assert.match(res.takeaway, /全片从末日开智讲到尸潮决战/);
  assert.doesNotMatch(res.takeaway, /本片分 7 段/);
  // 28 chapters thin to 21, but the final batch's last chapter must survive.
  assert.match(res.takeaway, /第7批章4/);
  assert.doesNotMatch(res.takeaway, /按【类型/);
});

test('thinChapters keeps first and last when thinning', () => {
  const list = Array.from({ length: 30 }, (_, i) => ({ text: `c${i + 1}` }));
  const out = thinChapters(list, 10);
  assert.equal(out.length, 10);
  assert.equal(out[0].text, 'c1');
  assert.equal(out[out.length - 1].text, 'c30');
});

test('composeLongOverview: long films get opening/middle/ending, not a 10-batch chain', () => {
  const bits = Array.from({ length: 10 }, (_, i) => `第${i + 1}批：这批从第${i + 1}段讲起`);
  const out = composeLongOverview(bits, 10);
  assert.match(out, /本片共 10 段：开场/);
  assert.match(out, /中段/);
  assert.match(out, /收尾/);
  assert.ok(out.length < 250);
  assert.doesNotMatch(out, /第2批/);
});
