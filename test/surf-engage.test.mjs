import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  sanitizeCommentText,
  decideSurfEngageHeuristic,
  composeSurfSummary,
  pickSurfStills,
} from '../packages/soulmate-bili/engage.mjs';
import { scrubTranscriptNoise, composeVideoTakeaway, transcriptAlignedWithMeta } from '../packages/soulmate-bili/index.mjs';
import { appendEngagePhrase } from '../packages/soulmate-bili/vision-summary.mjs';
import {
  clampSurfMaxPick,
  formatSurfIntervalLabel,
  maxPickCapForInterval,
  resolveSurfIntervalMinutes,
} from '../packages/soulmate-core/surf-schedule.mjs';
import {
  appendSurfLog,
  deleteSurfLogEntry,
  listSurfLog,
  listSurfLogDates,
  listSurfLogPage,
  normalizeSurfEntry,
  surfEntryDayKey,
} from '../packages/soulmate-core/surf-log.mjs';

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
    const page = await listSurfLogPage(home, { platform: 'bilibili', filter: 'all', limit: 1, offset: 0 });
    assert.equal(page.entries.length, 1);
    assert.equal(page.total, 2);
    assert.equal(page.hasMore, true);
    const page2 = await listSurfLogPage(home, { platform: 'bilibili', filter: 'all', limit: 1, offset: 1 });
    assert.equal(page2.entries.length, 1);
    assert.equal(page2.hasMore, false);
    const dates = await listSurfLogDates(home, { platform: 'bilibili', filter: 'all' });
    assert.ok(dates.length >= 1);
    assert.ok(dates[0].day && dates[0].count >= 1);
    const dayPage = await listSurfLogPage(home, {
      platform: 'bilibili',
      filter: 'all',
      day: dates[0].day,
      limit: 20,
    });
    assert.ok(dayPage.entries.every((e) => surfEntryDayKey(e.at) === dates[0].day));
    assert.equal(dayPage.total, dates[0].count);

    const beforeDelete = await listSurfLog(home, { platform: 'bilibili', filter: 'all', limit: 10 });
    const victim = beforeDelete.find((e) => e.videoId === 'BVtest1');
    assert.ok(victim && victim.id);
    const deleted = await deleteSurfLogEntry(home, { platform: 'bilibili', id: victim.id });
    assert.equal(deleted.ok, true);
    assert.equal(deleted.entry.videoId, 'BVtest1');
    const afterDelete = await listSurfLog(home, { platform: 'bilibili', filter: 'all', limit: 10 });
    assert.ok(!afterDelete.some((e) => e.videoId === 'BVtest1'));
    assert.ok(afterDelete.some((e) => e.videoId === 'BVtest2'));

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

test('pickSurfStills keeps crop rects so sprite cells are not identical URLs', () => {
  const sheet = 'https://example.test/sheet.jpg';
  const frames = [0, 1, 2, 3, 4, 5].map((i) => ({
    imageUrl: sheet,
    x: (i % 3) * 160,
    y: Math.floor(i / 3) * 90,
    width: 160,
    height: 90,
    sheetWidth: 480,
    sheetHeight: 180,
    label: '0:0' + i,
    timeSec: i * 10,
  }));
  const stills = pickSurfStills(frames, 3);
  assert.equal(stills.length, 3);
  assert.equal(stills[0].url, sheet);
  assert.notEqual(`${stills[0].x},${stills[0].y}`, `${stills[1].x},${stills[1].y}`);
  assert.notEqual(`${stills[1].x},${stills[1].y}`, `${stills[2].x},${stills[2].y}`);
  assert.equal(stills[0].sheetWidth, 480);
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

test('transcriptAlignedWithMeta rejects unrelated subtitle bodies', () => {
  const bad = transcriptAlignedWithMeta({
    title: 'python基础练习题：整数等于浮点数吗',
    desc: '编程入门',
    transcript: '京都米其林怀石料理、鲷鱼烧、清水寺散步、打卡美食探店、夜间灯笼很美。'.repeat(4),
  });
  assert.equal(bad.aligned, false);
  const good = transcriptAlignedWithMeta({
    title: 'python基础练习题：整数等于浮点数吗',
    desc: '浮点数比较',
    transcript: '今天讲 python 基础，整数和浮点数能不能直接用等号比较，注意精度问题。'.repeat(2),
  });
  assert.equal(good.aligned, true);
});

test('composeVideoTakeaway discards mismatched Kyoto/Goodall-style transcripts', () => {
  const kyoto = composeVideoTakeaway({
    title: 'python基础练习题：整数等于浮点数吗',
    desc: '',
    transcript: '今天我们要飞1500km去京都吃一顿米其林两星的怀石料理看看人均5万日元的套餐到底吃什么啊登机啦登机啦'.repeat(2),
    tags: ['python', '编程'],
    worthScore: 7,
  });
  assert.match(kyoto, /python|编程|整数|浮点|标题/);
  assert.doesNotMatch(kyoto, /京都|米其林|怀石/);

  const news = composeVideoTakeaway({
    title: '【无线新闻台】午间报道:乌军逾千无人机袭俄罗斯及克里米亚大桥',
    desc: '',
    transcript: '珍妮·古道尔博士会给你们讲个故事。在动画结束之后请耐心等待，了解如何把本视频下载为免费的儿童读物。一切都源于一声空中传来的低语。'.repeat(2),
    worthScore: 5,
  });
  assert.match(news, /无线新闻|乌军|无人机|克里米亚|标题/);
  assert.doesNotMatch(news, /古道尔|Jane|儿童读物/);
});

test('composeSurfSummary rebuilds when takeaway mismatches title', () => {
  const summary = composeSurfSummary({
    title: 'python基础练习题：整数等于浮点数吗',
    author: '野生编程',
    worthScore: 7,
    tags: ['python'],
    takeaway: '讲了什么：今天我们要飞1500km去京都吃米其林怀石料理人均5万日元登机啦登机啦看看京都到底有什么好吃好玩 观感：一般，挑着看就行。',
  }, { selfRef: '我' });
  assert.match(summary, /python|编程|标题/);
  assert.doesNotMatch(summary, /京都|米其林/);
});

test('appendEngagePhrase keeps vision takeaway and adds actions', () => {
  const takeaway = '讲了什么：整数与浮点比较\n时间线：\n· 00:00–01:00 演示\n观感：清楚';
  const summary = composeSurfSummary({
    title: 'python基础练习题：整数等于浮点数吗',
    author: '野生编程',
    worthScore: 8,
    takeaway,
    visionSummary: { ok: true, channel: 'ok:storyboard' },
  }, { selfRef: '我' });
  assert.match(summary, /时间线/);
  assert.match(appendEngagePhrase(summary, { like: true, favorite: true }), /｜已点赞、已收藏/);
});

test('surf schedule: interval presets and pick caps', () => {
  assert.equal(resolveSurfIntervalMinutes({ biliAutoSurfEveryHours: 6 }), 360);
  assert.equal(resolveSurfIntervalMinutes({ biliAutoSurfEveryMinutes: 10 }), 10);
  assert.equal(formatSurfIntervalLabel(90), '1.5 小时');
  assert.equal(maxPickCapForInterval(10), 2);
  assert.equal(maxPickCapForInterval(30), 6);
  assert.equal(maxPickCapForInterval(60), 10);
  assert.equal(clampSurfMaxPick(5, 10), 2);
  assert.equal(clampSurfMaxPick(5, 30), 5);
  assert.equal(clampSurfMaxPick(99, 1440), 20);
});
