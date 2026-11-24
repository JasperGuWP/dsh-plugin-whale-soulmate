// Intent layer: pure decisions (intent.mjs) + wake instruction wording (chat-home.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  composeIntentPrompt,
  composeRestraintNote,
  describeEvent,
  evaluateIntentGate,
  expireEvents,
  makeIntentEvent,
  mergeEventLedger,
  parseIntentReply,
  resolveEvents,
} from '../packages/soulmate-core/intent.mjs';
import { buildWakeInstructions } from '../packages/soulmate-core/chat-home.mjs';

const AT = Date.parse('2026-11-23T10:00:00Z'); // 18:00 UTC+8 — evening slot
const TZ = 480;

const ev = (kind, over = {}) => makeIntentEvent(kind, { nowMs: AT, key: `${kind}-k`, ...over });

test('intent: events dedupe by key against pending rows only', () => {
  const a = ev('video-found', { key: 'video:BV1' });
  const first = mergeEventLedger([], [a]);
  assert.equal(first.added.length, 1);
  // same key while pending → not re-added
  const again = mergeEventLedger(first.rows, [ev('video-found', { key: 'video:BV1' })]);
  assert.equal(again.added.length, 0);
  // consumed → the same video may legitimately return later
  const consumed = resolveEvents(first.rows, [a.id], 'consumed', 'share', AT);
  const later = mergeEventLedger(consumed, [ev('video-found', { key: 'video:BV1', nowMs: AT + 86400000 })]);
  assert.equal(later.added.length, 1);
});

test('intent: ledger overflow drops least salient pending, never resolved history', () => {
  const rows = [];
  for (let i = 0; i < 5; i += 1) rows.push(ev('slot', { key: `s${i}`, salience: 0.3 }));
  rows.push(ev('promise-due', { key: 'p1', salience: 0.9 }));
  const merged = mergeEventLedger(rows, [], { maxPending: 3 });
  const pending = merged.rows.filter((r) => r.status === 'pending');
  assert.equal(pending.length, 3);
  assert.ok(pending.some((r) => r.kind === 'promise-due'), 'high-salience survives');
});

test('intent: ttl expiry is numeric and kind-aware', () => {
  const slot = ev('slot');
  const promise = ev('promise-due');
  const { rows, changed } = expireEvents([slot, promise], AT + 4 * 3600_000);
  assert.equal(changed, true);
  assert.equal(rows.find((r) => r.id === slot.id).status, 'expired');
  assert.equal(rows.find((r) => r.id === promise.id).status, 'pending');
});

test('intent gate: disabled / no-events / quiet-hours / user-active all silence with reasons', () => {
  const events = [ev('video-found')];
  assert.equal(evaluateIntentGate({ nowMs: AT, config: {}, events }).reason, 'disabled');
  assert.equal(evaluateIntentGate({ nowMs: AT, config: { intentEnabled: true }, events: [] }).reason, 'no-events');
  assert.equal(
    evaluateIntentGate({ nowMs: AT, config: { intentEnabled: true, quietHours: ['17:00-19:00'] }, events }).reason,
    'quiet-hours'
  );
  assert.equal(
    evaluateIntentGate({
      nowMs: AT,
      config: { intentEnabled: true },
      state: { interactionCount: 5, lastInteractionAt: new Date(AT - 5 * 60000).toISOString() },
      events,
    }).reason,
    'user-just-active'
  );
});

test('intent gate: act quota counts acts only — silent decisions do not burn speaking budget', () => {
  const events = [ev('video-found')];
  const mk = (action, minsAgo) => ({ at: new Date(AT - minsAgo * 60000).toISOString(), action });
  const decisions = [mk('silent', 200), mk('silent', 190), mk('speak', 180), mk('share', 170), mk('speak', 160)];
  const gate = evaluateIntentGate({
    nowMs: AT,
    tzOffsetMinutes: TZ,
    config: { intentEnabled: true, intentMaxActsPerDay: 3, intentMinGapMinutes: 90 },
    events,
    decisions,
  });
  assert.equal(gate.reason, 'daily-quota');
  // With fewer acts but a recent decision, the gap guard fires instead.
  const gate2 = evaluateIntentGate({
    nowMs: AT,
    tzOffsetMinutes: TZ,
    config: { intentEnabled: true, intentMinGapMinutes: 90 },
    events,
    decisions: [mk('silent', 30)],
  });
  assert.equal(gate2.reason, 'too-soon');
});

test('intent gate: offers highest-salience events first, capped at 6', () => {
  const events = [];
  for (let i = 0; i < 8; i += 1) events.push(ev('slot', { key: `s${i}`, salience: 0.1 + i * 0.1 }));
  const gate = evaluateIntentGate({ nowMs: AT, tzOffsetMinutes: TZ, config: { intentEnabled: true }, events });
  assert.equal(gate.consider, true);
  assert.equal(gate.events.length, 6);
  assert.ok(gate.events[0].salience >= gate.events[5].salience);
});

test('intent prompt: opportunities are statements, verdict contract and restraint are explicit', () => {
  const events = [ev('video-found', { payload: { title: '装机翻车合集', worthScore: 16 } })];
  const prompt = composeIntentPrompt({ events, voice: '嘴硬心软', memory: '- 偏好：他爱看实测', persona: { callUser: '主人' }, clock: '18:00', dateKey: '2026-11-23' });
  assert.match(prompt, /装机翻车合集/);
  assert.match(prompt, /嘴硬心软/);
  assert.match(prompt, /他爱看实测/);
  assert.match(prompt, /silent/);
  assert.match(prompt, /defer/);
  assert.match(prompt, /克制不是失职/);
  assert.doesNotMatch(prompt, /去提醒|必须开口/);
});

test('intent parse: valid verdict, garbage falls back to silent, unknown event id rejected', () => {
  const events = [ev('video-found')];
  const good = parseIntentReply('{"action":"share","eventId":"' + events[0].id + '","angle":"他说过想看翻车","reason":"值得分享","steps":2}', { events });
  assert.equal(good.action, 'share');
  assert.equal(good.steps, 2);
  assert.equal(good.parse, 'ok');

  assert.equal(parseIntentReply('我觉得还是算了', { events }).action, 'silent');
  assert.equal(parseIntentReply('{broken', { events }).action, 'silent');
  assert.equal(parseIntentReply('{"action":"dance"}', { events }).action, 'silent');
  assert.equal(parseIntentReply('{"action":"share","eventId":"nope"}', { events }).action, 'silent');
  // steps clamped
  const clamped = parseIntentReply('{"action":"silent","steps":99}', { events });
  assert.equal(clamped.steps, 6);
});

test('intent: restraint note is private, first-person, and records the unspoken thought', () => {
  const event = ev('video-found', { payload: { title: '装机翻车合集' } });
  const note = composeRestraintNote({
    decision: { reason: '他在赶工，不想吵他' },
    event,
    dateKey: '2026-11-23',
    clock: '18:00',
    persona: { selfRef: '本鱼', callUser: '主人' },
  });
  assert.equal(note.visibility, 'private');
  assert.equal(note.kind, 'inner');
  assert.match(note.content, /本鱼/);
  assert.match(note.content, /他在赶工/);
  assert.match(note.content, /装机翻车合集/);
});

test('describeEvent: every kind renders a statement, never an imperative', () => {
  const cases = [
    ev('slot', { payload: { label: '晚间', clock: '18:00' } }),
    ev('sulking'),
    ev('video-found', { payload: { title: 'T', worthScore: 15 } }),
    ev('promise-due', { payload: { text: '陪他看片', overdueDays: 2 } }),
    ev('conflict-open', { payload: { text: '猫的名字' } }),
    ev('long-active', { payload: { hours: 5 } }),
  ];
  for (const e of cases) {
    const line = describeEvent(e);
    assert.ok(line.length > 4);
    assert.doesNotMatch(line, /去|请立刻|必须/);
  }
});

test('wake instructions: intent kinds carry her angle, step budget and no assistant tone', () => {
  const one = buildWakeInstructions('intent-speak', { callUser: '主人', hint: '他上次说想看装机翻车', voice: '嘴硬心软', memory: '- 偏好：实测', steps: 1 });
  assert.match(one, /自主意图/);
  assert.match(one, /他上次说想看装机翻车/);
  assert.match(one, /嘴硬心软/);
  assert.match(one, /直接开口/);
  assert.doesNotMatch(one, /允许你先用工具/);

  const multi = buildWakeInstructions('intent-share', { callUser: '主人', hint: '分享视频', steps: 4 });
  assert.match(multi, /不超过 4 步/);
  assert.match(multi, /不要为了用满步数而多查/);

  // steps clamped to 6 even if caller passes nonsense
  const clamp = buildWakeInstructions('intent-share', { steps: 99 });
  assert.match(clamp, /不超过 6 步/);

  // old kinds unchanged
  const boot = buildWakeInstructions('boot', { callUser: '主人' });
  assert.match(boot, /开机问候/);
  const pro = buildWakeInstructions('proactive', { callUser: '主人' });
  assert.match(pro, /主动开口/);
});