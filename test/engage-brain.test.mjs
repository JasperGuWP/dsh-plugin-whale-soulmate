// Phase-2 brains: engage comment/reply authoring + IM whitelist proactive gate.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  composeEngageCommentPrompt,
  composeThreadReplyPrompt,
  createLlmEngageDecider,
  parseAuthoredText,
} from '../packages/soulmate-bili/engage-brain.mjs';
import { sanitizeCommentText, decideSurfEngageHeuristic } from '../packages/soulmate-bili/engage.mjs';
import {
  composeImProactivePrompt,
  evaluateImProactiveGate,
  normalizeWhitelist,
  parseImProactiveText,
} from '../packages/soulmate-core/runtime/im-proactive-runtime.mjs';

const AT = Date.parse('2026-11-23T10:00:00Z'); // 18:00 UTC+8

test('engage brain: comment prompt carries her notes and persona, forbids template praise', () => {
  const prompt = composeEngageCommentPrompt({
    digest: { title: '装机翻车合集', summary: '第3分钟供电接反，主板冒烟' },
    persona: { name: '小海', selfRef: '本鱼' },
    voice: '吐槽犀利',
    maxChars: 80,
  });
  assert.match(prompt, /装机翻车合集/);
  assert.match(prompt, /主板冒烟/);
  assert.match(prompt, /吐槽犀利/);
  assert.match(prompt, /不超过 80 字/);
  assert.match(prompt, /不评/);
  assert.match(prompt, /UP主加油/); // in the forbidden list
});

test('engage brain: thread reply prompt includes their actual words and round budget', () => {
  const prompt = composeThreadReplyPrompt({
    threadTitle: '装机翻车合集',
    theirReply: '冒烟那段我也翻过，是24pin没插到底',
    myComment: '第3分钟那下真吓人',
    persona: { selfRef: '本鱼' },
    round: 2,
    maxRounds: 2,
  });
  assert.match(prompt, /24pin没插到底/);
  assert.match(prompt, /第 2\/2 轮/);
  assert.match(prompt, /最后一轮/);
});

test('engage brain: parse declines and garbage never become posts', () => {
  assert.equal(parseAuthoredText('不评').ok, false);
  assert.equal(parseAuthoredText('不回。').ok, false);
  assert.equal(parseAuthoredText('').ok, false);
  assert.equal(parseAuthoredText('加微信看更多').ok, false);
  const good = parseAuthoredText('「24pin那下我也翻过，痛」', { maxChars: 80 });
  assert.equal(good.ok, true);
  assert.match(good.text, /24pin/);
});

test('engage brain: sanitize honours configurable length cap', () => {
  const long = '这是一段足够长的正常评论内容'.repeat(8);
  assert.equal(sanitizeCommentText(long).text.length, 100);
  const short = sanitizeCommentText(long, 40);
  assert.ok(short.text.length <= 40);
});

test('engage brain: llm decider re-authors text, keeps flags, falls back on error', async () => {
  const heuristic = { like: true, favorite: false, comment: true, commentText: '模板句', follow: false, coin: false, reason: '评分 14' };
  const decide = createLlmEngageDecider({
    oneShotLlm: async () => ({ text: '供电接反那下我隔着屏幕都疼' }),
    listHostModels: async () => [{ id: 'cheap-flash' }],
    resolveModel: () => ({ id: 'cheap-flash' }),
    maxCharsOf: async () => 80,
  });
  const plan = await decide({ digest: { title: 'T' }, persona: {}, heuristic });
  assert.equal(plan.comment, true);
  assert.equal(plan.like, true);
  assert.match(plan.commentText, /隔着屏幕都疼/);

  // model declines → comment revoked, other flags intact
  const decideDecline = createLlmEngageDecider({
    oneShotLlm: async () => ({ text: '不评' }),
    listHostModels: async () => [{ id: 'm' }],
    resolveModel: () => ({ id: 'm' }),
  });
  const declined = await decideDecline({ digest: {}, persona: {}, heuristic });
  assert.equal(declined.comment, false);
  assert.equal(declined.like, true);

  // model throws → heuristic untouched
  const decideBroken = createLlmEngageDecider({
    oneShotLlm: async () => { throw new Error('dead'); },
    listHostModels: async () => [{ id: 'm' }],
    resolveModel: () => ({ id: 'm' }),
  });
  const fallback = await decideBroken({ digest: {}, persona: {}, heuristic });
  assert.equal(fallback.commentText, '模板句');

  // no comment wanted → no call at all
  let called = 0;
  const decideNoComment = createLlmEngageDecider({
    oneShotLlm: async () => { called += 1; return { text: 'x' }; },
    listHostModels: async () => [],
    resolveModel: () => ({ id: '' }),
  });
  await decideNoComment({ digest: {}, persona: {}, heuristic: { ...heuristic, comment: false } });
  assert.equal(called, 0);
});

test('engage heuristic: coin only for near-perfect watches', () => {
  const persona = { traits: { talkative: 60, clingy: 60 } };
  assert.equal(decideSurfEngageHeuristic({ digest: { worthScore: 18 }, persona }).coin, true);
  assert.equal(decideSurfEngageHeuristic({ digest: { worthScore: 15 }, persona }).coin, false);
});

test('im gate: disabled / empty whitelist / quiet hours / quotas all silence with reasons', () => {
  const wl = [{ platform: 'qq', to: '10001' }];
  assert.equal(evaluateImProactiveGate({ nowMs: AT, ext: {} }).reason, 'disabled');
  assert.equal(evaluateImProactiveGate({ nowMs: AT, ext: { imProactiveEnabled: true } }).reason, 'empty-whitelist');
  assert.equal(
    evaluateImProactiveGate({ nowMs: AT, ext: { imProactiveEnabled: true, imProactiveWhitelist: wl }, quietHours: ['17:00-19:00'] }).reason,
    'quiet-hours'
  );
  const jr = (minsAgo, to = '10001') => ({ at: new Date(AT - minsAgo * 60000).toISOString(), platform: 'qq', to, ok: true });
  assert.equal(
    evaluateImProactiveGate({
      nowMs: AT, ext: { imProactiveEnabled: true, imProactiveWhitelist: wl, imProactiveDailyTotal: 2 },
      journal: [jr(300), jr(200)],
    }).reason,
    'daily-quota'
  );
  assert.equal(
    evaluateImProactiveGate({
      nowMs: AT, ext: { imProactiveEnabled: true, imProactiveWhitelist: wl, imProactiveMinGapMinutes: 90 },
      journal: [jr(30)],
    }).reason,
    'too-soon'
  );
  assert.equal(
    evaluateImProactiveGate({
      nowMs: AT, ext: { imProactiveEnabled: true, imProactiveWhitelist: wl, imProactivePerConvDaily: 1 },
      journal: [jr(300)],
    }).reason,
    'per-conversation-quota'
  );
  const go = evaluateImProactiveGate({
    nowMs: AT, ext: { imProactiveEnabled: true, imProactiveWhitelist: wl }, journal: [jr(300)],
  });
  assert.equal(go.send, true);
  assert.equal(go.targets.length, 1);
});

test('im gate: failed sends do not burn quota', () => {
  const wl = [{ platform: 'qq', to: '10001' }];
  const failed = { at: new Date(AT - 200 * 60000).toISOString(), platform: 'qq', to: '10001', ok: false };
  const go = evaluateImProactiveGate({
    nowMs: AT, ext: { imProactiveEnabled: true, imProactiveWhitelist: wl, imProactiveDailyTotal: 1 }, journal: [failed],
  });
  assert.equal(go.send, true);
});

test('im runtime: open group window wins over closed DM; all-closed skips without authoring', async () => {
  const { createImProactiveRuntime } = await import('../packages/soulmate-core/runtime/im-proactive-runtime.mjs');
  const { resolveSoulmateHome, saveConfigAuto } = await import('../packages/soulmate-core/state.mjs');
  const { mkdtemp, rm, mkdir } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'sm-impro-'));
  try {
    const home = resolveSoulmateHome(join(dir, 'home'));
    await mkdir(home.rootDir, { recursive: true });
    await saveConfigAuto(home, {
      extensions: {
        imProactiveEnabled: true,
        imProactiveMinGapMinutes: 1,
        imProactiveWhitelist: [
          { platform: 'qq', to: 'OWNER1', groupId: '', label: 'QQ私聊' },
          { platform: 'qq', to: '', groupId: 'G1', label: 'QQ群' },
        ],
      },
    });
    let authored = 0;
    const sent = [];
    const usage = {
      meteredCall: async ({ call }) => ({ ok: true, out: await call() }),
      listHostModels: async () => [{ id: 'm1' }],
      oneShotLlm: async () => { authored += 1; return { text: '群里冒个泡' }; },
    };
    const mk = (open) => createImProactiveRuntime({
      home, warn: () => {}, pushEvent: () => 0, usage, cfg: {},
      officialSend: async ({ target, text }) => { sent.push({ target, text }); return { ok: true, mode: 'official-bridge' }; },
      officialTargets: async () => ({ ok: true, creds: {}, targets: open }),
    });
    // Group window open: the group entry (empty `to`) must be chosen, not the DM.
    const r1 = await mk([{ kind: 'group', groupId: 'G1', peer: 'G1', appId: '1', msgId: 'X', ageMs: 1000 }])
      .runImProactiveIfDue({ at: AT });
    assert.equal(r1.sent, true, JSON.stringify(r1));
    assert.equal(sent[0].target.groupId, 'G1');
    // Every window closed: no authoring, no doomed send, honest reason.
    const before = authored;
    const r2 = await mk([]).runImProactiveIfDue({ at: AT + 10 * 60_000 });
    assert.equal(r2.ran, false);
    assert.equal(r2.reason, 'no-open-window');
    assert.equal(authored, before, 'closed windows must not burn a generation');
    assert.equal(sent.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('im prompt/parse: group visibility warned, decline respected, length capped', () => {
  const prompt = composeImProactivePrompt({
    target: { platform: 'qq', to: 'u', groupId: 'g' },
    angle: '想把刚看的视频说给他',
    voice: '嘴硬心软',
    persona: { callUser: '主人' },
    maxChars: 120,
    clock: '18:00',
  });
  assert.match(prompt, /所有人可见/);
  assert.match(prompt, /想把刚看的视频说给他/);
  assert.match(prompt, /不发/);
  assert.equal(parseImProactiveText('不发').ok, false);
  assert.equal(parseImProactiveText('').ok, false);
  const long = parseImProactiveText('哈'.repeat(200), 120);
  assert.ok(long.text.length <= 121);
});

test('whitelist normalize: only well-formed entries survive, values copied', () => {
  const list = normalizeWhitelist([
    { platform: 'qq', to: '10001', label: '主人QQ' },
    { platform: 'qq', to: '', groupId: 'G-9', label: 'QQ群' },
    { platform: '', to: 'x' },
    { platform: 'weixin' },
    null,
    'nope',
  ]);
  assert.equal(list.length, 2);
  assert.equal(list[0].label, '主人QQ');
  // Group rows arrive from the picker with an empty `to` — the group IS the address.
  assert.equal(list[1].groupId, 'G-9');
  assert.equal(list[1].to, 'G-9');
});