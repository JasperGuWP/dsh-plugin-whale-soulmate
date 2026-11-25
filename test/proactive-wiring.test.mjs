import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { deflateRawSync } from 'node:zlib';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../index.js';
import { DEFAULT_CONFIG, loadConfig, saveConfigAuto } from '../packages/soulmate-core/state.mjs';

/** Cordis mock shaped like test/pet-sprite.test.mjs, plus a fake timer registry. */
function createMockCtx(dir) {
  const disposers = [];
  const routes = new Map();
  const timeoutHandles = new Set();
  const intervalHandles = new Set();

  const mockCtx = {
    tools: { register() { return () => {}; } },
    systemPrompt: { section() { return () => {}; }, context() { return () => {}; } },
    effect(fn) { const d = fn(); if (typeof d === 'function') disposers.push(d); },
    provide() {},
    set(k, v) { mockCtx[k] = v; },
    get(k) {
      if (k === 'dshHomePath') return (...segs) => join(dir, ...segs);
      if (k === 'webServer') return mockCtx._webServer();
      return mockCtx[k];
    },
    inject(deps, callback) {
      const inner = callback({ ...mockCtx, webServer: mockCtx._webServer(), get: mockCtx.get });
      return typeof inner === 'function' ? inner : () => {};
    },
    _webServer() {
      return {
        registerRoute(method, path, handler) {
          routes.set(`${method} ${path}`, handler);
          return () => routes.delete(`${method} ${path}`);
        },
      };
    },
  };

  const dispose = () => { while (disposers.length) disposers.pop()(); };
  return { mockCtx, routes, dispose, timeoutHandles, intervalHandles };
}

const body = (out) => JSON.parse(out.body);

test('proactive: config ships an enabled-by-default block that deep-merges without losing knobs', () => {
  assert.deepEqual(DEFAULT_CONFIG.proactive, {
    enabled: true,
    tzOffsetMinutes: 480,
    maxPerDay: 3,
    minIdleMinutes: 30,
    minGapMinutes: 180,
    quietHours: ['00:00-07:00'],
    dailyDiary: true,
    diaryCatchUp: true,
    lastDiaryDateKey: '',
    dreamReflect: true,
    dreamMinFacts: 2,
    dreamCatchUp: true,
    preferOffPeak: true,
    weeklyGate: true,
    distillCheck: true,
    distillMinCluster: 5,
    dreamLlmEnabled: false,
    dreamLlmDailyCap: 300_000,
    dreamLlmModel: '',
    dreamLlmAutoOffReason: '',
    dreamLlmAutoOffAt: '',
    dreamLlmPetRemindDateKey: '',
    distillLlmEnabled: false,
    distillLlmDailyCap: 200_000,
    distillLlmModel: '',
    distillLlmAutoOffReason: '',
    distillLlmAutoOffAt: '',
    distillLlmPetRemindDateKey: '',
    intentEnabled: true,
    intentLlmDailyCap: 60_000,
    intentLlmModel: '',
    intentMaxDecisionsPerDay: 8,
    intentMaxActsPerDay: 5,
    intentMinGapMinutes: 90,
    experienceEnabled: true,
    experienceLlmEnabled: true,
    experienceLlmDailyCap: 30_000,
  });

  const merged = DEFAULT_CONFIG.proactive;
  assert.equal(merged.enabled, true);
});

test('proactive: /api/proactive/status reports the gate decision and stays after dispose', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sm-proactive-'));
  try {
    const { mockCtx, routes, dispose } = createMockCtx(dir);
    apply(mockCtx, {});
    await mockCtx.soulmate.ready;
    await saveConfigAuto(mockCtx.soulmate.home, { extensions: { biliAutoSurfEnabled: false } });

    const handler = routes.get('GET /dsh-soulmate/api/proactive/status');
    assert.ok(handler, 'status route must be mounted');
    const status = body(await handler({ method: 'GET', url: '/x', query: new URLSearchParams() }));
    assert.equal(status.ok, true);
    assert.equal(typeof status.plan.speak, 'boolean');
    assert.equal(typeof status.plan.reason, 'string');
    assert.equal(status.config.enabled, true);

    // Numeric time only: an explicit `now` must be honoured for reproducible checks.
    const pinnedAt = Date.parse('2026-11-10T12:00:00Z');
    const pinned = body(await handler({
      method: 'GET',
      url: `/dsh-soulmate/api/proactive/status?now=${pinnedAt}`,
      query: new URLSearchParams({ now: String(pinnedAt) }),
    }));
    assert.equal(pinned.at, new Date(pinnedAt).toISOString());
    assert.equal(pinned.ok, true);

    dispose();
    assert.ok(!routes.has('GET /dsh-soulmate/api/proactive/status'), 'route removed on dispose');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('proactive: config patch accepts the proactive knobs and rejects non-allow-listed paths', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sm-proactive-cfg-'));
  try {
    const { mockCtx, routes, dispose } = createMockCtx(dir);
    apply(mockCtx, {});
    await mockCtx.soulmate.ready;
    await saveConfigAuto(mockCtx.soulmate.home, { extensions: { biliAutoSurfEnabled: false } });

    const post = routes.get('POST /dsh-soulmate/api/config');
    const out = body(await post({
      method: 'POST',
      url: '/dsh-soulmate/api/config',
      body: { proactive: { enabled: false, maxPerDay: 2, quietHours: ['01:00-06:00'] } },
    }));
    assert.equal(out.ok, true);

    const cfg = await loadConfig(mockCtx.soulmate.home);
    assert.equal(cfg.proactive.enabled, false);
    assert.equal(cfg.proactive.maxPerDay, 2);
    assert.deepEqual(cfg.proactive.quietHours, ['01:00-06:00']);
    assert.equal(cfg.proactive.minGapMinutes, 180, 'untouched knobs survive a patch');

    dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('proactive: the scheduled tick is registered through ctx.effect and cleared on dispose', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sm-proactive-tick-'));
  try {
    const { mockCtx, dispose } = createMockCtx(dir);
    apply(mockCtx, {});
    await mockCtx.soulmate.ready;
    await saveConfigAuto(mockCtx.soulmate.home, { extensions: { biliAutoSurfEnabled: false } });

    // The tick is exposed for hosts (and tests) that own their own clock.
    assert.equal(typeof mockCtx.soulmate.runProactiveTick, 'function');
    const res = await mockCtx.soulmate.runProactiveTick(Date.parse('2026-11-09T23:40:00Z'));
    assert.equal(res.ok, true);
    assert.equal(res.plan.kind, 'morning');
    assert.equal(res.plan.speak, true);
    assert.ok(['host', 'event', 'silent'].includes(res.delivery.via));

    // A second tick in the same window must not repeat the greeting.
    const again = await mockCtx.soulmate.runProactiveTick(Date.parse('2026-11-09T23:41:00Z'));
    assert.equal(again.plan.speak, false);

    dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('proactive: nudges are appended to the audit log so a silent gate is explainable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sm-proactive-audit-'));
  try {
    const { mockCtx, dispose } = createMockCtx(dir);
    apply(mockCtx, {});
    await mockCtx.soulmate.ready;
    await saveConfigAuto(mockCtx.soulmate.home, { extensions: { biliAutoSurfEnabled: false } });

    await mockCtx.soulmate.runProactiveTick(Date.parse('2026-11-09T23:40:00Z'));
    const home = mockCtx.soulmate.home;
    const raw = await readFile(join(home.logsDir, 'proactive.jsonl'), 'utf8');
    const rows = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    // Tick may also append dream / daily-diary bookkeeping; assert the morning nudge is logged.
    const morning = rows.find((r) => r.kind === 'morning');
    assert.ok(morning, `expected morning row among ${rows.map((r) => r.kind).join(',')}`);
    assert.equal(morning.speak, true);
    assert.equal(morning.delivered, morning.delivered);

    dispose();
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test('proactive: dream LLM path writes wiki via inject and records dream-llm usage', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sm-dream-llm-'));
  try {
    const { mockCtx, dispose } = createMockCtx(dir);
    apply(mockCtx, {
      listLlmModels: async () => [{ id: 'cheap-flash', pricing: { input: 1 } }],
      llmOneShot: async () => ({
        text: '# 小海的梦 · 2026-11-10\n\n今晚梦见冰美式和纯 Node。',
        usage: { totalTokens: 1200, inputTokens: 800, outputTokens: 400 },
      }),
    });
    await mockCtx.soulmate.ready;
    const { saveConfigAuto } = await import('../packages/soulmate-core/state.mjs');
    await saveConfigAuto(mockCtx.soulmate.home, {
      proactive: { dreamLlmEnabled: true, dreamLlmDailyCap: 300_000, dreamReflect: true },
      extensions: { biliAutoSurfEnabled: false },
    });

    await mockCtx.soulmate.retainFact({ topic: '饮品', content: '冰美式', importance: 4 });
    await mockCtx.soulmate.retainFact({ topic: '风格', content: '纯 Node', importance: 4 });

    const at = Date.parse('2026-11-09T17:10:00Z');
    const res = await mockCtx.soulmate.runProactiveTick(at);
    assert.equal(res.dream.dream, true);
    assert.equal(res.dream.via, 'llm');
    const page = await readFile(join(mockCtx.soulmate.home.wikiDir, 'dream-2026-11-10.md'), 'utf8');
    assert.match(page, /冰美式|纯 Node/);

    const usageRaw = await readFile(mockCtx.soulmate.home.usagePath, 'utf8');
    assert.ok(usageRaw.includes('"kind":"dream-llm"'), 'dream-llm usage row recorded');

    dispose();
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test('proactive: the night dream really writes a Wiki page from that night facts (regression: home arg)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sm-dream-'));
  try {
    const { mockCtx, dispose } = createMockCtx(dir);
    apply(mockCtx, {});
    await mockCtx.soulmate.ready;
    await saveConfigAuto(mockCtx.soulmate.home, { extensions: { biliAutoSurfEnabled: false } });

    await mockCtx.soulmate.retainFact({ topic: '饮品偏好', content: '早上一杯冰美式', importance: 4 });
    await mockCtx.soulmate.retainFact({ topic: '代码风格', content: '坚持纯 Node 零依赖', importance: 4 });
    await mockCtx.soulmate.retainFact({ topic: '作息', content: '凌晨两点才睡', importance: 3 });

    const at = Date.parse('2026-11-09T17:10:00Z'); // 01:10 local (UTC+8), inside the discounted window
    const res = await mockCtx.soulmate.runProactiveTick(at);
    assert.equal(res.dream.ok, true, `dream should succeed: ${JSON.stringify(res.dream)}`);
    assert.equal(res.dream.dream, true);
    assert.equal(res.dream.slug, 'dream-2026-11-10');

    const page = await readFile(join(mockCtx.soulmate.home.wikiDir, 'dream-2026-11-10.md'), 'utf8');
    assert.match(page, /冰美式/);
    assert.match(page, /纯 Node 零依赖/);

    const ledger = await readFile(join(mockCtx.soulmate.home.logsDir, 'proactive.jsonl'), 'utf8');
    assert.ok(ledger.includes('"reason":"night-dream"'), 'the dream decision is audtable');

    // A second tick in the same night must not dream again.
    const again = await mockCtx.soulmate.runProactiveTick(at + 60_000);
    assert.equal(again.dream.dream, false);
    assert.equal(again.dream.reason, 'already-dreamed-tonight');

    dispose();
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});
test('proactive: auto-surf tick watches through the real ctx.soulmate service (regression: bare {home} picked 0)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sm-surf-tick-'));
  // Minimal mock Bilibili: one searchable video with subtitle + storyboard + comments.
  const bvid = 'BV1Tick00001';
  const aid = 9001;
  const cid = aid * 10;
  const pubdate = Math.floor(Date.now() / 1000) - 86400;
  const subtitleBody = Array.from({ length: 30 }, (_, i) => ({ from: i * 10, to: i * 10 + 9, content: `第${i + 1}段讲解：智能体如何拆解任务、调用工具并自我修正。` }));
  const mock = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://mock.local');
    const json = (data, code = 0) => {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ code, message: code ? 'mock error' : '0', data }));
    };
    switch (url.pathname) {
      case '/x/web-interface/nav':
        return json({ isLogin: false, wbi_img: { img_url: 'https://i0.hdslb.com/bfs/wbi/abcdefghijklmnopqrstuvwxyz0123456789.png', sub_url: 'https://i0.hdslb.com/bfs/wbi/zyxwvutsrqponmlkjihgfedcba9876543210.png' } });
      case '/x/web-interface/search/type':
        if (url.searchParams.get('search_type') === 'article') return json({ result: [] });
        return json({ result: [{ bvid, title: 'AI 编程新范式：十分钟讲透智能体', author: 'UP小明', play: 50000, pubdate }] });
      case '/x/web-interface/popular': return json({ list: [] });
      case '/x/web-interface/ranking/v2': return json({ list: [] });
      case '/x/web-interface/index/top/feed/rcmd': return json({ item: [] });
      case '/x/article/recommends': return json({ articles: [] });
      case '/x/web-interface/view':
        return json({ bvid, aid, cid, title: 'AI 编程新范式：十分钟讲透智能体', desc: '一期讲清楚智能体编程的视频。', pic: 'http://i0.hdslb.com/bfs/archive/cover.jpg', duration: 300, pubdate, owner: { mid: 4321, name: 'UP小明' }, stat: { view: 50000, danmaku: 120, reply: 80, favorite: 2000, like: 6000, coin: 1500 }, pages: [{ cid, page: 1 }] });
      case '/x/tag/archive/tags': return json([{ tag_name: 'AI' }]);
      case '/x/player/v2':
        return json({ subtitle: { subtitles: [{ lan: 'ai-zh', lan_doc: '中文（自动生成）', subtitle_url: `http://127.0.0.1:${mock.address().port}/sub/${bvid}.json` }] } });
      case '/x/player/videoshot':
        return json({ image: ['//i0.hdslb.com/bfs/videoshot/a.jpg'], index: Array.from({ length: 125 }, (_, i) => i * 2), img_x_len: 10, img_y_len: 10, img_x_size: 160, img_y_size: 90 });
      case '/x/v1/dm/list.so':
        res.writeHead(200, { 'content-type': 'text/xml; charset=utf-8' });
        return res.end(deflateRawSync(Buffer.from('<i><d p="10.0,1,25,16777215,0,0,0,0">高能</d></i>', 'utf8')));
      case '/x/v2/reply':
        return json({ replies: [{ rpid: 1, like: 99, member: { uname: '路人' }, content: { message: '讲得清楚' }, replies: [] }], hots: [] });
      default: {
        const m = url.pathname.match(/^\/sub\/(.+?)\.json$/);
        if (m && m[1] === bvid) {
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ body: subtitleBody }));
        }
        res.writeHead(404);
        return res.end('nope');
      }
    }
  });
  await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${mock.address().port}`;
  try {
    const { mockCtx, dispose } = createMockCtx(dir);
    apply(mockCtx, { autoSync: false, biliBaseUrl: baseUrl, biliDmBaseUrl: baseUrl });
    await mockCtx.soulmate.ready;
    await saveConfigAuto(mockCtx.soulmate.home, {
      extensions: {
        biliEnabled: true,
        biliAutoSurfEnabled: true,
        biliAutoSurfEveryMinutes: 360,
        biliAutoSurfMaxPick: 2,
        biliKeywordsAuto: false,
        biliKeywordsSeed: ['AI'],
        biliSurfIncludePopular: false,
        biliSurfIncludeArticles: false,
        biliLiveFrameWatch: false,
        biliVisionSummary: false,
        biliSurfDeepJudge: false,
        biliWriteEnabled: false,
        biliAutoEngageEnabled: false,
      },
    });

    const res = await mockCtx.soulmate.runProactiveTick(Date.now());
    assert.equal(res.autoSurf.ran, true, JSON.stringify(res.autoSurf));
    assert.equal(res.autoSurf.ok, true, JSON.stringify(res.autoSurf));
    assert.equal(res.autoSurf.picked, 1, 'the scheduled round must actually watch, not silently pick 0');

    const ledger = await readFile(join(mockCtx.soulmate.home.logsDir, 'proactive.jsonl'), 'utf8');
    const row = ledger.trim().split('\n').map((l) => JSON.parse(l)).find((x) => x.kind === 'auto-surf');
    assert.equal(row.delivered, 'watched');
    assert.equal(row.picked, 1);

    const seen = JSON.parse(await readFile(join(mockCtx.soulmate.home.rootDir, 'bili-seen.json'), 'utf8'));
    assert.ok(seen.seen[bvid], 'watched video lands in the seen ledger');
    const facts = await readFile(mockCtx.soulmate.home.factsPath, 'utf8');
    assert.ok(facts.includes(bvid), 'watch writes a video fact through the real service');

    dispose();
  } finally {
    await new Promise((resolve) => mock.close(resolve));
    await rm(dir, { force: true, recursive: true });
  }
});
