import test from 'node:test';
import assert from 'node:assert/strict';
import {
  pendingDiaryDateKeys,
  composeDailyDiaryLetters,
  diaryMaterialForDate,
  shiftDateKey,
} from '../packages/soulmate-core/proactive.mjs';

const TZ = 8 * 60;

test('daily diary: pending dates catch up yesterday + today when last is stale', () => {
  // 2026-11-11 10:00 local — daytime, last diary was 11-09 → catch-up both 10 and 11.
  const nowMs = Date.parse('2026-11-11T02:00:00Z');
  const pending = pendingDiaryDateKeys({
    nowMs,
    tzOffsetMinutes: TZ,
    lastDiaryDateKey: '2026-11-09',
    config: { dailyDiary: true, diaryCatchUp: true },
  });
  assert.deepEqual(pending.dates, ['2026-11-10', '2026-11-11']);
});

test('daily diary: once today is written, pending is empty', () => {
  const nowMs = Date.parse('2026-11-11T14:00:00Z'); // 22:00 local evening
  const pending = pendingDiaryDateKeys({
    nowMs,
    tzOffsetMinutes: TZ,
    lastDiaryDateKey: '2026-11-11',
    config: { dailyDiary: true },
  });
  assert.deepEqual(pending.dates, []);
  assert.equal(pending.reason, 'already-today');
});

test('daily diary: quiet day still composes a short letter', () => {
  const letters = composeDailyDiaryLetters({
    dateKey: '2026-11-10',
    persona: { name: '小海海', callUser: '搭档', selfRef: '本喵' },
    bullets: [],
  });
  assert.equal(letters.toYou.kind, 'to-you');
  assert.equal(letters.toYou.date, '2026-11-10');
  assert.match(letters.toYou.content, /搭档/);
  assert.equal(letters.inner.visibility, 'private');
});

test('daily diary: selfRef in body; no 用户 as subject; inner first-person', () => {
  const letters = composeDailyDiaryLetters({
    dateKey: '2026-11-11',
    persona: { name: '大肥鱼', callUser: '搭档', selfRef: '本鱼' },
    bullets: ['修好了一个小 bug'],
  });
  assert.match(letters.toYou.content, /本鱼/);
  assert.doesNotMatch(letters.toYou.content, /^用户/m);
  assert.doesNotMatch(letters.toYou.content, /用户[…。.，]/);
  assert.match(letters.inner.content, /^(今天|我|本鱼)/);
  assert.doesNotMatch(letters.inner.content, /希望他看到/);
  assert.match(letters.inner.content, /希望你看到|会心一笑|记了/);
});

test('daily diary: missing selfRef falls back to 我, not 本鱼', () => {
  const letters = composeDailyDiaryLetters({
    dateKey: '2026-11-11',
    persona: { name: '伙伴', callUser: '你' },
    bullets: [],
  });
  assert.match(letters.toYou.content, /我还在这边/);
  assert.doesNotMatch(letters.toYou.content, /本鱼/);
});

test('daily diary: material filters facts to the local date', () => {
  const material = diaryMaterialForDate({
    dateKey: '2026-11-10',
    tzOffsetMinutes: TZ,
    facts: [
      { id: 'a', text: '昨天的事', createdAt: '2026-11-09T12:00:00.000Z' },
      { id: 'b', text: '今天的事', createdAt: '2026-11-10T04:00:00.000Z' },
    ],
  });
  assert.deepEqual(material.bullets, ['今天的事']);
  assert.deepEqual(material.factIds, ['b']);
});

test('shiftDateKey walks calendar days', () => {
  assert.equal(shiftDateKey('2026-11-11', -1), '2026-11-10');
  assert.equal(shiftDateKey('2026-03-01', -1), '2026-02-28');
});
