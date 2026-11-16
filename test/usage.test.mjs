import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeUsage,
  buildUsageRow,
  buildBlockedRow,
  localDateKey,
  summarizeUsage,
  checkDailyCap,
  appendUsageRow,
  readUsageRows,
  pruneUsageRows,
  extractLatestAssistantUsage,
  sumSessionAssistantUsage,
  waitForSessionUsage,
} from '../packages/soulmate-core/usage.mjs';

/**
 * Token accounting + daily cap.
 *
 * Before this existed the plugin had no real measurement at all: `budget.mjs` only estimated
 * prompt *size* before sending, and no code ever read the model's `usage` field. Scheduled
 * work (proactive greetings, IM replies) therefore spent tokens with no record and no limit.
 */

const TZ = 480;
const local = (h, m = 0, day = 11, month = 10) => Date.UTC(2026, month, day, h, m) - TZ * 60_000;

test('normalizeUsage accepts the three shapes hosts actually return', () => {
  const openai = normalizeUsage({ usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } });
  assert.deepEqual(
    { p: openai.promptTokens, c: openai.completionTokens, t: openai.totalTokens, real: openai.real },
    { p: 100, c: 20, t: 120, real: true },
  );

  const camel = normalizeUsage({ usage: { inputTokens: 50, outputTokens: 10 } });
  assert.deepEqual({ p: camel.promptTokens, c: camel.completionTokens, t: camel.totalTokens }, { p: 50, c: 10, t: 60 });

  const totalOnly = normalizeUsage({ usage: { total_tokens: 99 } });
  assert.equal(totalOnly.totalTokens, 99);
  assert.equal(totalOnly.real, true);
});

test('normalizeUsage reports "not real" instead of inventing zero-usage', () => {
  assert.equal(normalizeUsage({ text: 'hi' }).real, false);
  assert.equal(normalizeUsage(null).real, false);
  assert.equal(normalizeUsage({ usage: {} }).real, false);
});

test('buildUsageRow prefers real usage and never marks it estimated', () => {
  const row = buildUsageRow({
    kind: 'proactive',
    trigger: 'auto',
    prompt: '一段很长的提示词',
    reply: '一句回复',
    usage: { promptTokens: 800, completionTokens: 40, totalTokens: 840, real: true },
    nowMs: local(12, 0),
  });
  assert.equal(row.totalTokens, 840);
  assert.equal(row.estimated, false);
  assert.equal(row.dateKey, '2026-11-11');
  assert.equal(row.blocked, false);
});

test('buildUsageRow falls back to an estimate and flags the row', () => {
  const row = buildUsageRow({
    kind: 'im',
    trigger: 'user',
    prompt: '你好',
    reply: '在的',
    usage: { real: false, totalTokens: 0 },
    nowMs: local(12, 0),
  });
  assert.ok(row.totalTokens > 0, 'an estimate is still better than nothing for the cap');
  assert.equal(row.estimated, true, 'the UI must be able to say this is an estimate');
});

test('buildUsageRow rejects unknown kinds/triggers instead of storing garbage', () => {
  const row = buildUsageRow({ kind: 'hacker', trigger: 'root', prompt: 'x' });
  assert.equal(row.kind, 'chat');
  assert.equal(row.trigger, 'user');
});

test('a blocked attempt is recorded as a row, not silently dropped', () => {
  const row = buildBlockedRow({ kind: 'proactive', note: 'daily token cap reached', nowMs: local(12, 0) });
  assert.equal(row.blocked, true);
  assert.equal(row.trigger, 'auto');
  assert.equal(row.totalTokens, 0);
});

test('localDateKey follows the configured offset, not UTC', () => {
  // 23:30 UTC is already "tomorrow" in UTC+8 — a UTC-keyed ledger would file it under the wrong day.
  const at = Date.parse('2026-11-10T23:30:00Z');
  assert.equal(localDateKey(at, 480), '2026-11-11');
  assert.equal(localDateKey(at, 0), '2026-11-10');
});

test('summarizeUsage splits today by kind and by trigger', () => {
  const rows = [
    buildUsageRow({ kind: 'proactive', trigger: 'auto', usage: { totalTokens: 300, real: true }, nowMs: local(9, 0) }),
    buildUsageRow({ kind: 'proactive', trigger: 'auto', usage: { totalTokens: 200, real: true }, nowMs: local(18, 0) }),
    buildUsageRow({ kind: 'im', trigger: 'user', usage: { totalTokens: 100, real: true }, nowMs: local(20, 0) }),
    // Yesterday's row must not leak into today.
    buildUsageRow({ kind: 'proactive', trigger: 'auto', usage: { totalTokens: 9999, real: true }, nowMs: local(9, 0, 10) }),
  ];
  const s = summarizeUsage(rows, { nowMs: local(21, 0), tzOffsetMinutes: TZ });
  assert.equal(s.totalTokens, 600);
  assert.equal(s.autoTokens, 500);
  assert.equal(s.userTokens, 100);
  assert.equal(s.calls, 3);
  assert.equal(s.byKind.find((b) => b.kind === 'proactive').totalTokens, 500);
});

test('summarizeUsage counts blocked attempts separately from spend', () => {
  const rows = [
    buildUsageRow({ kind: 'proactive', trigger: 'auto', usage: { totalTokens: 100, real: true }, nowMs: local(9, 0) }),
    buildBlockedRow({ kind: 'proactive', nowMs: local(10, 0) }),
    buildBlockedRow({ kind: 'proactive', nowMs: local(11, 0) }),
  ];
  const s = summarizeUsage(rows, { nowMs: local(12, 0), tzOffsetMinutes: TZ });
  assert.equal(s.totalTokens, 100, 'a blocked call spends nothing');
  assert.equal(s.blocked, 2);
  assert.equal(s.calls, 1);
});

test('cap: automatic work is refused at the line, user work never is', () => {
  const rows = [buildUsageRow({ kind: 'proactive', trigger: 'auto', usage: { totalTokens: 1000, real: true }, nowMs: local(9, 0) })];
  const opts = { rows, cap: 1000, nowMs: local(12, 0), tzOffsetMinutes: TZ };

  const auto = checkDailyCap({ ...opts, trigger: 'auto', kind: 'proactive' });
  assert.equal(auto.allow, false);
  assert.equal(auto.reason, 'daily-cap-reached');

  const user = checkDailyCap({ ...opts, trigger: 'user', kind: 'im' });
  assert.equal(user.allow, true, 'never block the person in front of you');
  assert.equal(user.reason, 'user-initiated');
});

test('cap: below the line passes, and a cap of 0 means "no cap"', () => {
  const rows = [buildUsageRow({ kind: 'proactive', trigger: 'auto', usage: { totalTokens: 400, real: true }, nowMs: local(9, 0) })];
  const under = checkDailyCap({ rows, cap: 1000, trigger: 'auto', nowMs: local(12, 0), tzOffsetMinutes: TZ });
  assert.equal(under.allow, true);
  assert.equal(under.remaining, 600);

  const uncapped = checkDailyCap({ rows, cap: 0, trigger: 'auto', nowMs: local(12, 0), tzOffsetMinutes: TZ });
  assert.equal(uncapped.allow, true);
  assert.equal(uncapped.reason, 'no-cap');
});

test('cap: only automatic spend counts toward the auto budget', () => {
  const rows = [
    buildUsageRow({ kind: 'im', trigger: 'user', usage: { totalTokens: 5000, real: true }, nowMs: local(9, 0) }),
    buildUsageRow({ kind: 'proactive', trigger: 'auto', usage: { totalTokens: 100, real: true }, nowMs: local(10, 0) }),
  ];
  const res = checkDailyCap({ rows, cap: 1000, trigger: 'auto', nowMs: local(12, 0), tzOffsetMinutes: TZ });
  assert.equal(res.allow, true, 'a long chat with the user must not eat the background budget');
  assert.equal(res.used, 100);
});

test('ledger round-trips through disk and survives a torn line', async () => {
  const { mkdtemp, rm, appendFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dir = await mkdtemp(join(tmpdir(), 'sm-usage-'));
  try {
    const path = join(dir, 'logs', 'usage.jsonl');
    await appendUsageRow(path, buildUsageRow({ kind: 'proactive', trigger: 'auto', usage: { totalTokens: 42, real: true } }));
    await appendFile(path, '{"broken":\n', 'utf8'); // simulate a crash mid-write
    await appendUsageRow(path, buildUsageRow({ kind: 'im', trigger: 'user', usage: { totalTokens: 8, real: true } }));
    const rows = await readUsageRows(path);
    assert.equal(rows.length, 2, 'the torn line is skipped, not fatal');
    assert.equal(rows.reduce((a, r) => a + r.totalTokens, 0), 50);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('readUsageRows treats a missing ledger as empty', async () => {
  const rows = await readUsageRows('Z:/definitely/not/here/usage.jsonl');
  assert.deepEqual(rows, []);
});

test('pruneUsageRows keeps the recent window and reports the drop', () => {
  const now = local(12, 0, 11);
  const old = buildUsageRow({ kind: 'proactive', usage: { totalTokens: 1, real: true }, nowMs: now - 120 * 86_400_000 });
  const fresh = buildUsageRow({ kind: 'proactive', usage: { totalTokens: 2, real: true }, nowMs: now - 1 * 86_400_000 });
  const out = pruneUsageRows([old, fresh], { nowMs: now, keepDays: 90 });
  assert.equal(out.rows.length, 1);
  assert.equal(out.dropped, 1);
});

test('extractLatestAssistantUsage reads TokenUsage off assistant/message events', () => {
  const empty = extractLatestAssistantUsage({ records: [] });
  assert.equal(empty.assistantCount, 0);
  assert.equal(empty.usage.real, false);

  const page = {
    records: [
      {
        type: 'event',
        event: {
          type: 'user/message',
          data: { id: 'u1', content: [{ type: 'text', text: 'hi' }] },
        },
      },
      {
        type: 'event',
        event: {
          type: 'assistant/message',
          data: {
            usage: { inputTokens: 120, outputTokens: 40, totalTokens: 160 },
            message: { id: 'a1', content: [{ type: 'text', text: '你好呀' }] },
          },
        },
      },
    ],
  };
  const hit = extractLatestAssistantUsage(page);
  assert.equal(hit.assistantCount, 1);
  assert.equal(hit.messageId, 'a1');
  assert.equal(hit.text, '你好呀');
  assert.equal(hit.usage.real, true);
  assert.equal(hit.usage.totalTokens, 160);
  assert.equal(hit.rawUsage.inputTokens, 120);
});

test('extractLatestAssistantUsage ignores reasoning / tool blocks in toast text', () => {
  const page = {
    records: [
      {
        type: 'event',
        event: {
          type: 'assistant/message',
          data: {
            usage: { inputTokens: 10, outputTokens: 5 },
            message: {
              id: 'a-mix',
              content: [
                { type: 'reasoning', text: '思考 · User wants more 要闻. Search for more.' },
                { type: 'tool-call', text: '网页搜索 · 国际新闻' },
                { type: 'text', text: '挑几条还没说的，按块给你：' },
              ],
            },
          },
        },
      },
    ],
  };
  const hit = extractLatestAssistantUsage(page);
  assert.equal(hit.text, '挑几条还没说的，按块给你：');
  assert.ok(!hit.text.includes('思考'));
  assert.ok(!hit.text.includes('网页搜索'));
});

test('sumSessionAssistantUsage aggregates host trajectory turns', () => {
  const page = {
    records: [
      {
        type: 'event',
        event: {
          type: 'assistant/message',
          data: {
            usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
            message: { id: 'a1', content: [{ type: 'text', text: '一' }] },
          },
        },
      },
      {
        type: 'event',
        event: {
          type: 'assistant/message',
          data: {
            usage: { inputTokens: 200, outputTokens: 30, totalTokens: 230 },
            message: { id: 'a2', content: [{ type: 'text', text: '二' }] },
          },
        },
      },
      {
        type: 'event',
        event: {
          type: 'assistant/message',
          data: { message: { id: 'a3', content: [{ type: 'text', text: '无 usage' }] } },
        },
      },
    ],
  };
  const sum = sumSessionAssistantUsage(page);
  assert.equal(sum.turns, 3);
  assert.equal(sum.withUsage, 2);
  assert.equal(sum.totalTokens, 350);
  assert.equal(sum.promptTokens, 300);
  assert.equal(sum.completionTokens, 50);
});

test('waitForSessionUsage waits for whenIdle then returns provider usage', async () => {
  let idle = false;
  const controller = {
    async resolveAgent() {
      return {
        whenIdle: async () => {
          idle = true;
        },
      };
    },
    async events() {
      assert.equal(idle, true, 'must wait for idle before reading events');
      return {
        records: [
          {
            type: 'event',
            event: {
              type: 'assistant/message',
              data: {
                usage: { inputTokens: 90, outputTokens: 30 },
                message: { id: 'a-new', content: [{ type: 'text', text: '醒了' }] },
              },
            },
          },
        ],
      };
    },
  };
  const out = await waitForSessionUsage(controller, {
    sessionId: 'sess-1',
    beforeMessageId: 'a-old',
    beforeAssistantCount: 0,
    timeoutMs: 2000,
    pollMs: 50,
  });
  assert.equal(out.ok, true);
  assert.equal(out.idleWaited, true);
  assert.equal(out.usage.real, true);
  assert.equal(out.usage.totalTokens, 120);
  assert.equal(out.text, '醒了');
});

test('isToastWorthyReply rejects wake meta / English test prompts', async () => {
  const { isToastWorthyReply } = await import('../packages/soulmate-core/usage.mjs');
  assert.equal(isToastWorthyReply('我在。这句今天第三次了——新窗口。'), true);
  assert.equal(isToastWorthyReply('Same wake message again. Note the GUI URL changed (53795)'), false);
  assert.equal(isToastWorthyReply('Same wake again, 12 minutes later, new port 50396. Keep it very short.'), false);
  assert.equal(isToastWorthyReply('Again. Keep it to one short line. Maybe vary. "在。第八回。" Actually counting: turn1 wake'), false);
  assert.equal(isToastWorthyReply('hello only'), false);
  const { companionSpokenText } = await import('../packages/soulmate-core/usage.mjs');
  assert.match(
    companionSpokenText('用户就是闲聊问候。简短回应，别长篇。不需要工具调用。人设：沉静守护者，话少。晚间闲聊时段。\n\n在等你说话呢。海面挺静。'),
    /^在等你说话呢/,
  );
  assert.match(
    companionSpokenText('保持沉静守护者人设，话少。\n我在。晚上了，海面挺安静的。\n\n你这边忙完了吗？'),
    /^我在。/,
  );
  assert.equal(
    isToastWorthyReply('保持沉静守护者人设，话少。\n我在。晚上了，海面挺安静的。'),
    true,
  );
  assert.match(
    isToastWorthyReply('用户就是闲聊问候。简短回应，别长篇。不需要工具调用。人设：沉静守护者。\n\n今晚的几条，挑硬的说：时政…')
      ? 'ok'
      : 'bad',
    /ok/,
  );
  assert.equal(isToastWorthyReply('大哥想跟你打个招呼', { rejectTexts: ['大哥想跟你打个招呼'] }), false);
  assert.equal(isToastWorthyReply('【Soulmate 插件·开机问候·勿复述】请打招呼'), false);
});

test('waitForSessionUsage without whenIdle fails fast when nothing arrives', async () => {
  const started = Date.now();
  const out = await waitForSessionUsage(
    { async events() { return { records: [] }; } },
    { sessionId: 'sess-x', timeoutMs: 5000, pollMs: 50 },
  );
  assert.equal(out.ok, false);
  assert.ok(Date.now() - started < 2000, 'must not block for the full timeout without whenIdle');
});