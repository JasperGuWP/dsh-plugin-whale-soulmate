import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isChatHomeWorkspace,
  registerKnownSession,
  sessionIdsToWatch,
  composeSessionStarSummary,
  fingerprintMeasure,
  createDebouncedRunner,
  captureSessionStarOnce,
} from '../packages/soulmate-core/session-star.mjs';
import { isWakeBubbleText, WAKE_BUBBLE_MARK } from '../packages/soulmate-core/chat-home.mjs';

test('isChatHomeWorkspace: plugin-sessions path or 消息 title', () => {
  assert.equal(
    isChatHomeWorkspace(
      { path: 'C:/Users/x/.dsh/soulmate/plugin-sessions', title: '其它' },
      { pluginSessionsDir: 'C:/Users/x/.dsh/soulmate/plugin-sessions', personaName: '小海海' },
    ),
    true,
  );
  assert.equal(
    isChatHomeWorkspace(
      { path: 'D:/agent', title: '小海海消息' },
      { pluginSessionsDir: 'C:/Users/x/.dsh/soulmate/plugin-sessions', personaName: '小海海' },
    ),
    true,
  );
  assert.equal(
    isChatHomeWorkspace(
      { path: 'D:/agent', title: '问候打招呼' },
      { pluginSessionsDir: 'C:/Users/x/.dsh/soulmate/plugin-sessions', personaName: '小海海' },
    ),
    false,
  );
});

test('registerKnownSession + sessionIdsToWatch dedupe', () => {
  let h = registerKnownSession(
    { activeSessionId: 'a', archiveSessionIds: ['b'], knownSessionIds: [] },
    'c',
  );
  h = registerKnownSession(h, 'a');
  assert.deepEqual(sessionIdsToWatch(h).sort(), ['a', 'b', 'c']);
});

test('composeSessionStarSummary skips wake bubbles and caps size', () => {
  const text = composeSessionStarSummary(
    [
      { role: 'user', text: WAKE_BUBBLE_MARK + '想打招呼' },
      { role: 'user', text: '今天一起改插件' },
      { role: 'assistant', text: '好，我们继续星空' },
    ],
    { callUser: '搭档', maxChars: 500 },
  );
  assert.ok(!isWakeBubbleText(text));
  assert.match(text, /今天一起改插件/);
  assert.ok(!text.includes('想打招呼'));
  assert.ok(text.length <= 500);
});

test('fingerprint changes when turns advance', () => {
  const a = fingerprintMeasure({ turns: 2, snippets: [{ role: 'assistant', text: 'hi' }] });
  const b = fingerprintMeasure({ turns: 3, snippets: [{ role: 'assistant', text: 'hi2' }] });
  assert.notEqual(a, b);
});

test('debounce runner coalesces bursts', async () => {
  const calls = [];
  const runner = createDebouncedRunner({ waitMs: 20, now: () => Date.now() });
  runner.schedule('s1', async () => { calls.push(1); });
  runner.schedule('s1', async () => { calls.push(2); });
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(calls, [2]);
});

test('captureSessionStarOnce upserts summary from measure', async () => {
  const writes = [];
  await captureSessionStarOnce({
    sessionId: 'session-x',
    measure: {
      snippets: [
        { role: 'user', text: '记住星空' },
        { role: 'assistant', text: '好的' },
      ],
    },
    title: '小海海',
    callUser: '搭档',
    upsert: async (input) => { writes.push(input); return { ok: true }; },
  });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].sessionId, 'session-x');
  assert.equal(writes[0].title, '小海海');
  assert.match(writes[0].content, /记住星空/);
});

test('captureSessionStarOnce skips empty / wake-only summaries', async () => {
  const writes = [];
  const out = await captureSessionStarOnce({
    sessionId: 'session-y',
    measure: {
      snippets: [{ role: 'user', text: WAKE_BUBBLE_MARK + '想打招呼' }],
    },
    title: '小海海',
    callUser: '搭档',
    upsert: async (input) => { writes.push(input); return { ok: true }; },
  });
  assert.equal(writes.length, 0);
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'empty-summary');
});
