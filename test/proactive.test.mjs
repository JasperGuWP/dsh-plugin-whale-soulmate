import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  localClock,
  resolveSlot,
  evaluateOpeningGate,
  deliverNudge,
  SLOTS,
  promisePatrolTargets,
  distillClusters,
} from '../packages/soulmate-core/proactive.mjs';

const TZ = 8 * 60; // UTC+8, injected so the suite never depends on the machine clock.

test('proactive: local clock and slots follow the injected timezone offset', () => {
  // 2026-11-09T23:40Z at UTC+8 is 2026-11-10 07:40 local — the date key must roll over.
  const clock = localClock(Date.parse('2026-11-09T23:40:00Z'), TZ);
  assert.equal(clock.minutes, 7 * 60 + 40);
  assert.equal(clock.dateKey, '2026-11-10');
  assert.equal(resolveSlot(clock.minutes).kind, 'morning');

  assert.equal(resolveSlot(12 * 60 + 30).kind, 'lunch');
  assert.equal(resolveSlot(19 * 60).kind, 'evening');
  assert.equal(resolveSlot(23 * 60 + 45).kind, 'night');
  assert.equal(resolveSlot(3 * 60), null, 'deep night is silent');
  assert.equal(resolveSlot(15 * 60), null, 'afternoon is not a scheduled slot');
  assert.equal(SLOTS.length, 4);
});

const strategy = { initiative: 60, silenceThresholdHours: 24 };

const gateArgs = (over = {}) => ({
  nowMs: Date.parse('2026-11-09T23:40:00Z'), // 07:40 local
  tzOffsetMinutes: TZ,
  strategy,
  state: { mood: 'happy', energy: 80, affinity: 120, lastInteractionAt: '2026-11-09T21:40:00Z' },
  config: { enabled: true, maxPerDay: 3, minIdleMinutes: 30, minGapMinutes: 180, quietHours: [] },
  recent: [],
  persona: { name: '小汐', callUser: '阿澈' },
  ...over,
});

test('proactive: a due slot speaks in character and reports why', () => {
  const plan = evaluateOpeningGate(gateArgs());
  assert.equal(plan.speak, true);
  assert.equal(plan.kind, 'morning');
  assert.equal(plan.dateKey, '2026-11-10');
  assert.match(plan.text, /阿澈/);
  assert.ok(plan.dedupeKey.endsWith(':morning'));
});

test('proactive: idle gap, low initiative, daily quota and per-kind gap all silence the gate', () => {
  const busy = evaluateOpeningGate(
    gateArgs({ state: { mood: 'happy', energy: 80, affinity: 120, lastInteractionAt: '2026-11-09T23:30:00Z' } })
  );
  assert.equal(busy.speak, false);
  assert.equal(busy.reason, 'user-just-active');

  const quietUser = evaluateOpeningGate(gateArgs({ strategy: { initiative: 12, silenceThresholdHours: 24 } }));
  assert.equal(quietUser.speak, false);
  assert.equal(quietUser.reason, 'low-initiative');

  // maxPerDay 1: one morning nudge 30 minutes ago already spent the day's budget.
  const spent = evaluateOpeningGate(
    gateArgs({
      config: { enabled: true, maxPerDay: 1, minIdleMinutes: 30, minGapMinutes: 180, quietHours: [] },
      recent: [{ kind: 'morning', at: '2026-11-09T23:10:00Z' }],
    })
  );
  assert.equal(spent.speak, false);
  assert.equal(spent.reason, 'daily-quota');

  // Budget left, but the same kind fired 20 minutes ago.
  const repeated = evaluateOpeningGate(gateArgs({ recent: [{ kind: 'morning', at: '2026-11-09T23:20:00Z' }] }));
  assert.equal(repeated.speak, false);
  assert.equal(repeated.reason, 'same-kind-too-soon');
});

test('proactive: quiet hours override every slot and sulking speaks exactly once per day', () => {
  const quiet = evaluateOpeningGate(gateArgs({ config: { enabled: true, maxPerDay: 3, minIdleMinutes: 30, minGapMinutes: 180, quietHours: ['07:00-09:00'] } }));
  assert.equal(quiet.speak, false);
  assert.equal(quiet.reason, 'quiet-hours');

  const sulk = evaluateOpeningGate(gateArgs({ state: { mood: 'sulking', energy: 50, affinity: 120, lastInteractionAt: '2026-11-04T10:00:00Z' } }));
  assert.equal(sulk.speak, true);
  assert.equal(sulk.kind, 'sulking');
  assert.match(sulk.text, /阿澈/);

  const sulkAgain = evaluateOpeningGate(
    gateArgs({
      state: { mood: 'sulking', energy: 50, affinity: 120, lastInteractionAt: '2026-11-04T10:00:00Z' },
      recent: [{ kind: 'sulking', at: '2026-11-09T23:20:00Z' }],
    })
  );
  assert.equal(sulkAgain.speak, false);
  assert.equal(sulkAgain.reason, 'same-kind-too-soon');
});

test('proactive: deliver degrades from host callback to event to silent, never throwing', async () => {
  const plan = evaluateOpeningGate(gateArgs());
  const seen = [];

  // Host success still mirrors onto the activity feed (OS toast / 3D home).
  const viaHost = await deliverNudge(plan, {
    deliver: async (text) => { seen.push(['host', text]); return { ok: true, out: { text: '主机里的原话' } }; },
    pushEvent: (type, extra) => { seen.push(['event', type, extra.text]); return 1; },
  });
  assert.equal(viaHost.via, 'host');
  assert.equal(viaHost.seq, 1);
  assert.equal(seen[1][2], '主机里的原话');

  const viaEvent = await deliverNudge(plan, {
    deliver: async () => { throw new Error('host refused'); },
    pushEvent: (type, extra) => { seen.push(['event', type, extra.kind]); return 9; },
  });
  assert.equal(viaEvent.via, 'event');
  assert.equal(viaEvent.seq, 9);

  const silent = await deliverNudge(plan, {});
  assert.equal(silent.via, 'silent');
  assert.equal(silent.ok, false);
  assert.deepEqual(seen.map((s) => s[0]), ['host', 'event', 'event']);
});
// ---------------------------------------------------------------------------
// v3 promise patrol & distillation clustering (design 2026-11-09 §5 / §7)
// ---------------------------------------------------------------------------

test('proactive v3: promise patrol separates due-today from overdue asks', () => {
  const now = Date.parse('2026-11-10T10:00:00Z');
  const promises = [
    { id: 'p_due', text: '今天到期的事', status: 'made', dueAt: '2026-11-10T09:00:00Z' },
    { id: 'p_late', text: '逾期五天的事', status: 'made', dueAt: '2026-11-05T09:00:00Z' },
    { id: 'p_soon', text: '明天到期的事', status: 'made', dueAt: '2026-11-11T09:00:00Z' },
    { id: 'p_far', text: '下个月的事', status: 'made', dueAt: '2026-12-01T09:00:00Z' },
    { id: 'p_kept', text: '已兑现', status: 'kept', dueAt: '2026-11-01T09:00:00Z' },
    { id: 'p_nodue', text: '没有期限', status: 'made', dueAt: null },
  ];
  const targets = promisePatrolTargets({ promises, nowMs: now });
  assert.deepEqual(targets.map((t) => t.id), ['p_late', 'p_due']);
  assert.equal(targets[0].patrol, 'ask', 'over 3 days late becomes an ask, first in line');
  assert.equal(targets[0].overdueDays, 5);
  assert.equal(targets[1].patrol, 'patrol');
  assert.deepEqual(promisePatrolTargets({ promises: [], nowMs: now }), []);
});

test('proactive v3: distillation clusters only undistilled, syncable, active facts', () => {
  const wiki = [{ sourceFactIds: ['f_w'] }];
  const facts = [
    ...['a', 'b', 'c', 'd', 'e'].map((n) => ({ id: `f_${n}`, category: 'video', kind: 'semantic' })),
    { id: 'f_w', category: 'video', kind: 'semantic' },
    { id: 'f_p', category: 'video', kind: 'private-x', visibility: 'private' },
    { id: 'f_i', category: 'video', invalidatedBy: 'f_a' },
    { id: 'f_prom', category: 'video', kind: 'promise' },
    ...['x', 'y'].map((n) => ({ id: `g_${n}`, category: 'decision', kind: 'semantic' })),
  ];
  const clusters = distillClusters({ facts, wikiPages: wiki, minCluster: 5 });
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].category, 'video');
  assert.equal(clusters[0].size, 5);
  assert.ok(!clusters[0].sourceFactIds.includes('f_w'), 'already distilled');
  assert.ok(!clusters[0].sourceFactIds.includes('f_p'), 'private never distills');
  assert.deepEqual(distillClusters({ facts, wikiPages: wiki, minCluster: 9 }), []);
});
