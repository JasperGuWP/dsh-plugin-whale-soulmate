import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../index.js';
import { DEFAULT_CONFIG, loadConfig, saveConfigAuto } from '../packages/soulmate-core/state.mjs';
import {
  applyAdopt,
  applyRotate,
  buildWakeInstructions,
  buildWakeVisibleNotice,
  stripWakeBubbleMark,
  WAKE_BUBBLE_MARK,
  isWakeBubbleText,
  buildPetSay,
  composeHandoffSummary,
  deliverViaPrompt,
  ensureChatHomeSession,
  isSessionFull,
  measureFromRecords,
  normalizeChatHome,
  titleForIndex,
} from '../packages/soulmate-core/chat-home.mjs';

test('chatHome: defaults ship enabled boot + rotate thresholds', () => {
  assert.equal(DEFAULT_CONFIG.chatHome.bootGreeting, true);
  assert.equal(DEFAULT_CONFIG.chatHome.maxTurns, 500);
  assert.equal(DEFAULT_CONFIG.chatHome.maxEstTokens, 72_000);
  assert.equal(DEFAULT_CONFIG.chatHome.titlePrefix, 'soulmate');
  const n = normalizeChatHome({});
  assert.equal(n.nextIndex, 1);
  assert.deepEqual(n.archiveSessionIds, []);
});

test('chatHome: autoMemory default true and knownSessionIds normalize', () => {
  const d = normalizeChatHome({});
  assert.equal(d.autoMemory, true);
  assert.deepEqual(d.knownSessionIds, []);

  const n = normalizeChatHome({
    autoMemory: false,
    knownSessionIds: ['s1', 's1', '', 's2'],
    archiveSessionIds: ['s0'],
  });
  assert.equal(n.autoMemory, false);
  assert.deepEqual(n.knownSessionIds, ['s1', 's2']);
});

test('chatHome: full when turns OR tokens hit first', () => {
  const limits = { maxTurns: 10, maxEstTokens: 1000 };
  assert.equal(isSessionFull({ turns: 10, estTokens: 10 }, limits).full, true);
  assert.equal(isSessionFull({ turns: 10, estTokens: 10 }, limits).reason, 'max-turns');
  assert.equal(isSessionFull({ turns: 2, estTokens: 1000 }, limits).reason, 'max-tokens');
  assert.equal(isSessionFull({ turns: 2, estTokens: 10 }, limits).full, false);
});

test('chatHome: measure counts user/assistant surface records', () => {
  const page = {
    hasMore: false,
    records: [
      { type: 'event', event: { type: 'turn/start', data: {} } },
      {
        type: 'event',
        event: {
          type: 'user/message',
          data: { role: 'user', content: [{ type: 'text', text: '你好呀' }] },
        },
      },
      {
        type: 'event',
        event: {
          type: 'assistant/message',
          data: { message: { role: 'assistant', content: [{ type: 'text', text: '在的' }] } },
        },
      },
    ],
  };
  const m = measureFromRecords(page);
  assert.equal(m.turns, 2);
  assert.ok(m.estTokens > 0);
  assert.equal(m.snippets.length, 2);
});

test('chatHome: rotate archives old id and bumps index', () => {
  const next = applyRotate(
    { activeSessionId: 'old-1', archiveSessionIds: [], nextIndex: 2, titlePrefix: '大肥鱼' },
    'new-2',
  );
  assert.equal(next.activeSessionId, 'new-2');
  assert.deepEqual(next.archiveSessionIds, ['old-1']);
  assert.equal(next.nextIndex, 3);
  assert.equal(titleForIndex('大肥鱼', 1), '大肥鱼');
  assert.equal(titleForIndex('大肥鱼', 3), '大肥鱼 · 3');
  assert.equal(titleForIndex('大海', 1, '暗黑'), '大海 · 暗黑');
  assert.equal(titleForIndex('大海', 8, '暗黑'), '大海 · 暗黑 · 8');
  assert.equal(applyAdopt({ nextIndex: 1 }, 's1').activeSessionId, 's1');
});

test('chatHome: wake prompts stay short and kind-specific', () => {
  const instr = buildWakeInstructions('boot', { callUser: '阿米' });
  assert.match(instr, /开机|招呼/);
  const boot = buildWakeVisibleNotice('boot', { callUser: '阿米' });
  assert.equal(isWakeBubbleText(boot), true);
  assert.ok(boot.startsWith(WAKE_BUBBLE_MARK));
  assert.doesNotMatch(stripWakeBubbleMark(boot), /系统·开机问候/);
  assert.match(stripWakeBubbleMark(buildWakeVisibleNotice('boot', { callUser: '阿米', name: '小鲸' })), /小鲸/);
  assert.match(stripWakeBubbleMark(buildWakeVisibleNotice('boot', { callUser: '阿米' })), /soulmate/);
  assert.match(buildPetSay('boot', { callUser: '阿米' }), /阿米/);
  assert.doesNotMatch(buildPetSay('boot', { callUser: '阿米', preset: 'cool-senpai' }), /醒了～/);
  assert.match(buildPetSay('boot', { callUser: '阿米', preset: 'cool-senpai' }), /别指望太热情/);
  assert.match(buildPetSay('boot', { callUser: '搭档', preset: 'rice-whale' }), /本鱼醒了/);
  assert.match(buildPetSay('boot', { callUser: '你', preset: 'quiet-guardian' }), /醒了/);
  assert.match(buildWakeInstructions('boot', { callUser: '阿米', selfRef: '我', preset: 'cool-senpai' }), /人设口吻|禁止套用固定撒娇/);
  assert.match(buildWakeInstructions('proactive', { hint: '该吃饭了' }), /该吃饭了/);
  assert.match(buildWakeInstructions('handoff-seed', {}), /交接/);
  assert.match(composeHandoffSummary([{ role: 'user', text: '明天开会' }]), /明天开会/);
  assert.doesNotMatch(
    composeHandoffSummary([
      { role: 'user', text: '<system-reminder> Current working directory: "<HOME>/.dsh/soulmate/plugin-sessions"' },
      { role: 'user', text: 'soulmate-wake大海想跟你打个招呼' },
      { role: 'user', text: '明天开会' },
    ]),
    /system-reminder|plugin-sessions|soulmate-wake/,
  );
  assert.match(
    composeHandoffSummary([
      { role: 'user', text: '<system-reminder> cwd' },
      { role: 'user', text: '明天开会' },
    ]),
    /明天开会/,
  );
});

test('chatHome: ensure creates, renames, and rotates when full', async () => {
  const created = [];
  const prompts = [];
  const renamed = [];
  let seq = 0;
  const controller = {
    async create() {
      seq += 1;
      const sessionId = `sess-${seq}`;
      created.push(sessionId);
      return { sessionId };
    },
    async rename(req) {
      renamed.push(req);
      return { title: req.title };
    },
    async prompt(req) {
      prompts.push(req);
      return { accepted: true };
    },
    async events({ address }) {
      if (address.sessionId === 'sess-1') {
        // Over turn limit
        const records = [];
        for (let i = 0; i < 12; i += 1) {
          records.push({
            type: 'event',
            event: {
              type: i % 2 === 0 ? 'user/message' : 'assistant/message',
              data: i % 2 === 0
                ? { content: [{ type: 'text', text: `u${i}` }] }
                : { message: { content: [{ type: 'text', text: `a${i}` }] } },
            },
          });
        }
        return { records, hasMore: false };
      }
      return { records: [], hasMore: false };
    },
  };

  const handoffs = [];
  const first = await ensureChatHomeSession({
    chatHome: { maxTurns: 10, maxEstTokens: 999999, titlePrefix: '大肥鱼', nextIndex: 1 },
    controller,
    persona: { callUser: '搭档' },
    onHandoff: async (summary, meta) => { handoffs.push({ summary, meta }); },
    seedAfterRotate: false,
  });
  assert.equal(first.ok, true);
  assert.equal(first.sessionId, 'sess-1');
  assert.equal(first.rotated, false);
  assert.equal(renamed[0].title, '大肥鱼');

  const second = await ensureChatHomeSession({
    chatHome: first.chatHome,
    controller,
    persona: { callUser: '搭档' },
    onHandoff: async (summary, meta) => { handoffs.push({ summary, meta }); },
    seedAfterRotate: true,
  });
  assert.equal(second.ok, true);
  assert.equal(second.rotated, true);
  assert.equal(second.sessionId, 'sess-2');
  assert.deepEqual(second.chatHome.archiveSessionIds, ['sess-1']);
  assert.equal(handoffs.length, 1);
  assert.equal(prompts.length, 1, 'handoff-seed prompt when seedAfterRotate');
  assert.match(prompts[0].content[0].text, /大肥鱼|换了个窗/);
  assert.doesNotMatch(prompts[0].content[0].text, /勿复述/);
});

test('chatHome: rotateIfFull false reuses full window (IM)', async () => {
  const created = [];
  let seq = 0;
  const controller = {
    async create() {
      seq += 1;
      const sessionId = `im-sess-${seq}`;
      created.push(sessionId);
      return { sessionId };
    },
    async rename() { return {}; },
    async events({ address }) {
      if (address.sessionId === 'im-sess-1') {
        const records = [];
        for (let i = 0; i < 12; i += 1) {
          records.push({
            type: 'event',
            event: {
              type: i % 2 === 0 ? 'user/message' : 'assistant/message',
              data: i % 2 === 0
                ? { content: [{ type: 'text', text: `u${i}` }] }
                : { message: { content: [{ type: 'text', text: `a${i}` }] } },
            },
          });
        }
        return { records, hasMore: false };
      }
      return { records: [], hasMore: false };
    },
  };
  const handoffs = [];
  const first = await ensureChatHomeSession({
    chatHome: { maxTurns: 10, maxEstTokens: 999999, titlePrefix: '大海', nextIndex: 1 },
    controller,
    seedAfterRotate: false,
  });
  assert.equal(first.sessionId, 'im-sess-1');

  const kept = await ensureChatHomeSession({
    chatHome: first.chatHome,
    controller,
    onHandoff: async () => { handoffs.push(1); },
    seedAfterRotate: false,
    rotateIfFull: false,
  });
  assert.equal(kept.ok, true);
  assert.equal(kept.rotated, false);
  assert.equal(kept.sessionId, 'im-sess-1');
  assert.equal(kept.reusedDespiteFull, true);
  assert.equal(handoffs.length, 0);
  assert.equal(created.length, 1);
});

test('chatHome: deliverViaPrompt requires prompt API', async () => {
  const miss = await deliverViaPrompt({}, { sessionId: 'x', wakeText: 'hi' });
  assert.equal(miss.ok, false);
  assert.equal(miss.reason, 'no-prompt-api');

  // resolveAgent/followup alone is not enough — must have prompt (identified messages).
  const followupOnly = await deliverViaPrompt(
    {
      async resolveAgent() {
        return { agent: { followup() { throw new Error('should-not-call'); } } };
      },
    },
    { sessionId: 'x', kind: 'boot', wakeText: 'hello' },
  );
  assert.equal(followupOnly.ok, false);
  assert.equal(followupOnly.reason, 'no-prompt-api');

  let sawSignal = false;
  const ok = await deliverViaPrompt(
    {
      prompt: async (_req, signal) => {
        sawSignal = Boolean(signal && typeof signal.throwIfAborted === 'function');
        signal.throwIfAborted();
        return { accepted: true };
      },
    },
    { sessionId: 'x', kind: 'boot', wakeText: 'hello' },
  );
  assert.equal(ok.ok, true);
  assert.equal(ok.via, 'host');
  assert.equal(sawSignal, true, 'host prompt(request, signal) must receive an AbortSignal');
});

test('chatHome: unreadable active session is kept (no new「· N」window)', async () => {
  const created = [];
  const controller = {
    async create() {
      const id = `sess-${created.length + 1}`;
      created.push(id);
      return { sessionId: id };
    },
    async rename({ title }) { return { title }; },
    async events() {
      throw new Error('stored session "session-x" is corrupt: session event at seq 9 lacks an identified message');
    },
  };
  const first = await ensureChatHomeSession({
    chatHome: { activeSessionId: 'broken-old', nextIndex: 2, titlePrefix: '小鲸' },
    controller,
    persona: { name: '小鲸', callUser: '阿米' },
    seedAfterRotate: false,
  });
  assert.equal(first.ok, true);
  assert.equal(first.rotated, false);
  assert.equal(first.keptDespiteMeasureError, true);
  assert.equal(first.sessionId, 'broken-old');
  assert.equal(created.length, 0, 'must not create a replacement window');
});

function createMockCtx(dir, { sessionController } = {}) {
  const disposers = [];
  const routes = new Map();
  const mockCtx = {
    tools: { register() { return () => {}; } },
    systemPrompt: { section() { return () => {}; }, context() { return () => {}; } },
    effect(fn) { const d = fn(); if (typeof d === 'function') disposers.push(d); },
    provide() {},
    sessionController,
    set(k, v) { mockCtx[k] = v; },
    get(k) {
      if (k === 'dshHomePath') return (...segs) => join(dir, ...segs);
      if (k === 'webServer') return mockCtx._webServer();
      if (k === 'sessionController') return mockCtx.sessionController;
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
  return {
    mockCtx,
    routes,
    dispose: () => { while (disposers.length) disposers.pop()(); },
  };
}

function assistantUsagePage(id = 'a-boot', tokens = { inputTokens: 100, outputTokens: 25 }) {
  return {
    records: [
      {
        type: 'event',
        event: {
          type: 'assistant/message',
          data: {
            usage: tokens,
            message: { id, content: [{ type: 'text', text: '嗨，我醒了' }] },
          },
        },
      },
    ],
    hasMore: false,
  };
}

test('chatHome: host deliverer uses prompt into dedicated session', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sm-chathome-'));
  try {
    const prompts = [];
    let n = 0;
    let prompted = false;
    const sessionController = {
      async create() {
        n += 1;
        return { sessionId: `home-${n}` };
      },
      async rename() { return { title: '大肥鱼' }; },
      async prompt(req) {
        prompts.push(req);
        prompted = true;
        return { accepted: true };
      },
      async resolveAgent() {
        return { whenIdle: async () => {} };
      },
      async events() {
        // Before prompt: empty; after prompt+idle: provider usage for the new turn.
        if (!prompted) return { records: [], hasMore: false };
        return assistantUsagePage();
      },
    };
    const { mockCtx, routes, dispose } = createMockCtx(dir, { sessionController });
    apply(mockCtx, { proactive: false });
    await mockCtx.soulmate.ready;

    // Before onboarding the factory persona is neutral; boot must wait for the chosen voice.
    mockCtx.soulmate.resetBootGreetingFlag();
    const pending = await mockCtx.soulmate.runBootGreeting();
    assert.equal(pending.ran, false);
    assert.equal(pending.reason, 'onboarding-pending');
    await saveConfigAuto(mockCtx.soulmate.home, { onboardingCompleted: true });

    mockCtx.soulmate.resetBootGreetingFlag();
    const boot = await mockCtx.soulmate.runBootGreeting({ force: true });
    assert.equal(boot.ran, true, JSON.stringify(boot));
    assert.ok(prompts.length >= 1);
    // Visible chat notice is short plugin copy — never the long 【系统·开机问候】 dump.
    assert.match(prompts[0].content[0].text, /大肥鱼|招呼/);
    assert.doesNotMatch(prompts[0].content[0].text, /勿复述本指令/);
    // Delivery must go through sessionController.prompt (identified messages).
    assert.match(String(prompts[0].requestId), /^[0-9a-f-]{36}$/i);

    // Ledger must record provider usage (not the ※ estimate fallback).
    const { readUsageRows } = await import('../packages/soulmate-core/usage.mjs');
    const rows = await readUsageRows(mockCtx.soulmate.home.usagePath);
    const bootRow = rows.find((r) => r.kind === 'boot' && !r.blocked);
    assert.ok(bootRow, 'boot usage row');
    assert.equal(bootRow.estimated, false);
    assert.equal(bootRow.totalTokens, 125);

    const conf = await loadConfig(mockCtx.soulmate.home);
    assert.equal(conf.chatHome.activeSessionId, 'home-1');

    const statusHandler = routes.get('GET /dsh-soulmate/api/proactive/status');
    const status = JSON.parse((await statusHandler({ method: 'GET', url: '/x', query: new URLSearchParams() })).body);
    assert.equal(status.ok, true);
    assert.equal(status.chatHome.chatHome.activeSessionId, 'home-1');
    assert.equal(status.chatHome.hasPromptApi, true);

    // Second boot in-process is skipped unless reset.
    const again = await mockCtx.soulmate.runBootGreeting();
    assert.equal(again.reason, 'already-this-process');

    // Failed boots must not burn the once-per-process flag.
    mockCtx.soulmate.resetBootGreetingFlag();
    const broken = {
      async create() { return { sessionId: 'broken' }; },
      async rename() { return {}; },
      async prompt() { throw new Error('model-unavailable'); },
      async events() { return { records: [], hasMore: false }; },
    };
    mockCtx.set('sessionController', broken);
    // Re-bind get path used by apply's closure — hostDeliverer reads ctx.get each call.
    const fail = await mockCtx.soulmate.runBootGreeting({ force: true });
    assert.equal(fail.ran, false);
    assert.ok(fail.reason);
    let retryPrompted = false;
    const retryOk = {
      async create() { return { sessionId: 'home-retry' }; },
      async rename() { return {}; },
      async prompt(req) { prompts.push(req); retryPrompted = true; return { accepted: true }; },
      async resolveAgent() { return { whenIdle: async () => {} }; },
      async events() {
        if (!retryPrompted) return { records: [], hasMore: false };
        return assistantUsagePage('a-retry', { inputTokens: 10, outputTokens: 5 });
      },
    };
    mockCtx.set('sessionController', retryOk);
    const recovered = await mockCtx.soulmate.runBootGreeting({ force: true });
    assert.equal(recovered.ran, true, JSON.stringify(recovered));

    dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('chatHome: ensureHomeSession registers knownSessionIds', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sm-known-sess-'));
  try {
    const sessionController = {
      async create() { return { sessionId: 'home-known-1' }; },
      async rename() { return { title: '大肥鱼' }; },
      async prompt() { return { accepted: true }; },
      async events() { return { records: [], hasMore: false }; },
    };
    const { mockCtx, dispose } = createMockCtx(dir, { sessionController });
    apply(mockCtx, { proactive: false });
    await mockCtx.soulmate.ready;

    const res = await mockCtx.soulmate.ensureHomeSession({ seedAfterRotate: false });
    assert.equal(res.ok, true);
    assert.equal(res.sessionId, 'home-known-1');

    const conf = await loadConfig(mockCtx.soulmate.home);
    assert.ok(
      conf.chatHome.knownSessionIds.includes('home-known-1'),
      `expected knownSessionIds to include home-known-1, got ${JSON.stringify(conf.chatHome.knownSessionIds)}`,
    );

    dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('chatHome: rotate handoff writes episode into memory home', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sm-handoff-'));
  try {
    let n = 1; // active is already h-1; next create must be h-2
    const sessionController = {
      async create() {
        n += 1;
        return { sessionId: `h-${n}` };
      },
      async rename() { return {}; },
      async prompt() { return { accepted: true }; },
      async events({ address }) {
        if (address.sessionId !== 'h-1') return { records: [], hasMore: false };
        const records = [];
        for (let i = 0; i < 8; i += 1) {
          records.push({
            type: 'event',
            event: {
              type: 'user/message',
              data: { content: [{ type: 'text', text: `要点${i} 明天一起吃饭` }] },
            },
          });
        }
        return { records, hasMore: false };
      },
    };
    const { mockCtx, dispose } = createMockCtx(dir, { sessionController });
    apply(mockCtx, { proactive: false });
    await mockCtx.soulmate.ready;

    // Seed active session with a tiny maxTurns so the next ensure rotates.
    const { saveConfigAuto } = await import('../packages/soulmate-core/state.mjs');
    await saveConfigAuto(mockCtx.soulmate.home, {
      chatHome: { activeSessionId: 'h-1', nextIndex: 2, maxTurns: 5, maxEstTokens: 999999, bootGreeting: false },
    });

    const res = await mockCtx.soulmate.ensureHomeSession({ seedAfterRotate: false });
    assert.equal(res.rotated, true);
    assert.equal(res.sessionId, 'h-2');

    const conf = await loadConfig(mockCtx.soulmate.home);
    assert.deepEqual(conf.chatHome.archiveSessionIds, ['h-1']);

    // Episode file for today should mention 交接
    const episodesDir = mockCtx.soulmate.home.episodesDir;
    const { readdir } = await import('node:fs/promises');
    const files = await readdir(episodesDir).catch(() => []);
    assert.ok(files.length >= 1, 'handoff should write an episode');
    const body = await readFile(join(episodesDir, files[0]), 'utf8');
    assert.match(body, /交接|吃饭/);

    dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('chatHome: persona change rotates a fresh window when enabled, stays when disabled', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sm-preset-rotate-'));
  try {
    let n = 1;
    const renamed = [];
    const sessionController = {
      async create() { n += 1; return { sessionId: `p-${n}` }; },
      async rename(req) { renamed.push(req); return {}; },
      async prompt() { return { accepted: true }; },
      async events() { return { records: [], hasMore: false }; },
    };
    const { mockCtx, dispose } = createMockCtx(dir, { sessionController });
    apply(mockCtx, { proactive: false });
    await mockCtx.soulmate.ready;
    await saveConfigAuto(mockCtx.soulmate.home, {
      onboardingCompleted: true,
      chatHome: { activeSessionId: 'p-1', nextIndex: 2, bootGreeting: false },
    });

    // 开关开：换人设 → 新窗 + 旧窗归档，标题带性格「soulmate · 冷感 · 2」。
    await mockCtx.soulmate.evolvePersona({ mode: 'user_customize', preset: 'cool-senpai', gender: 'male' });
    let conf = await loadConfig(mockCtx.soulmate.home);
    assert.equal(conf.chatHome.activeSessionId, 'p-2');
    assert.deepEqual(conf.chatHome.archiveSessionIds, ['p-1']);
    assert.ok(renamed.some((r) => r.sessionId === 'p-2' && r.title === 'soulmate · 冷感 · 2'),
      `expected personality-tagged title, got ${JSON.stringify(renamed)}`);

    // 开关关：再换人设 → 窗不动，但标题换成新性格。
    await saveConfigAuto(mockCtx.soulmate.home, { chatHome: { rotateOnPersonaChange: false } });
    await mockCtx.soulmate.evolvePersona({ mode: 'user_customize', preset: 'quiet-guardian', gender: 'male' });
    conf = await loadConfig(mockCtx.soulmate.home);
    assert.equal(conf.chatHome.activeSessionId, 'p-2');
    assert.ok(renamed.some((r) => r.sessionId === 'p-2' && r.title === 'soulmate · 沉静 · 2'),
      `expected renamed title on no-rotate path, got ${JSON.stringify(renamed)}`);

    dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
