// 端到端自测：标题闸 → 截帧/多模态时间线 → 评价 → 互动 → 日志删除（全链路，mock 网络）。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { deflateRawSync } from 'node:zlib';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { apply } from '../index.js';
import {
  decideSurfEngageHeuristic,
  executeSurfEngage,
  runAutonomousSurfRound,
  saveBiliCredentials,
  seenLedgerPath,
  watchAndRecordVideo,
} from '../packages/soulmate-bili/index.mjs';
import { saveConfigAuto } from '../packages/soulmate-core/state.mjs';
import { deleteSurfLogEntry, listSurfLog, surfLogPath } from '../packages/soulmate-core/surf-log.mjs';

const BV_GOOD = 'BV1Good11111';
const BV_LOW = 'BV1Low000000';
const BV_BAIT = 'BV1Bait77777';
const BV_FOLLOW = 'BV1Farm88888';
const SESSDATA = 'SESSDATA-e2e-secret';
const CSRF = 'csrf-e2e-secret';

const xmlEscape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function danmakuXml(rows) {
  const items = rows.map(([t, text], i) => `<d p="${t}.5,1,25,16777215,1700000${i},0,abcd${i},${1000 + i}">${xmlEscape(text)}</d>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><i><chatserver>chat.bilibili.com</chatserver><chatid>1</chatid>${items}</i>`;
}

function defaultDanmakuTimes() {
  const out = [];
  for (let i = 0; i < 40; i++) out.push([60 + (i % 15), i % 3 === 0 ? 'awsl' : '高能预警']);
  for (let i = 0; i < 20; i++) out.push([120 + (i % 15), '这段太强了']);
  out.push([5, '前排'], [290, '三连了']);
  return out;
}

const goodComments = () => [
  { rpid: 1, like: 880, member: { uname: '路人甲' }, content: { message: '讲得太清楚了，三连！' }, replies: [] },
  { rpid: 2, like: 320, member: { uname: '路人丙' }, content: { message: '收藏了慢慢看' }, replies: [] },
  { rpid: 4, like: 99, member: { uname: '路人丁' }, content: { message: '第二分钟那段是神' }, replies: [] },
];

function makeVideo(bvid, aid, overrides = {}) {
  const lines = overrides.noSubtitle ? [] : Array.from({ length: 30 }, (_, i) => ({ from: i * 10, to: i * 10 + 9, content: `第${i + 1}段讲解：智能体如何拆解任务、调用工具并自我修正。` }));
  return {
    bvid,
    aid,
    cid: aid * 10,
    title: overrides.title ?? 'AI 编程新范式：十分钟讲透智能体',
    desc: '一期讲清楚智能体编程的视频。',
    author: 'UP小明',
    mid: 4321,
    duration: 300,
    pubdate: Math.floor(Date.now() / 1000) - 86400,
    stat: overrides.stat ?? { view: 50_000, danmaku: 120, reply: 80, favorite: 2000, like: 6000, coin: 1500 },
    subtitleLines: lines,
    danmaku: overrides.danmaku ?? defaultDanmakuTimes(),
    comments: overrides.comments ?? goodComments(),
    ...overrides,
  };
}

async function startMockBili(videos, { search = [], noVideoshot = false } = {}) {
  const requests = [];
  const byBvid = new Map(videos.map((v) => [v.bvid, v]));
  const byAid = new Map(videos.map((v) => [String(v.aid), v]));
  let baseUrl = '';
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://mock.local');
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body });
    const json = (data, code = 0) => {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ code, message: code ? 'mock error' : '0', data }));
    };
    const q = (k) => url.searchParams.get(k);
    const video = byBvid.get(q('bvid')) ?? byAid.get(q('aid')) ?? byAid.get(q('oid'));
    switch (url.pathname) {
      case '/x/web-interface/view':
        if (!video) return json(null, -404);
        return json({
          bvid: video.bvid, aid: video.aid, cid: video.cid, title: video.title, desc: video.desc,
          pic: `https://i0.hdslb.com/bfs/archive/cover-${video.bvid}.jpg`,
          duration: video.duration, pubdate: video.pubdate,
          owner: { mid: video.mid, name: video.author }, stat: video.stat,
          pages: [{ cid: video.cid, page: 1 }],
        });
      case '/x/tag/archive/tags':
        return json([{ tag_name: 'AI' }, { tag_name: '科技' }]);
      case '/x/player/v2':
        if (!video || !video.subtitleLines.length) return json({ subtitle: { subtitles: [] } });
        return json({ subtitle: { subtitles: [{ lan: 'ai-zh', lan_doc: '中文（自动生成）', subtitle_url: `${baseUrl}/sub/${video.bvid}.json` }] } });
      case '/x/player/videoshot':
        if (!video) return json(null, -404);
        if (noVideoshot) return json({ image: [], index: [], img_x_len: 10, img_y_len: 10, img_x_size: 160, img_y_size: 90 });
        return json({
          image: [`${baseUrl}/bfs/videoshot/${video.bvid}-0.jpg`],
          index: Array.from({ length: 125 }, (_, i) => i * 2),
          img_x_len: 10, img_y_len: 10, img_x_size: 160, img_y_size: 90,
        });
      case '/x/v1/dm/list.so': {
        if (!video) return json(null, -404);
        res.writeHead(200, { 'content-type': 'text/xml; charset=utf-8' });
        return res.end(deflateRawSync(Buffer.from(danmakuXml(video.danmaku), 'utf8')));
      }
      case '/x/v2/reply':
        if (!video) return json(null, -404);
        return json({ replies: video.comments, hots: [] });
      case '/x/player/playurl':
        if (!video) return json(null, -404);
        return json({
          quality: 16,
          durl: [{ url: `${baseUrl}/media/${video.bvid}.mp4`, size: 1, length: video.duration * 1000 }],
        });
      case '/x/web-interface/nav':
        return json({ isLogin: true, wbi_img: { img_url: 'https://i0.hdslb.com/bfs/wbi/abcdefghijklmnopqrstuvwxyz0123456789.png', sub_url: 'https://i0.hdslb.com/bfs/wbi/zyxwvutsrqponmlkjihgfedcba9876543210.png' } });
      case '/x/web-interface/popular':
        return json({ list: [] });
      case '/x/article/recommends':
        return json({ articles: [] });
      case '/x/web-interface/search/type':
        if (q('search_type') === 'article') return json({ result: [] });
        return json({ result: search.map((s, i) => ({ bvid: s.bvid, title: s.title, author: 'UP小明', play: 1000 - i, pubdate: Math.floor(Date.now() / 1000) - 86400 })) });
      // write endpoints
      case '/x/web-interface/archive/like':
        return json({});
      case '/x/v3/fav/folder/created/list-all':
        return json({ list: [{ id: 9001 }] });
      case '/x/v3/fav/resource/deal':
        return json({});
      case '/x/v2/reply/add':
        return json({ rpid: 555001 });
      case '/x/relation/modify':
        return json({});
      default: {
        if (url.pathname.startsWith('/bfs/')) {
          res.writeHead(200, { 'content-type': 'image/jpeg' });
          return res.end(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x42, 0xff, 0xd9]));
        }
        if (url.pathname.startsWith('/media/')) {
          // 真 ffmpeg 抽帧测试：把本地样片当视频流喂给 ffmpeg（支持 Range）。
          const file = fileURLToPath(new URL('./fixtures/e2e-sample.mp4', import.meta.url));
          const buf = await readFile(file);
          const range = String(req.headers.range || '').match(/bytes=(\d+)-(\d*)/);
          if (range) {
            const start = Number(range[1]);
            const end = range[2] ? Math.min(Number(range[2]), buf.length - 1) : buf.length - 1;
            res.writeHead(206, {
              'content-type': 'video/mp4',
              'content-range': `bytes ${start}-${end}/${buf.length}`,
              'accept-ranges': 'bytes',
              'content-length': String(end - start + 1),
            });
            return res.end(buf.subarray(start, end + 1));
          }
          res.writeHead(200, { 'content-type': 'video/mp4', 'accept-ranges': 'bytes', 'content-length': String(buf.length) });
          return res.end(buf);
        }
        const m = url.pathname.match(/^\/sub\/(.+?)\.json$/);
        const v = m && byBvid.get(m[1]);
        if (v) {
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ body: v.subtitleLines }));
        }
        res.writeHead(404);
        return res.end('nope');
      }
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  return {
    baseUrl,
    requests,
    posts: () => requests.filter((r) => r.method === 'POST'),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function createMockCtx(dir, sessionController = null) {
  const routes = new Map();
  const disposers = [];
  const mockCtx = {
    tools: { register: () => () => {} },
    systemPrompt: { section: () => () => {} },
    effect(fn) {
      const dispose = fn();
      if (typeof dispose === 'function') disposers.push(dispose);
    },
    provide() {},
    set(serviceName, val) { mockCtx[serviceName] = val; },
    get(serviceName) {
      if (serviceName === 'dshHomePath') return (...segs) => join(dir, ...segs);
      if (serviceName === 'sessionController') return sessionController;
      if (serviceName === 'webServer') {
        return {
          registerRoute(method, path, handler) {
            routes.set(`${method} ${path}`, handler);
            return () => routes.delete(`${method} ${path}`);
          },
        };
      }
      return mockCtx[serviceName];
    },
  };
  return { mockCtx, routes, dispose: () => { while (disposers.length) disposers.pop()(); } };
}

const VISION_OK_TEXT = [
  '总览：用十分钟讲透智能体拆解任务、调用工具与自我修正的全过程。',
  '时间线：',
  '· 00:00–01:00 开场：UP 主自我介绍并给出本期路线图',
  '· 01:00–02:30 拆解任务：白板画出智能体流水线',
  '· 02:30–04:00 工具调用：现场演示代码与终端画面',
  '· 04:00–05:00 总结：回顾要点并预告下一期',
  '观感：信息密度高，画面与讲解一致，值得收藏。',
].join('\n');

function visionController({ mode = 'ok', calls = [] } = {}) {
  return {
    async generateReply(args) {
      calls.push(args);
      if (mode === 'blind') return { text: '抱歉，只有时间戳，没有画面内容，无法描述各采样点的画面。' };
      if (mode === 'throw') throw new Error('mock-vision-down');
      return { text: VISION_OK_TEXT };
    },
  };
}

/** Fake ffmpeg output: real bytes on disk so materializeVisionImages yields data: URLs. */
async function seedLiveFrames(home, bvid, count = 10, everySec = 30) {
  const dir = join(home.rootDir, 'cache', 'live-frames', bvid);
  await mkdir(dir, { recursive: true });
  const frames = [];
  for (let i = 0; i < count; i += 1) {
    const name = `frame_${String(i + 1).padStart(3, '0')}.jpg`;
    // 每张帧字节不同，便于断言「真的读了盘上的像素」。
    await writeFile(join(dir, name), Buffer.from([0xff, 0xd8, 0xff, 0xe0, i + 1, 0xff, 0xd9]));
    frames.push({
      index: i,
      file: name,
      path: join(dir, name),
      url: `/dsh-soulmate/api/live-frame?bvid=${bvid}&i=${i}`,
      imageUrl: `/dsh-soulmate/api/live-frame?bvid=${bvid}&i=${i}`,
      timeSec: i * everySec,
      label: `${String(Math.floor((i * everySec) / 60)).padStart(2, '0')}:${String((i * everySec) % 60).padStart(2, '0')}`,
      width: 640, height: 360, sheetWidth: 640, sheetHeight: 360,
      source: 'live-ffmpeg',
    });
  }
  return frames;
}

/** 写操作端点硬编码 api.bilibili.com：用 fetchImpl 把它们引到 mock，绝不触网。 */
function makeMockFetch(mock) {
  return async (url, init = {}) => {
    const u = new URL(String(url));
    if (/(^|\.)bilibili\.com$/.test(u.hostname) || /(^|\.)hdslb\.com$/.test(u.hostname)) {
      return fetch(`${mock.baseUrl}${u.pathname}${u.search}`, init);
    }
    return fetch(url, init);
  };
}

async function withEnv(videos, opts, fn, { sessionController = null } = {}) {
  const mock = await startMockBili(videos, opts);
  const dir = await mkdtemp(join(tmpdir(), 'soulmate-e2e-'));
  const ctx = createMockCtx(dir, sessionController);
  apply(ctx.mockCtx, { autoSync: false, biliBaseUrl: mock.baseUrl, biliDmBaseUrl: mock.baseUrl });
  await ctx.mockCtx.soulmate.ready;
  try {
    await fn({
      mock,
      dir,
      service: ctx.mockCtx.soulmate,
      routes: ctx.routes,
      net: { baseUrl: mock.baseUrl, dmBaseUrl: mock.baseUrl, fetchImpl: makeMockFetch(mock) },
    });
  } finally {
    ctx.dispose();
    await mock.close();
    await rm(dir, { recursive: true, force: true });
  }
}

const allVideos = () => [
  makeVideo(BV_GOOD, 1001),
  makeVideo(BV_LOW, 1004, { title: '随便拍拍', noSubtitle: true, danmaku: [], comments: [], stat: { view: 100, danmaku: 0, reply: 0, favorite: 0, like: 0, coin: 0 } }),
  makeVideo(BV_BAIT, 1008, { title: '猛料戳 https://t.co/AbCdEf 速看' }),
  makeVideo(BV_FOLLOW, 1009, { title: '互粉互关涨粉车，回关必回' }),
];

const searchRows = () => [
  { bvid: BV_BAIT, title: '猛料戳 https://t.co/AbCdEf 速看' },
  { bvid: BV_FOLLOW, title: '互粉互关涨粉车，回关必回' },
  { bvid: BV_GOOD, title: 'AI 编程新范式：十分钟讲透智能体' },
];

const GET = (routes, path, qs = '') => routes.get(`GET ${path}`)({ method: 'GET', url: path + qs, query: new URLSearchParams(qs.replace(/^\?/, '')) });
const POST = (routes, path, payload) => routes.get(`POST ${path}`)({ method: 'POST', url: path, body: payload });
const body = (out) => JSON.parse(out.body);

test('surf e2e: 标题闸 → 真帧像素进多模态 → 时间线 → 互动 → 删除', async () => {
  const calls = [];
  await withEnv(allVideos(), { search: searchRows() }, async ({ mock, service, routes }) => {
    const home = service.home;
    await saveConfigAuto(home, { extensions: { biliAutoSurfMaxPick: 2, biliLiveFrameWatch: true, biliLiveFrameEverySec: 30 } });
    await saveBiliCredentials(home, { sessdata: SESSDATA, biliJct: CSRF, uid: '112233' });

    // 走面板真实入口：POST /video-watch { action: 'surf' } → videoSurf → host-vision 绑定
    // 真 ffmpeg 从 mock 视频流抽帧（样片 test/fixtures/e2e-sample.mp4）。
    const out = await POST(routes, '/dsh-soulmate/api/video-watch', {
      action: 'surf',
      keywords: ['AI'],
      maxPick: 2,
      includePopular: false,
      includeArticles: false,
    });
    assert.equal(out.status, 200, out.body);
    const round = body(out);
    assert.equal(round.ok, true, JSON.stringify(round.errors || round));
    assert.equal(round.skippedTitleCount, 2, '两条引流标题在看片前就被闸掉');
    assert.equal(round.pickedCount, 1);

    // 引流片：标记 seen，且从未请求过它们的元数据/弹幕（零成本跳过）
    const ledger = JSON.parse(await readFile(seenLedgerPath(home), 'utf8'));
    assert.equal(ledger.seen[BV_BAIT].skipped, 'title-gate');
    assert.equal(ledger.seen[BV_FOLLOW].skipped, 'title-gate');
    assert.ok(!mock.requests.some((r) => r.query.bvid === BV_BAIT || r.query.bvid === BV_FOLLOW), 'bait videos never fetched');
    const baitRows = round.videos.filter((v) => v.skipped);
    assert.equal(baitRows.length, 2);
    assert.ok(baitRows.every((v) => v.skipKind === 'title-gate' && v.reason));

    // 好片：模型真的收到了盘上帧的 data: 像素
    assert.equal(calls.length >= 1, true, 'multimodal called');
    const first = calls[0];
    const images = Array.isArray(first.images) ? first.images : [];
    assert.ok(images.length >= 5, `expected >=5 frames, got ${images.length}`);
    assert.ok(images.every((img) => String(img.url).startsWith('data:image/')), 'all frames materialized to data URLs');
    assert.ok(String(first.text || first.prompt || '').includes('AI 编程新范式'), 'title inside vision prompt');
    assert.ok(String(first.text || first.prompt || '').includes('字幕摘录'), 'transcript inside vision prompt');

    const watched = round.videos.find((v) => v.ok);
    assert.equal(watched.bvid, BV_GOOD);
    assert.equal(watched.channels.visionSummary, 'ok:live');
    assert.match(watched.takeaway, /时间线：/);
    assert.match(watched.takeaway, /00:00–01:00/);
    assert.ok(watched.worthScore >= 13, `good score=${watched.worthScore}`);

    // 日志：summary 带时间线，actions 默认 write-disabled（未开写开关）
    const entries = await listSurfLog(home, { platform: 'bilibili', limit: 10 });
    assert.equal(entries.length, 1);
    const entry = entries[0];
    assert.equal(entry.videoId, BV_GOOD);
    assert.equal(entry.worthScore, watched.worthScore);
    assert.match(entry.summary, /时间线：/);
    assert.ok(entry.stills.length >= 5, 'log keeps live stills');
    assert.deepEqual(entry.actions.skippedReasons, ['write-disabled']);
    assert.equal(mock.posts().length, 0, 'write switch off → nothing posted');

    // REST：dates=1 / day 分页 / 非法 platform
    const dates = body(await GET(routes, '/dsh-soulmate/api/surf-log', '?platform=bilibili&dates=1'));
    assert.equal(dates.ok, true);
    assert.equal(dates.dates.length, 1);
    const day = dates.dates[0].day;
    const page = body(await GET(routes, '/dsh-soulmate/api/surf-log', `?platform=bilibili&day=${day}&limit=10`));
    assert.equal(page.entries.length, 1);
    assert.equal(page.total, 1);
    assert.equal((await GET(routes, '/dsh-soulmate/api/surf-log', '?platform=weibo')).status, 400);

    // REST：非法 action / 缺 id / 不存在 → 响亮失败
    assert.equal((await POST(routes, '/dsh-soulmate/api/surf-log', { action: 'nope' })).status, 400);
    assert.equal((await POST(routes, '/dsh-soulmate/api/surf-log', { action: 'delete', platform: 'bilibili' })).status, 400);
    const missing = await POST(routes, '/dsh-soulmate/api/surf-log', { action: 'delete', platform: 'bilibili', id: 'no-such-id' });
    assert.equal(missing.status, 404);

    // REST：按 id 删除 → 200，jsonl 清空，再删 404
    const del = await POST(routes, '/dsh-soulmate/api/surf-log', { action: 'delete', platform: 'bilibili', id: entry.id });
    assert.equal(del.status, 200);
    assert.equal(body(del).ok, true);
    assert.equal((await listSurfLog(home, { platform: 'bilibili', limit: 10 })).length, 0);
    const again = await POST(routes, '/dsh-soulmate/api/surf-log', { action: 'delete', platform: 'bilibili', id: entry.id });
    assert.equal(again.status, 404);
    const raw = await readFile(surfLogPath(home, 'bilibili'), 'utf8');
    assert.equal(raw.trim(), '', 'jsonl really rewritten');
  }, { sessionController: visionController({ calls }) });
});

test('surf e2e: 看片失败（盲答/异常）压分不互动；开启写开关后高分片真的赞藏评关', async () => {
  await withEnv(allVideos(), {}, async ({ mock, service, net }) => {
    const home = service.home;
    await saveBiliCredentials(home, { sessdata: SESSDATA, biliJct: CSRF, uid: '112233' });
    await seedLiveFrames(home, BV_GOOD, 10, 30);

    // 1) 盲答：只有时间戳没有画面 → 压到 ≤5，全链路一致，不互动
    const t0 = Date.now();
    const blind = await watchAndRecordVideo(service, { target: BV_GOOD }, {
      ...net,
      nowMs: t0,
      liveFrameWatch: false,
      llmController: visionController({ mode: 'blind' }),
    });
    assert.equal(blind.ok, true);
    assert.equal(blind.digest.channels.visionSummary, 'skip:vision-error');
    assert.ok(blind.worthScore <= 5, `blind capped score=${blind.worthScore}`);
    const blindEntries = await listSurfLog(home, { platform: 'bilibili', limit: 10 });
    assert.equal(blindEntries[0].worthScore, blind.worthScore, 'log uses capped score');
    assert.ok(blindEntries[0].stills.length > 0, 'storyboard stills kept');
    assert.equal(mock.posts().length, 0);

    // 2) 模型抛异常 → 同样压分软失败
    const boom = await watchAndRecordVideo(service, { target: BV_LOW }, {
      ...net,
      nowMs: t0 + 1000,
      liveFrameWatch: false,
      llmController: visionController({ mode: 'throw' }),
    });
    assert.equal(boom.ok, true);
    assert.equal(boom.digest.channels.visionSummary, 'skip:vision-error');
    assert.ok(boom.worthScore <= 5);

    // 3) 开写开关 + 好片 + 真帧 → 点赞必发；藏/评/关受 30s 写冷却诚实跳过
    await saveConfigAuto(home, { extensions: { biliWriteEnabled: true } });
    const good = await watchAndRecordVideo(service, { target: BV_GOOD }, {
      ...net,
      nowMs: t0 + 2000,
      liveFrameWatch: false,
      llmController: visionController({ mode: 'ok' }),
      persona: { selfRef: '小汐', traits: { talkative: 70, clingy: 70, tsundere: 20 } },
    });
    assert.equal(good.ok, true);
    assert.equal(good.digest.channels.visionSummary, 'ok:storyboard');
    assert.ok(good.worthScore >= 13, `score=${good.worthScore}`);
    const actions = good.recorded.surf.actions;
    assert.equal(actions.like, true, JSON.stringify(actions));
    const paths = mock.posts().map((r) => r.path);
    assert.ok(paths.includes('/x/web-interface/archive/like'), paths.join(','));
    assert.ok((actions.skippedReasons || []).some((r) => r.startsWith('favorite:cooldown')), JSON.stringify(actions));

    // 3b) 逐个写动作隔开 30s 冷却（真实护栏）→ 藏/评/关全走真实 mock 端点
    const digest2 = { ...good.digest, worthScore: 17 };
    const persona2 = { selfRef: '小汐', traits: { talkative: 70, clingy: 70, tsundere: 20 } };
    const basePlan = decideSurfEngageHeuristic({ digest: digest2, persona: persona2 });
    assert.equal(basePlan.favorite, true);
    assert.equal(basePlan.comment, true);
    assert.equal(basePlan.follow, true);
    const fav = await executeSurfEngage(home, { digest: digest2, plan: { ...basePlan, like: false, comment: false, follow: false }, options: { ...net, nowMs: t0 + 120_000 } });
    assert.equal(fav.favorite, true, JSON.stringify(fav));
    const cmt = await executeSurfEngage(home, { digest: digest2, plan: { ...basePlan, like: false, favorite: false, follow: false }, options: { ...net, nowMs: t0 + 180_000 } });
    assert.equal(cmt.comment, true, JSON.stringify(cmt));
    const fol = await executeSurfEngage(home, { digest: digest2, plan: { ...basePlan, like: false, favorite: false, comment: false }, options: { ...net, nowMs: t0 + 240_000 } });
    assert.equal(fol.follow, true, JSON.stringify(fol));
    const paths2 = mock.posts().map((r) => r.path);
    assert.ok(paths2.includes('/x/v3/fav/resource/deal'), paths2.join(','));
    assert.ok(paths2.includes('/x/v2/reply/add'), paths2.join(','));
    assert.ok(paths2.includes('/x/relation/modify'), paths2.join(','));

    // 3c) 重看同片 → 新日志条目；patch 只更新新条目，旧条目（含盲答那条）一条不丢
    const good2 = await watchAndRecordVideo(service, { target: BV_GOOD }, {
      ...net,
      nowMs: t0 + 300_000,
      liveFrameWatch: false,
      llmController: visionController({ mode: 'ok' }),
      persona: persona2,
    });
    assert.equal(good2.ok, true);
    const allEntries = await listSurfLog(home, { platform: 'bilibili', limit: 50 });
    assert.equal(allEntries.length, 4, 'blind + boom + good + good2 all survive patch rewrite');
    assert.ok(allEntries.some((e) => e.videoId === BV_LOW), 'BV_LOW entry not dropped by patch rewrite');
    const blindEntry = allEntries.find((e) => e.videoId === BV_GOOD && e.worthScore <= 5);
    assert.ok(blindEntry, 'blind entry kept');
    assert.equal(blindEntry.actions.like, false, 'rewatch engage must not leak into the blind entry');

    const entries = await listSurfLog(home, { platform: 'bilibili', filter: 'engaged', limit: 10 });
    assert.ok(entries.some((e) => e.videoId === BV_GOOD && e.actions.like), 'engaged filter finds it');
    const goodEntry = entries.find((e) => e.videoId === BV_GOOD && e.actions.like);
    assert.match(goodEntry.summary, /已点赞/);

    // 4) 按 videoId+at 删除（无 id 的旧格式路径）
    const del = await deleteSurfLogEntry(home, { platform: 'bilibili', videoId: goodEntry.videoId, at: goodEntry.at });
    assert.equal(del.ok, true);
    const left = await listSurfLog(home, { platform: 'bilibili', limit: 20 });
    assert.ok(!left.some((e) => e.videoId === BV_GOOD && e.at === goodEntry.at));
  });
});

test('surf e2e: 没截到帧但有字幕 → 纯文本总结通道 ok:text-only，不谎称看过画面', async () => {
  const calls = [];
  await withEnv([makeVideo(BV_GOOD, 1001)], { noVideoshot: true }, async ({ service, routes }) => {
    // 走面板真实入口：POST /video-watch { action: 'watch' } → host-vision 无帧退化
    const out = await POST(routes, '/dsh-soulmate/api/video-watch', { action: 'watch', target: BV_GOOD, mode: 'deep' });
    assert.equal(out.status, 200, out.body);
    const res = body(out);
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.channels.visionSummary, 'ok:text-only');
    assert.match(res.takeaway, /时间线：/);
    assert.ok(res.worthScore >= 13, 'text-only keeps the honest score (no blind cap)');
    assert.equal(calls.length, 1);
    assert.ok(!calls[0].images || !calls[0].images.length, 'text-only call carries no images');
    assert.ok(String(calls[0].text || '').includes('字幕摘录'), 'transcript still reaches the model');
  }, { sessionController: visionController({ calls }) });
});
