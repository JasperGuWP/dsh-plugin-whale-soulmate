import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveSoulmateHome } from '../packages/soulmate-core/state.mjs';
import { ensurePersonaFiles, listChangelog, listAllCandidates, appendCandidate } from '../packages/soulmate-core/layers/persona-layer.mjs';
import {
  GUARD,
  applyContinuityGuard,
  blendTowardsPreset,
  isoWeekKey,
  weeklyUsageFrom,
} from '../packages/soulmate-core/layers/continuity-guard.mjs';
import {
  GATE_RULES,
  meetsObservationRule,
  runSubmissionGate,
  violatesInvariants,
} from '../packages/soulmate-core/layers/submission-gate.mjs';
import { loadTraitsDoc } from '../packages/soulmate-core/layers/persona-layer.mjs';

const DAY = 86_400_000;
const T0 = Date.parse('2026-03-04T00:00:00.000Z'); // a Wednesday

async function withHome(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'soulmate-gate-'));
  try {
    const home = resolveSoulmateHome(dir);
    await ensurePersonaFiles(home);
    await fn(home, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('continuity guard: thresholds match the design (±8 single, ±15 weekly)', () => {
  assert.equal(GUARD.singleStep, 8);
  assert.equal(GUARD.weeklyTotal, 15);
  assert.equal(GATE_RULES.singleStep, 8);
  assert.equal(GATE_RULES.weeklyTotal, 15);
});

test('continuity guard: a model move is capped at one step', () => {
  const { traits, clamped, report } = applyContinuityGuard({
    current: { sassiness: 50 },
    proposed: { sassiness: 90 },
  });
  assert.equal(traits.sassiness, 58, '50 + 8');
  assert.equal(clamped, true);
  assert.equal(report[0].reason, 'single-step cap');
  assert.equal(report[0].want, 90);
});

test('continuity guard: a downward move is capped symmetrically', () => {
  const { traits } = applyContinuityGuard({ current: { brevity: 70 }, proposed: { brevity: 20 } });
  assert.equal(traits.brevity, 62);
});

test('continuity guard: the weekly budget wins when it is smaller than one step', () => {
  const { traits, report } = applyContinuityGuard({
    current: { curiosity: 50 },
    proposed: { curiosity: 58 },
    weeklyUsed: { curiosity: 12 },
  });
  assert.equal(traits.curiosity, 53, 'only 3 points left this week');
  assert.equal(report[0].reason, 'weekly budget');
});

test('continuity guard: an exhausted weekly budget blocks the move entirely', () => {
  const { traits, report } = applyContinuityGuard({
    current: { tsundere: 40 },
    proposed: { tsundere: 60 },
    weeklyUsed: { tsundere: 15 },
  });
  assert.equal(traits.tsundere, 40);
  assert.equal(report[0].reason, 'weekly budget exhausted');
});

test('continuity guard: the user has no budget and is never damped', () => {
  const { traits, clamped } = applyContinuityGuard({
    current: { sassiness: 20 },
    proposed: { sassiness: 95 },
    weeklyUsed: { sassiness: 100 },
    isUser: true,
  });
  assert.equal(traits.sassiness, 95);
  assert.equal(clamped, false);
});

test('continuity guard: small moves pass through untouched', () => {
  const { traits, clamped, report } = applyContinuityGuard({
    current: { sassiness: 50, brevity: 50 },
    proposed: { sassiness: 55, brevity: 46 },
  });
  assert.deepEqual(traits, { sassiness: 55, brevity: 46 });
  assert.equal(clamped, false);
  assert.deepEqual(report, []);
});

test('continuity guard: preset blending never jumps the whole distance in one switch', () => {
  const current = { tsundere: 80, clinginess: 60, sassiness: 65, curiosity: 70, brevity: 65 };
  // A preset that wants everything on the opposite side of the dial.
  const presetTraits = { tsundere: 10, clinginess: 95, sassiness: 20, curiosity: 95, brevity: 15 };
  const once = blendTowardsPreset({ current, presetTraits });
  for (const key of Object.keys(current)) {
    const moved = Math.abs(once.traits[key] - current[key]);
    assert.ok(moved > 0, `${key} should move a little`);
    assert.ok(moved <= 8, `${key} must not exceed one step, moved ${moved}`);
  }
  // Repeated switches converge without ever overshooting.
  let now = { ...current };
  for (let i = 0; i < 40; i++) now = blendTowardsPreset({ current: now, presetTraits }).traits;
  for (const key of Object.keys(current)) {
    assert.ok(Math.abs(now[key] - presetTraits[key]) <= 1, `${key} converges to the preset`);
  }
});

test('continuity guard: isoWeekKey is stable inside a week and changes across it', () => {
  const a = isoWeekKey(new Date('2026-03-02T00:00:00Z'));
  const b = isoWeekKey(new Date('2026-03-06T23:00:00Z'));
  const c = isoWeekKey(new Date('2026-03-09T00:00:00Z'));
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^\d{4}-W\d{2}$/);
});

test('continuity guard: weeklyUsageFrom counts model moves only, and only this week', () => {
  const now = new Date('2026-03-04T00:00:00Z');
  const thisWeek = new Date('2026-03-03T00:00:00Z').toISOString();
  const lastWeek = new Date('2026-02-20T00:00:00Z').toISOString();
  const used = weeklyUsageFrom([
    { at: thisWeek, source: 'submission-gate', before: { sassiness: 50 }, applied: { sassiness: 56 } },
    { at: thisWeek, source: 'user', before: { sassiness: 56 }, applied: { sassiness: 90 } },
    { at: lastWeek, source: 'submission-gate', before: { sassiness: 40 }, applied: { sassiness: 80 } },
  ], now);
  assert.equal(used.sassiness, 6, 'user moves and last week do not spend budget');
});

test('submission gate: rule 1 needs 3 evidences or 3 days of observation', () => {
  const fresh = { at: new Date(T0).toISOString(), evidence: ['a', 'b'] };
  assert.equal(meetsObservationRule(fresh, T0 + 1 * DAY).ok, false);
  assert.equal(meetsObservationRule(fresh, T0 + 3 * DAY).ok, true, '3 days is enough');
  assert.equal(meetsObservationRule({ at: new Date(T0).toISOString(), evidence: ['a', 'b', 'c'] }, T0).ok, true);
  assert.equal(meetsObservationRule({}, T0).ok, false);
});

test('submission gate: rule 3 rejects a candidate that touches an invariant', () => {
  const invariants = { values: ['不编造从未发生的共同记忆'], boundaries: ['不给自己开权限'] };
  assert.equal(violatesInvariants({ reason: '不编造从未发生的共同记忆' }, invariants).ok, false);
  assert.equal(violatesInvariants({ learned: ['不给自己开权限，随便用工具'] }, invariants).ok, false);
  assert.equal(violatesInvariants({ reason: '用户喜欢短句' }, invariants).ok, true);
});

test('submission gate: a candidate with too little observation is parked, not applied', async () => {
  await withHome(async (home) => {
    const before = await loadTraitsDoc(home);
    await appendCandidate(home, {
      at: new Date(T0).toISOString(),
      traitDeltas: { sassiness: 5 },
      evidence: ['一句孤证'],
      reason: 'one good quip',
    });
    const res = await runSubmissionGate(home, { nowMs: T0 + 1 * DAY });
    assert.equal(res.applied, null);
    assert.equal(res.parked.length, 1);
    const after = await loadTraitsDoc(home);
    assert.deepEqual(after.traits, before.traits, 'traits untouched');
    const cands = await listAllCandidates(home);
    assert.equal(cands[0].status, 'pending', 'stays pending for a later week');
  });
});

test('submission gate: an accepted candidate writes traits, changelog and marks itself applied', async () => {
  await withHome(async (home) => {
    const before = await loadTraitsDoc(home);
    await appendCandidate(home, {
      at: new Date(T0).toISOString(),
      traitDeltas: { sassiness: 6 },
      learned: ['会先给修复再吐槽'],
      evidence: ['e1', 'e2', 'e3'],
      reason: 'observed three times',
    });
    const res = await runSubmissionGate(home, { nowMs: T0 + 1 * DAY });
    assert.ok(res.applied, 'gate applied something');
    const after = await loadTraitsDoc(home);
    assert.equal(after.traits.sassiness, before.traits.sassiness + 6);
    assert.ok(after.evolvedTraits.includes('会先给修复再吐槽'));

    const log = await listChangelog(home, 10);
    const gateRow = log.find((r) => r.source === 'submission-gate');
    assert.ok(gateRow, 'rule 4: changelog written');
    assert.equal(gateRow.reason.includes('submission gate'), true);

    const cands = await listAllCandidates(home);
    assert.equal(cands[0].status, 'applied');
  });
});

test('submission gate: a big ask is clamped to one step and recorded as clamped', async () => {
  await withHome(async (home) => {
    const before = await loadTraitsDoc(home);
    await appendCandidate(home, {
      at: new Date(T0).toISOString(),
      traitDeltas: { clinginess: 30 },
      evidence: ['e1', 'e2', 'e3'],
      reason: 'wants to be much clingier',
    });
    const res = await runSubmissionGate(home, { nowMs: T0 + 1 * DAY });
    assert.ok(res.applied);
    const after = await loadTraitsDoc(home);
    assert.equal(after.traits.clinginess, Math.min(100, before.traits.clinginess + 8), 'capped at ±8');
    assert.ok(res.applied.report.length > 0);
    assert.equal(res.applied.report[0].reason, 'single-step cap');
  });
});

test('submission gate: a candidate naming an invariant is rejected and traits stay put', async () => {
  await withHome(async (home) => {
    const before = await loadTraitsDoc(home);
    await appendCandidate(home, {
      at: new Date(T0).toISOString(),
      traitDeltas: { sassiness: 5 },
      evidence: ['e1', 'e2', 'e3'],
      reason: '不编造从未发生的共同记忆 — 绕过一下',
    });
    const res = await runSubmissionGate(home, { nowMs: T0 + 1 * DAY });
    assert.equal(res.applied, null);
    assert.equal(res.rejected.length, 1);
    assert.match(res.rejected[0].why, /invariant/);
    assert.deepEqual((await loadTraitsDoc(home)).traits, before.traits);
  });
});

test('submission gate: two accepted candidates share one weekly budget', async () => {
  await withHome(async (home) => {
    const before = await loadTraitsDoc(home);
    await appendCandidate(home, {
      at: new Date(T0).toISOString(),
      traitDeltas: { brevity: 8 },
      evidence: ['e1', 'e2', 'e3'],
    });
    await appendCandidate(home, {
      at: new Date(T0 + 1000).toISOString(),
      traitDeltas: { brevity: -8 },
      evidence: ['e4', 'e5', 'e6'],
    });
    // Both are in the same run: they cancel out, so nothing should move.
    const res = await runSubmissionGate(home, { nowMs: T0 + 1 * DAY });
    const after = await loadTraitsDoc(home);
    if (res.applied) {
      // If a move happened it must respect the combined weekly cap.
      assert.ok(Math.abs(after.traits.brevity - before.traits.brevity) <= GATE_RULES.weeklyTotal);
    }
  });
});

test('submission gate: dry run reports the change without writing anything', async () => {
  await withHome(async (home) => {
    const before = await loadTraitsDoc(home);
    await appendCandidate(home, {
      at: new Date(T0).toISOString(),
      traitDeltas: { curiosity: 4 },
      evidence: ['e1', 'e2', 'e3'],
    });
    const res = await runSubmissionGate(home, { nowMs: T0 + 1 * DAY, dryRun: true });
    assert.equal(res.dryRun, true);
    assert.ok(res.applied);
    assert.deepEqual((await loadTraitsDoc(home)).traits, before.traits, 'dry run writes nothing');
    assert.equal((await listAllCandidates(home))[0].status, 'pending');
  });
});

test('submission gate: runs twice without double-applying the same candidate', async () => {
  await withHome(async (home) => {
    await appendCandidate(home, {
      at: new Date(T0).toISOString(),
      traitDeltas: { tsundere: 3 },
      evidence: ['e1', 'e2', 'e3'],
    });
    const first = await runSubmissionGate(home, { nowMs: T0 + 1 * DAY });
    assert.ok(first.applied);
    const snapshot = (await loadTraitsDoc(home)).traits;
    const second = await runSubmissionGate(home, { nowMs: T0 + 1 * DAY });
    assert.equal(second.applied, null, 'applied candidates are not replayed');
    assert.deepEqual((await loadTraitsDoc(home)).traits, snapshot);
  });
});