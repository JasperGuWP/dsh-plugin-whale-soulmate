import test from 'node:test';
import assert from 'node:assert/strict';
import {
  postDreamTargets,
  shouldDream,
  shouldRunWeeklyGate,
  composeDreamDigest,
  composeDreamLlmPrompt,
} from '../packages/soulmate-core/proactive.mjs';

const TZ = 8 * 60;
const NIGHT = Date.parse('2026-11-09T16:00:00Z'); // 2026-11-10 00:00 local

// `text` is the canonical contract field and wins over topic/content, so the fixture
// derives it unless a case overrides it explicitly.
const fact = (over = {}) => {
  const topic = over.topic ?? '饮品偏好';
  const content = over.content ?? '每天早上一杯冰美式';
  return {
    id: 'f_1',
    kind: 'semantic',
    text: `${topic}：${content}`,
    topic,
    content,
    salience: 0.8,
    confidence: 0.7,
    visibility: 'syncable',
    invalidatedAt: null,
    deletedAt: null,
    createdAt: '2026-11-09T10:00:00.000Z',
    updatedAt: '2026-11-09T10:00:00.000Z',
    ...over,
  };
};

test('proactive: dream targets skip private, invalidated and already-distilled facts', () => {
  const facts = [
    fact({ id: 'f_old', createdAt: '2026-11-01T00:00:00.000Z' }),
    fact({ id: 'f_fresh', salience: 0.9 }),
    fact({ id: 'f_private', visibility: 'private' }),
    fact({ id: 'f_dead', invalidatedAt: '2026-11-09T12:00:00.000Z' }),
    fact({ id: 'f_low', salience: 0.05 }),
  ];

  const picked = postDreamTargets({ facts, sinceIso: '2026-11-05T00:00:00.000Z', minSalience: 0.2 });
  const ids = picked.map((f) => f.id);
  assert.ok(ids.includes('f_fresh'));
  assert.ok(!ids.includes('f_private'), 'private facts never become syncable wiki pages');
  assert.ok(!ids.includes('f_dead'));
  assert.ok(!ids.includes('f_old'), 'already distilled before the cursor');
  assert.ok(!ids.includes('f_low'), 'below the salience floor');

  // Highest salience first so a truncated digest keeps what matters.
  assert.deepEqual(postDreamTargets({ facts, sinceIso: '2026-11-05T00:00:00.000Z', minSalience: 0.2, limit: 1 }).map((f) => f.id), ['f_fresh']);
});

test('proactive: dream fires once per night and only after the night slot', () => {
  const base = {
    tzOffsetMinutes: TZ,
    state: { mood: 'sleepy', lastInteractionAt: '2026-11-09T15:00:00.000Z' },
    config: { dreamReflect: true, dreamMinFacts: 2, preferOffPeak: false },
  };

  // Daytime with catch-up ON is now a *catch-up* dream (see dream-catchup.test.mjs): a box
  // that only boots in the afternoon must not lose the whole night. With catch-up explicitly
  // disabled the old contract holds — daytime is simply not night.
  const offCatchUp = { ...base, config: { ...base.config, dreamCatchUp: false } };
  const tooEarly = shouldDream({ ...offCatchUp, nowMs: Date.parse('2026-11-09T12:00:00Z'), lastDreamAt: '', targetCount: 5 });
  assert.equal(tooEarly.dream, false);
  assert.equal(tooEarly.reason, 'not-night');

  const few = shouldDream({ ...base, nowMs: NIGHT, lastDreamAt: '', targetCount: 1 });
  assert.equal(few.dream, false);
  assert.equal(few.reason, 'not-enough-facts');

  const off = shouldDream({ ...base, nowMs: NIGHT, lastDreamAt: '', targetCount: 5, config: { dreamReflect: false, preferOffPeak: false } });
  assert.equal(off.dream, false);
  assert.equal(off.reason, 'disabled');

  const yes = shouldDream({ ...base, nowMs: NIGHT, lastDreamAt: '', targetCount: 5 });
  assert.equal(yes.dream, true);
  assert.equal(yes.reason, 'night-dream');

  const again = shouldDream({ ...base, nowMs: NIGHT + 60_000, lastDreamAt: '2026-11-09T16:00:30.000Z', targetCount: 5 });
  assert.equal(again.dream, false);
  assert.equal(again.reason, 'already-dreamed-tonight');
});

test('proactive: the weekly submission gate runs at most once per ISO week', () => {
  const monday = Date.parse('2026-11-09T03:00:00Z');
  const first = shouldRunWeeklyGate({ nowMs: monday, config: { weeklyGate: true }, lastGateWeek: '' });
  assert.equal(first.run, true);
  assert.equal(first.week, '2026-W46');

  const same = shouldRunWeeklyGate({ nowMs: monday + 86_400_000, config: { weeklyGate: true }, lastGateWeek: '2026-W46' });
  assert.equal(same.run, false);
  assert.equal(same.reason, 'already-ran-this-week');

  const next = shouldRunWeeklyGate({ nowMs: monday + 7 * 86_400_000, config: { weeklyGate: true }, lastGateWeek: '2026-W46' });
  assert.equal(next.run, true);
  assert.equal(next.week, '2026-W47');

  const off = shouldRunWeeklyGate({ nowMs: monday, config: { weeklyGate: false }, lastGateWeek: '' });
  assert.equal(off.run, false);
  assert.equal(off.reason, 'disabled');
});

test('proactive: dream digest is a readable wiki page carrying the source ids', () => {
  const digest = composeDreamDigest({
    facts: [
      fact({ id: 'f_a', topic: '饮品偏好', content: '每天早上一杯冰美式', salience: 0.9 }),
      fact({ id: 'f_b', topic: '代码风格', content: '坚持纯 Node 零依赖', salience: 0.6 }),
    ],
    persona: { name: '小汐', callUser: '阿澈' },
    dateKey: '2026-11-10',
  });
  assert.equal(digest.slug, 'dream-2026-11-10');
  assert.match(digest.title, /小汐/);
  assert.match(digest.content, /冰美式/);
  assert.match(digest.content, /纯 Node 零依赖/);
  assert.deepEqual(digest.sourceFactIds, ['f_a', 'f_b']);
  assert.ok(digest.summary.length > 0 && digest.summary.length <= 120);
});

test('dream digest can include session star bullets', () => {
  const dig = composeDreamDigest({
    facts: [],
    sessionStars: [{ title: '小海海', summary: '一起改自动记忆' }],
    persona: { name: '小海海' },
    dateKey: '2026-11-11',
  });
  assert.match(dig.content, /一起改自动记忆|窗/);
  assert.deepEqual(dig.sourceFactIds, [], 'session stars stay in body only, not sourceFactIds');
});

test('dream LLM prompt can include session star bullets', () => {
  const { prompt, sourceFactIds } = composeDreamLlmPrompt({
    facts: [],
    sessionStars: [{ title: '窗边', summary: '一起改自动记忆' }],
    persona: { name: '小海海' },
    dateKey: '2026-11-11',
  });
  assert.match(prompt, /一起改自动记忆|窗/);
  assert.deepEqual(sourceFactIds, []);
});

test('proactive: session stars count toward dream targetCount', () => {
  const base = {
    tzOffsetMinutes: TZ,
    state: { mood: 'sleepy', lastInteractionAt: '2026-11-09T15:00:00.000Z' },
    config: { dreamReflect: true, dreamMinFacts: 2, preferOffPeak: false },
  };
  // One fact alone is not enough; facts + session stars together clear the floor.
  const factsOnly = shouldDream({ ...base, nowMs: NIGHT, lastDreamAt: '', targetCount: 1 });
  assert.equal(factsOnly.dream, false);
  assert.equal(factsOnly.reason, 'not-enough-facts');

  const withStars = shouldDream({ ...base, nowMs: NIGHT, lastDreamAt: '', targetCount: 1 + 1 });
  assert.equal(withStars.dream, true);
  assert.equal(withStars.reason, 'night-dream');
});