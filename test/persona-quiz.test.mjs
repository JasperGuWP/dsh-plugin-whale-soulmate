import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildWakeInstructions,
  buildWakeVisibleNotice,
  buildPetSay,
  tryFocusSession,
  WAKE_BUBBLE_MARK,
  isWakeBubbleText,
  stripWakeBubbleMark,
} from '../packages/soulmate-core/chat-home.mjs';

test('persona-quiz wake: instructions require confirm before write', () => {
  const text = buildWakeInstructions('persona-quiz', {
    callUser: '搭档',
    displayName: '小海海',
  });
  assert.match(text, /小海海/);
  assert.match(text, /就用这个/);
  assert.match(text, /确认/);
  assert.match(text, /好的就它/);
  assert.match(text, /套上吧/);
  assert.match(text, /16|MBTI|人格/);
  assert.match(text, /4～6 题|4~6 题/);
  assert.match(text, /soulmate_persona_evolve/);
  assert.match(text, /soulmate_persona_eval/);
  assert.match(text, /未确认禁止改/);
  assert.match(text, /第1题/);
  assert.match(text, /问吧/);
  assert.match(text, /你问/);
  assert.ok(text.includes('不是测用户自己') || /不是测/.test(text));
});

test('persona-quiz wake: empty displayName falls back to soulmate', () => {
  const text = buildWakeInstructions('persona-quiz', { callUser: '搭档' });
  assert.match(text, /「soulmate」/);
  assert.match(stripWakeBubbleMark(buildWakeVisibleNotice('persona-quiz', {})), /适合soulmate的人格/);
});

test('persona-quiz wake: short visible + pet say', () => {
  const notice = buildWakeVisibleNotice('persona-quiz', { callUser: '搭档', name: '小海海' });
  assert.equal(isWakeBubbleText(notice), true);
  assert.ok(notice.startsWith(WAKE_BUBBLE_MARK));
  assert.match(stripWakeBubbleMark(notice), /小海海|人格/);
  assert.match(stripWakeBubbleMark(notice), /第1题/);
  assert.match(buildPetSay('persona-quiz', { callUser: '搭档', displayName: '小海海' }), /消息|人格|小海海/);
  assert.equal(isWakeBubbleText('帮我挑适合小海海的人格'), false);
});

test('tryFocusSession: calls focusSession when present', async () => {
  let seen = '';
  const ok = await tryFocusSession({
    focusSession: async (id) => { seen = id; },
  }, 'sess-1');
  assert.equal(ok, true);
  assert.equal(seen, 'sess-1');
});

test('tryFocusSession: probes extras.router.navigate', async () => {
  let seen = null;
  const ok = await tryFocusSession({ prompt: async () => {} }, 'sess-2', {
    router: {
      navigate: async (arg) => { seen = arg; },
    },
  });
  assert.equal(ok, true);
  assert.ok(seen);
});

test('tryFocusSession: false when no API', async () => {
  assert.equal(await tryFocusSession({ prompt: async () => {} }, 'x'), false);
});
