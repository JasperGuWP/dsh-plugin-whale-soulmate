import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldDream, distillClusters } from '../packages/soulmate-core/proactive.mjs';

/**
 * Two real-world gaps found by inspecting a live ~/.dsh/soulmate database:
 *
 * 1. `shouldDream` only ever asked "is it night *right now*". The dream window
 *    (local 00:30–05:00, the intersection of night and the DeepSeek off-peak slot)
 *    never overlapped the hours the harness actually ran (local 12:10–18:54), so
 *    `lastDreamAt` was never written and `memory/wiki/` stayed empty for weeks.
 *    A missed night must be caught up on the next tick, not silently skipped.
 *
 * 2. `distillClusters` required 5 facts *of the same category*. Real usage spread
 *    5 facts across decision(2) / video(2) / preference(1), so no bucket ever
 *    reached the threshold and the weekly gate always produced zero clusters.
 */

const TZ = 480; // UTC+8
// Local wall clock -> epoch ms, for the tests' readability.
const localTime = (h, m = 0, day = 10) => Date.UTC(2026, 10, day, h, m) - TZ * 60_000;

test('dream: a missed night is caught up on the next tick instead of skipped', () => {
  const cfg = { dreamReflect: true, dreamMinFacts: 2, preferOffPeak: true };
  // She was asleep at 04:00 local (inside the window) but the process was not running.
  const lastDream = new Date(localTime(4, 0, 8)).toISOString(); // dreamed 2 nights ago
  const decision = shouldDream({
    nowMs: localTime(14, 0), // local 14:00 — the hour she actually runs
    tzOffsetMinutes: TZ,
    config: cfg,
    lastDreamAt: lastDream,
    targetCount: 5,
  });
  assert.equal(decision.dream, true, 'a whole missed night must trigger a catch-up dream');
  assert.equal(decision.reason, 'missed-night-catchup');
  assert.equal(decision.catchUp, true);
});

test('dream: the catch-up does not fire twice for the same missed night', () => {
  const cfg = { dreamReflect: true, dreamMinFacts: 2, preferOffPeak: true };
  // Already dreamed today (at 04:00 local) -> the daytime tick must stay quiet.
  const lastDream = new Date(localTime(4, 0)).toISOString();
  const decision = shouldDream({
    nowMs: localTime(14, 0),
    tzOffsetMinutes: TZ,
    config: cfg,
    lastDreamAt: lastDream,
    targetCount: 5,
  });
  assert.equal(decision.dream, false);
  assert.equal(decision.reason, 'already-dreamed-tonight');
});

test('dream: no catch-up when there is nothing worth dreaming about', () => {
  const decision = shouldDream({
    nowMs: localTime(14, 0),
    tzOffsetMinutes: TZ,
    config: { dreamReflect: true, dreamMinFacts: 2, preferOffPeak: true },
    lastDreamAt: new Date(localTime(4, 0, 8)).toISOString(),
    targetCount: 1,
  });
  assert.equal(decision.dream, false);
  assert.equal(decision.reason, 'not-enough-facts');
});

test('dream: a first run with no history still catches up (empty lastDreamAt)', () => {
  // The live database had literally no `lastDreamAt` key — the feature had never run once.
  const decision = shouldDream({
    nowMs: localTime(14, 0),
    tzOffsetMinutes: TZ,
    config: { dreamReflect: true, dreamMinFacts: 2, preferOffPeak: true },
    lastDreamAt: '',
    targetCount: 5,
  });
  assert.equal(decision.dream, true, 'a never-dreamed install must dream on its first daytime tick');
  assert.equal(decision.catchUp, true);
});

test('dream: the in-window path still reports the plain night reason', () => {
  const decision = shouldDream({
    nowMs: localTime(1, 30), // inside 00:30–05:00, off-peak
    tzOffsetMinutes: TZ,
    config: { dreamReflect: true, dreamMinFacts: 2, preferOffPeak: true },
    lastDreamAt: '',
    targetCount: 5,
  });
  assert.equal(decision.dream, true);
  assert.equal(decision.reason, 'night-dream');
  assert.ok(!decision.catchUp, 'the normal path is not a catch-up');
});

test('dream: disabled config never catches up', () => {
  const decision = shouldDream({
    nowMs: localTime(14, 0),
    tzOffsetMinutes: TZ,
    config: { dreamReflect: false, dreamMinFacts: 2 },
    lastDreamAt: '',
    targetCount: 5,
  });
  assert.equal(decision.dream, false);
  assert.equal(decision.reason, 'disabled');
});

test('distill: total undistilled facts form a cluster even when each category is small', () => {
  // Mirrors the live database: decision 2 / video 2 / preference 1 = 5 facts, no bucket of 5.
  const facts = [
    { id: 'a1', category: 'decision', kind: 'semantic', visibility: 'syncable' },
    { id: 'a2', category: 'decision', kind: 'semantic', visibility: 'syncable' },
    { id: 'b1', category: 'video', kind: 'episodic', visibility: 'syncable' },
    { id: 'b2', category: 'video', kind: 'episodic', visibility: 'syncable' },
    { id: 'c1', category: 'preference', kind: 'semantic', visibility: 'syncable' },
  ];
  const clusters = distillClusters({ facts, wikiPages: [], minCluster: 5 });
  assert.equal(clusters.length, 1, 'the loose facts must form exactly one cluster');
  assert.equal(clusters[0].size, 5);
  assert.equal(clusters[0].category, 'mixed', 'a cross-category cluster is labelled mixed');
  assert.deepEqual(clusters[0].sourceFactIds.sort(), ['a1', 'a2', 'b1', 'b2', 'c1']);
});

test('distill: a big single category still gets its own named cluster', () => {
  const facts = Array.from({ length: 5 }, (_, i) => ({ id: `p${i}`, category: 'plugin', kind: 'semantic' }));
  const clusters = distillClusters({ facts, wikiPages: [], minCluster: 5 });
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].category, 'plugin');
});

test('distill: below the total threshold nothing is emitted', () => {
  const facts = [
    { id: 'a1', category: 'decision' },
    { id: 'b1', category: 'video' },
    { id: 'c1', category: 'preference' },
  ];
  const clusters = distillClusters({ facts, wikiPages: [], minCluster: 5 });
  assert.equal(clusters.length, 0, '3 loose facts are not a theme yet');
});

test('distill: already-distilled, private and dead facts never count toward the total', () => {
  const facts = [
    { id: 'x1', category: 'decision', sourceFactIds: [] },
    { id: 'x2', category: 'decision', visibility: 'private' },
    { id: 'x3', category: 'decision', invalidatedAt: '2026-11-01T00:00:00Z' },
    { id: 'x4', category: 'decision', kind: 'promise' },
  ];
  const wikiPages = [{ slug: 'done', sourceFactIds: ['x5'] }];
  facts.push({ id: 'x5', category: 'decision' });
  const clusters = distillClusters({ facts, wikiPages, minCluster: 2 });
  assert.equal(clusters.length, 0, 'excluded rows must not pad the cluster');
});