import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveSoulmateHome,
  loadConfig,
  saveConfigAuto,
  DEFAULT_CONFIG,
} from '../packages/soulmate-core/state.mjs';
import {
  assertNoEnginePersonaWrite,
  assertNoPersonaPermissionGrant,
  assertNumericTime,
  ensurePersonaFiles,
  applyUserTraitPatch,
  appendCandidate,
  getEngineSnapshot,
  getStatusSnapshot,
  deriveStrategyParams,
  loadTraitsDoc,
  loadInvariants,
} from '../packages/soulmate-core/layers/index.mjs';

async function withHome(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'soulmate-layers-'));
  try {
    return await fn(resolveSoulmateHome(dir), dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const exists = (p) => access(p).then(() => true, () => false);

test('redlines: engine/tool/model cannot write persona; persona cannot grant permissions', () => {
  assert.throws(() => assertNoEnginePersonaWrite('engine'), /引擎 → 人格/);
  assert.throws(() => assertNoEnginePersonaWrite('tool'), /引擎 → 人格/);
  assert.throws(() => assertNoEnginePersonaWrite('model'), /引擎 → 人格/);
  assert.doesNotThrow(() => assertNoEnginePersonaWrite('user'));

  assert.throws(() => assertNoPersonaPermissionGrant({ sandbox: true }), /人格 → 权限/);
  assert.throws(() => assertNoPersonaPermissionGrant({ permissions: {} }), /人格 → 权限/);
  assert.doesNotThrow(() => assertNoPersonaPermissionGrant({ traits: { sassiness: 10 } }));
});

test('redlines: time enters as numbers only', () => {
  assert.throws(() => assertNumericTime(0), /时间/);
  assert.throws(() => assertNumericTime('now'), /时间/);
  const t = assertNumericTime(Date.parse('2026-11-06T12:00:00Z'), '2026-11-06T10:00:00Z');
  assert.equal(t.relativeHours, 2);
  assert.ok(t.decay > 0 && t.decay <= 1);
  assert.match(t.absoluteIso, /^2026-11-06T12:00:00/);
});

test('schema: ensurePersonaFiles migrates config.persona → traits.yaml once', async () => {
  await withHome(async (home) => {
    await saveConfigAuto(home, {
      persona: {
        traits: { tsundere: 11, clinginess: 22, sassiness: 33, curiosity: 44, brevity: 55 },
        traitDeltas: { sassiness: 5 },
        evolvedTraits: ['旧习惯'],
      },
    });
    assert.equal(await exists(home.traitsPath), false);

    const first = await ensurePersonaFiles(home);
    assert.equal(first.migrated, true);
    assert.equal(await exists(home.traitsPath), true);
    assert.equal(await exists(home.invariantsPath), true);
    assert.equal(await exists(home.selfPath), true);

    const doc = await loadTraitsDoc(home);
    assert.equal(doc.traits.tsundere, 11);
    assert.equal(doc.traitDeltas.sassiness, 5);
    assert.deepEqual(doc.evolvedTraits, ['旧习惯']);

    const inv = await loadInvariants(home);
    assert.ok(Array.isArray(inv.values) && inv.values.length > 0);

    // Second call is a no-op for traits.yaml (keeps migration stamp).
    await saveConfigAuto(home, { persona: { traits: { ...DEFAULT_CONFIG.persona.traits, tsundere: 99 } } });
    const second = await ensurePersonaFiles(home);
    assert.equal(second.migrated, false);
    const again = await loadTraitsDoc(home);
    assert.equal(again.traits.tsundere, 11, 'existing traits.yaml wins over later config edits');
  });
});

test('persona-layer: user patch writes traits+changelog; engine source is rejected', async () => {
  await withHome(async (home) => {
    await ensurePersonaFiles(home);
    const next = await applyUserTraitPatch(
      home,
      { traits: { tsundere: 40, clinginess: 50, sassiness: 60, curiosity: 70, brevity: 80 } },
      { source: 'user', reason: 'slider' }
    );
    assert.equal(next.traits.sassiness, 60);

    const changelog = (await readFile(home.changelogPath, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(changelog.length, 1);
    assert.equal(changelog[0].source, 'user');
    assert.equal(changelog[0].reason, 'slider');

    const cfg = await loadConfig(home);
    assert.equal(cfg.persona.traits.sassiness, 60, 'config.persona stays projected');

    await assert.rejects(
      () => applyUserTraitPatch(home, { traits: next.traits }, { source: 'tool' }),
      /引擎 → 人格/
    );
    await assert.rejects(
      () => applyUserTraitPatch(home, { permissions: { all: true } }, { source: 'user' }),
      /人格 → 权限/
    );
  });
});

test('persona-layer: appendCandidate never mutates traits', async () => {
  await withHome(async (home) => {
    await ensurePersonaFiles(home);
    const before = await loadTraitsDoc(home);
    const entry = await appendCandidate(home, {
      kind: 'self_growth',
      learned: ['候选证据'],
      traitDeltas: { sassiness: 99 },
      reason: 'test',
    });
    assert.equal(entry.status, 'pending');
    assert.equal(entry.traitDeltas.sassiness, 25);
    const after = await loadTraitsDoc(home);
    assert.deepEqual(after, before);
  });
});

test('scheduling: deriveStrategyParams maps traits to initiative / silence', () => {
  const high = deriveStrategyParams({ clinginess: 90, curiosity: 80, tsundere: 10, sassiness: 20, brevity: 80 });
  const low = deriveStrategyParams({ clinginess: 10, curiosity: 10, tsundere: 90, sassiness: 80, brevity: 20 });
  assert.ok(high.initiative > low.initiative);
  assert.ok(high.silenceThresholdHours < low.silenceThresholdHours);
  assert.equal(high.toneBias, 'gentle');
  assert.equal(low.toneBias, 'sharp');
  // The gate is wired now (packages/soulmate-core/proactive.mjs); `preview` would mean the
  // derived numbers are dead weight again.
  assert.equal(high.openingGate.mode, 'enforced');
  assert.equal(high.openingGate.executor, 'soulmate-core/proactive.mjs');
  assert.match(high.toolSurface.note, /软件权限/);
});

test('engine: getEngineSnapshot shape for /api/engine', async () => {
  await withHome(async (home) => {
    await ensurePersonaFiles(home);
    await appendCandidate(home, { learned: ['x'], traitDeltas: { curiosity: 3 } });
    const snap = await getEngineSnapshot(home, Date.parse('2026-11-06T12:00:00Z'));
    assert.equal(snap.ok, true);
    assert.ok(snap.status);
    assert.ok(snap.status.relationship);
    assert.ok(snap.status.memory);
    assert.ok(snap.status.time);
    assert.equal(typeof snap.status.time.nowMs, 'number');
    assert.equal(typeof snap.status.time.relativeHours, 'number');
    assert.equal(typeof snap.status.time.decay, 'number');
    assert.equal(snap.status.contextBudget.identity, 15);
    assert.equal(snap.status.contextBudget.relationship, 10);
    assert.equal(snap.status.contextBudget.memory, 45);
    assert.equal(snap.status.contextBudget.reserved, 30);
    assert.ok(snap.scheduling.strategy.initiative >= 0);
    assert.equal(snap.persona.candidatesPending, 1);
    assert.ok(Array.isArray(snap.persona.changelog));
    assert.equal(snap.redlines.engineToPersona, 'blocked — candidates only');

    const status = await getStatusSnapshot(home, Date.parse('2026-11-06T12:00:00Z'));
    assert.equal(typeof status.energy, 'number');
    assert.equal(typeof status.affinity, 'number');
  });
});
