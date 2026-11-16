import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveSoulmateHome } from '../packages/soulmate-core/state.mjs';
import {
  migrateFactsToContract,
  recallMemory,
  retainFact,
} from '../packages/soulmate-core/memory-engine.mjs';

const readJsonl = async (path) =>
  (await readFile(path, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
import {
  CONFIDENCE_BANDS,
  DEFAULT_HALF_LIFE_DAYS,
  MEMORY_KINDS,
  RECALL_WEIGHTS,
  confidenceBand,
  halfLifeFor,
  normalizeFact,
  recallScore,
  recencyOf,
  relationshipOf,
  salienceFromImportance,
  DECAY_CLASSES,
  DEFAULT_DECAY_CLASS,
  PRESENCE_DECAY_CLASSES,
  decayHalfLifeFor,
  inferDecayClass,
  isPresenceClass,
  reinforceGain,
  resolveHalfLifeDays,
  trimRank,
} from '../packages/soulmate-core/memory-contract.mjs';

const DAY = 86_400_000;
const T0 = Date.parse('2026-03-01T00:00:00.000Z');

async function withHome(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'soulmate-contract-'));
  try {
    const home = resolveSoulmateHome(dir);
    await fn(home, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('memory-contract: recall weights match the v2 design 0.45/0.20/0.15/0.20', () => {
  assert.deepEqual(RECALL_WEIGHTS, { similarity: 0.45, salience: 0.2, recency: 0.15, relationship: 0.2 });
  const total = Object.values(RECALL_WEIGHTS).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total - 1) < 1e-9, 'weights must sum to 1');
});

test('memory-contract: confidence bands are assert / hold / ask at 0.8 and 0.55', () => {
  assert.equal(CONFIDENCE_BANDS.assert, 0.8);
  assert.equal(CONFIDENCE_BANDS.hold, 0.55);
  assert.equal(confidenceBand(0.95), 'assert');
  assert.equal(confidenceBand(0.8), 'assert');
  assert.equal(confidenceBand(0.79), 'hold');
  assert.equal(confidenceBand(0.55), 'hold');
  assert.equal(confidenceBand(0.54), 'ask');
  assert.equal(confidenceBand(0), 'ask');
  assert.equal(confidenceBand(undefined), 'hold', 'missing confidence matches normalizeFact default (0.6)');
});

test('memory-contract: promises never decay, everything else defaults to 90 days', () => {
  assert.equal(halfLifeFor('promise', 30), 0);
  assert.equal(halfLifeFor('promise', undefined), 0);
  assert.equal(halfLifeFor('semantic', undefined), DEFAULT_HALF_LIFE_DAYS);
  assert.equal(DEFAULT_HALF_LIFE_DAYS, 90);
  assert.equal(halfLifeFor('semantic', 7), 7);
  assert.equal(halfLifeFor('episodic', 0), DEFAULT_HALF_LIFE_DAYS);
});

test('memory-contract: normalizeFact migrates legacy topic/content/importance rows', () => {
  const legacy = normalizeFact({
    id: 'f_old',
    topic: '咖啡',
    content: '只喝浅烘',
    importance: 4,
    category: 'preference',
    halfLifeDays: 30,
  });
  assert.equal(legacy.kind, 'semantic');
  assert.equal(legacy.text, '咖啡：只喝浅烘');
  assert.equal(legacy.salience, 0.8);
  assert.equal(legacy.importance, 4);
  // contract kept in both directions
  assert.equal(legacy.topic, '咖啡');
  assert.equal(legacy.content, '只喝浅烘');
  assert.equal(legacy.halfLifeDays, 30, 'explicit legacy half-life is respected');
  assert.ok(Array.isArray(legacy.evidence));
});

test('memory-contract: normalizeFact prefers contract fields and clamps them', () => {
  const f = normalizeFact({
    kind: 'promise',
    text: '周五一起看电影',
    t: new Date(T0).toISOString(),
    salience: 2,
    confidence: -1,
    evidence: ['2026-03-01 说好的', '', 42],
  });
  assert.equal(f.kind, 'promise');
  assert.equal(f.text, '周五一起看电影');
  assert.equal(f.salience, 1, 'salience clamps to 1');
  assert.equal(f.confidence, 0, 'confidence clamps to 0');
  assert.deepEqual(f.evidence, ['2026-03-01 说好的', '42']);
  assert.equal(f.halfLifeDays, 0, 'promise half-life forced to 0');
});

test('memory-contract: unknown kind falls back to semantic', () => {
  assert.equal(normalizeFact({ kind: 'gossip', text: 'x' }).kind, 'semantic');
  assert.deepEqual([...MEMORY_KINDS], ['episodic', 'semantic', 'promise']);
});

test('memory-contract: recency decays on a 90-day half-life and never for promises', () => {
  const f = { halfLifeDays: 90, recallCount: 0, updatedAt: new Date(T0).toISOString() };
  assert.ok(Math.abs(recencyOf(f, T0 + 90 * DAY) - 0.5) < 1e-9);
  assert.ok(Math.abs(recencyOf(f, T0 + 180 * DAY) - 0.25) < 1e-9);
  assert.equal(recencyOf({ ...f, halfLifeDays: 0 }, T0 + 3650 * DAY), 1);
  // reinforcement stretches the effective half-life
  const reinforced = { ...f, recallCount: 10 };
  assert.ok(recencyOf(reinforced, T0 + 90 * DAY) > recencyOf(f, T0 + 90 * DAY));
});

test('memory-contract: relationship term rewards promises and warm bonds', () => {
  const cold = relationshipOf({ kind: 'semantic', confidence: 0.6 }, { warmth: 0, trust: 0 });
  const warm = relationshipOf({ kind: 'semantic', confidence: 0.6 }, { warmth: 100, trust: 100 });
  const promise = relationshipOf({ kind: 'promise', confidence: 0.6 }, { warmth: 0, trust: 0 });
  assert.ok(warm > cold);
  assert.ok(promise > cold, 'a promise outranks trivia in the same bond');
  assert.equal(promise, 0.5, '0.5 tie + 0 bond + 0 coEvent');
  for (const v of [cold, warm, promise]) assert.ok(v >= 0 && v <= 1);
});

test('memory-contract: recallScore is the weighted sum of its four parts', () => {
  const fact = {
    kind: 'semantic',
    salience: 0.8,
    confidence: 0.8,
    halfLifeDays: 90,
    recallCount: 0,
    updatedAt: new Date(T0).toISOString(),
  };
  const { score, parts } = recallScore({ similarity: 1, fact, nowMs: T0, relationship: { warmth: 40, trust: 35 } });
  const expected =
    0.45 * 1 + 0.2 * 0.8 + 0.15 * 1 + 0.2 * parts.relationship;
  assert.ok(Math.abs(score - expected) < 1e-3, `${score} != ${expected}`);
  assert.deepEqual(Object.keys(parts).sort(), ['recency', 'relationship', 'salience', 'similarity']);
  // similarity dominates: a perfect match beats a perfect-salience, stale, cold one
  const stale = recallScore({
    similarity: 0.2,
    fact: { ...fact, salience: 1, halfLifeDays: 90, updatedAt: new Date(T0 - 900 * DAY).toISOString() },
    nowMs: T0,
    relationship: {},
  });
  assert.ok(score > stale.score);
});

test('memory-contract: salienceFromImportance maps the legacy 1..5 dial', () => {
  assert.equal(salienceFromImportance(5), 1);
  assert.equal(salienceFromImportance(1), 0.2);
  assert.equal(salienceFromImportance(undefined), 0.6);
  assert.equal(salienceFromImportance(99), 1);
});

test('memory-engine: retained promises get halfLifeDays 0 and survive recall decay', async () => {
  await withHome(async (home) => {
    const promise = await retainFact(home, {
      kind: 'promise',
      text: '答应周五陪你看电影',
      topic: 'promise',
      content: '答应周五陪你看电影',
      confidence: 0.9,
      salience: 1,
      evidence: ['2026-03-01 主动提起'],
      nowMs: T0,
    });
    assert.equal(promise.ok, true);
    assert.equal(promise.fact.kind, 'promise');
    assert.equal(promise.fact.halfLifeDays, 0);

    const out = await recallMemory(home, '电影', { nowMs: T0 + 800 * DAY, reinforce: false });
    const hit = out.facts.find((f) => f.id === promise.fact.id);
    assert.ok(hit, 'a promise must still be recollected 800 days later');
    assert.equal(hit.scoreParts.recency, 1);
    assert.equal(hit.confidenceBand, 'assert');
  });
});

test('memory-engine: recall exposes the four score parts and the confidence band', async () => {
  await withHome(async (home) => {
    await retainFact(home, {
      topic: 'espresso',
      content: 'morning espresso ritual',
      salience: 0.9,
      confidence: 0.5,
      nowMs: T0,
    });
    const out = await recallMemory(home, 'espresso', { nowMs: T0, reinforce: false });
    assert.equal(out.facts.length, 1);
    const [f] = out.facts;
    assert.ok(f.score > 0 && f.score <= 1, 'score is normalised to 0..1');
    assert.deepEqual(Object.keys(f.scoreParts).sort(), ['recency', 'relationship', 'salience', 'similarity']);
    assert.equal(f.scoreParts.similarity, 1, 'a full query match saturates similarity');
    assert.equal(f.confidenceBand, 'ask');
  });
});

test('memory-engine: relationship.json warmth lifts the recall score', async () => {
  await withHome(async (home) => {
    await retainFact(home, { topic: 'harbor', content: 'we walked the harbor at night', nowMs: T0 });
    const cold = await recallMemory(home, 'harbor', { nowMs: T0, reinforce: false, relationship: { warmth: 0, trust: 0 } });
    const warm = await recallMemory(home, 'harbor', { nowMs: T0, reinforce: false, relationship: { warmth: 100, trust: 100 } });
    assert.ok(warm.facts[0].score > cold.facts[0].score);
    assert.ok(warm.facts[0].scoreParts.relationship > cold.facts[0].scoreParts.relationship);
  });
});

test('memory-engine: migrateFactsToContract rewrites legacy rows once and is idempotent', async () => {
  await withHome(async (home) => {
    // A pre-contract store: only topic/content/importance, no kind/text/t/salience.
    await mkdir(home.memoryDir, { recursive: true });
    await mkdir(join(home.memoryDir, 'facts'), { recursive: true });
    const legacy = [
      { id: 'f_a', topic: '咖啡', content: '只喝浅烘', category: 'preference', importance: 4, visibility: 'syncable', halfLifeDays: 30, recallCount: 0, createdAt: new Date(T0).toISOString(), updatedAt: new Date(T0).toISOString() },
      { id: 'f_b', topic: '猫', content: '叫豆包', category: 'general', importance: 2, visibility: 'syncable', recallCount: 1, createdAt: new Date(T0).toISOString(), updatedAt: new Date(T0).toISOString() },
    ];
    await writeFile(home.factsPath, `${legacy.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');

    const first = await migrateFactsToContract(home);
    assert.equal(first.migrated, true);
    assert.equal(first.rewritten, 2);

    const rows = await readJsonl(home.factsPath);
    assert.equal(rows.length, 2);
    const a = rows.find((r) => r.id === 'f_a');
    assert.equal(a.kind, 'semantic');
    assert.equal(a.text, '咖啡：只喝浅烘');
    assert.equal(a.t, new Date(T0).toISOString());
    assert.equal(a.salience, 0.8);
    assert.equal(a.confidence, 0.6);
    assert.deepEqual(a.evidence, []);
    assert.equal(a.importance, 4, 'legacy dial preserved');
    assert.equal(a.topic, '咖啡', 'legacy dial preserved');
    assert.equal(a.halfLifeDays, 30, 'explicit legacy half-life is respected');

    // Second run is a no-op thanks to the marker file.
    const second = await migrateFactsToContract(home);
    assert.equal(second.migrated, false);
    assert.equal(second.reason, 'already-migrated');
    assert.deepEqual(await readJsonl(home.factsPath), rows);
  });
});

test('memory-engine: migrateFactsToContract also rewrites the private store', async () => {
  await withHome(async (home) => {
    await mkdir(home.privateDir, { recursive: true });
    await writeFile(
      join(home.privateDir, 'private-facts.jsonl'),
      `${JSON.stringify({ id: 'p_a', topic: '秘密', content: '不想说的事', importance: 5 })}\n`,
      'utf8'
    );
    const res = await migrateFactsToContract(home);
    assert.equal(res.privateFacts, 1);
    const rows = await readJsonl(join(home.privateDir, 'private-facts.jsonl'));
    assert.equal(rows[0].kind, 'semantic');
    assert.equal(rows[0].salience, 1);
    assert.equal(rows[0].halfLifeDays, 90);
  });
});

test('memory-engine: salience outranks a newer but trivial fact at equal similarity', async () => {
  await withHome(async (home) => {
    const trivial = await retainFact(home, {
      topic: 'garden note',
      content: 'garden has a new bench',
      salience: 0.1,
      nowMs: T0,
    });
    const meaningful = await retainFact(home, {
      topic: 'garden plan',
      content: 'garden is where you want the wedding',
      salience: 0.95,
      nowMs: T0 + 1000,
    });
    const out = await recallMemory(home, 'garden', { nowMs: T0 + 1000, reinforce: false, relationship: {} });
    assert.equal(out.facts[0].id, meaningful.fact.id);
    assert.ok(out.facts.findIndex((f) => f.id === trivial.fact.id) === 1);
  });
});
// ---------------------------------------------------------------------------
// v3 contract (design 2026-11-09 §1–§3)
// ---------------------------------------------------------------------------

test('memory-contract v3: decay classes carry curve, gain, presence and trim rank', () => {
  assert.equal(decayHalfLifeFor('preference'), 0);
  assert.equal(decayHalfLifeFor('fact'), 180);
  assert.equal(decayHalfLifeFor('event'), 90);
  assert.equal(decayHalfLifeFor('emotion'), 21);
  assert.equal(reinforceGain('preference'), 0, 'preferences never stretch on recall');
  assert.equal(reinforceGain('emotion'), 0);
  assert.equal(reinforceGain('fact'), 1.3);
  assert.equal(isPresenceClass('preference'), true);
  assert.equal(isPresenceClass('event'), false);
  assert.ok(trimRank('promise') > trimRank('preference'));
  assert.ok(trimRank('preference') > trimRank('fact'));
  assert.ok(trimRank('fact') > trimRank('event'));
  assert.ok(trimRank('event') > trimRank('emotion'));
  assert.deepEqual([...PRESENCE_DECAY_CLASSES], ['preference', 'fact']);
});

test('memory-contract v3: inferDecayClass follows the §1 rules in order', () => {
  assert.equal(inferDecayClass({ decayClass: 'emotion' }), 'emotion', 'explicit wins');
  assert.equal(inferDecayClass({ decayClass: 'nonsense', kind: 'promise' }), 'promise');
  assert.equal(inferDecayClass({ kind: 'promise' }), 'promise');
  assert.equal(inferDecayClass({ category: 'preference' }), 'preference');
  assert.equal(inferDecayClass({ category: 'mood' }), 'emotion');
  assert.equal(inferDecayClass({ category: 'video' }), 'event');
  assert.equal(inferDecayClass({ kind: 'episodic' }), 'event');
  assert.equal(inferDecayClass({ category: 'decision' }), DEFAULT_DECAY_CLASS);
  assert.equal(inferDecayClass({}), DEFAULT_DECAY_CLASS);
});

test('memory-contract v3: write-path half-lives are clamped to ±50% of the class default', () => {
  assert.deepEqual(resolveHalfLifeDays({ kind: 'promise', requested: 30 }), { ok: true, value: 0 });
  assert.deepEqual(resolveHalfLifeDays({ decayClass: 'fact' }), { ok: true, value: 180 });
  assert.deepEqual(resolveHalfLifeDays({ decayClass: 'fact', requested: 90 }), { ok: true, value: 90 });
  assert.deepEqual(resolveHalfLifeDays({ decayClass: 'fact', requested: 270 }), { ok: true, value: 270 });
  const tooFast = resolveHalfLifeDays({ decayClass: 'fact', requested: 30 });
  assert.equal(tooFast.ok, false);
  assert.match(tooFast.error, /±50%|outside/);
  const tooSlow = resolveHalfLifeDays({ decayClass: 'emotion', requested: 400 });
  assert.equal(tooSlow.ok, false);
  const neverDecays = resolveHalfLifeDays({ decayClass: 'preference', requested: 30 });
  assert.equal(neverDecays.ok, false, 'a preference must not be given a curve');
  assert.deepEqual(resolveHalfLifeDays({ decayClass: 'preference' }), { ok: true, value: 0 });
  assert.equal(resolveHalfLifeDays({ decayClass: 'fact', requested: -5 }).ok, false);
});

test('memory-contract v3: normalizeFact fills decayClass, provenance, promise and conflict fields', () => {
  const legacy = normalizeFact({ id: 'f_old', topic: '咖啡', content: '只喝浅烘', category: 'preference', importance: 4 });
  assert.equal(legacy.decayClass, 'preference');
  assert.deepEqual(legacy.provenance, { source: 'legacy', sessionId: null, at: legacy.t });
  assert.equal(legacy.promise, null);
  assert.equal(legacy.conflictWith, null);
  assert.equal(legacy.conflictOpenedAt, null);

  const promise = normalizeFact({ kind: 'promise', text: '周五看电影' });
  assert.deepEqual(promise.promise, { status: 'made', dueAt: null, note: null });
  const kept = normalizeFact({ kind: 'promise', text: 'x', promise: { status: 'kept', dueAt: '2026-11-12T00:00:00Z', note: 'done' } });
  assert.equal(kept.promise.status, 'kept');
  assert.equal(kept.promise.dueAt, '2026-11-12T00:00:00Z');
  const badStatus = normalizeFact({ kind: 'promise', text: 'x', promise: { status: 'vaporized' } });
  assert.equal(badStatus.promise.status, 'made', 'unknown statuses fall back to made');

  const prov = normalizeFact({ text: 'x', provenance: { source: 'bili', sessionId: 'session-1', at: '2026-11-09T07:43:32Z' } });
  assert.deepEqual(prov.provenance, { source: 'bili', sessionId: 'session-1', at: '2026-11-09T07:43:32Z' });
});

test('memory-contract v3: conflict is a band of its own, whatever the confidence', () => {
  const f = { confidence: 0.95, conflictWith: 'f_other' };
  assert.equal(confidenceBand(f), 'conflict');
  assert.equal(confidenceBand({ ...f, conflictWith: '' }), 'assert');
  assert.equal(confidenceBand({ confidence: 0.5 }), 'ask');
  assert.equal(confidenceBand(0.95), 'assert', 'numeric calls keep working');
});

test('memory-contract v3: preference and emotion recency never stretches on recall', () => {
  const base = { decayClass: 'preference', halfLifeDays: 0, recallCount: 0, updatedAt: new Date(T0).toISOString() };
  assert.equal(recencyOf(base, T0 + 3650 * DAY), 1);
  const emotion = { decayClass: 'emotion', halfLifeDays: 21, recallCount: 50, updatedAt: new Date(T0).toISOString() };
  const plain = { ...emotion, recallCount: 0 };
  assert.equal(recencyOf(emotion, T0 + 21 * DAY), recencyOf(plain, T0 + 21 * DAY), 'gain 0 means no stretch');
  const fact = { decayClass: 'fact', halfLifeDays: 180, recallCount: 10, updatedAt: new Date(T0).toISOString() };
  assert.ok(recencyOf(fact, T0 + 180 * DAY) > recencyOf({ ...fact, recallCount: 0 }, T0 + 180 * DAY));
});

test('memory-contract v3: coEvent lifts the relationship term and feeds the score', () => {
  const fact = { kind: 'semantic', confidence: 0.6, decayClass: 'fact', halfLifeDays: 180, recallCount: 0, updatedAt: new Date(T0).toISOString() };
  const lone = relationshipOf(fact, { warmth: 0, trust: 0 }, 0);
  const entangled = relationshipOf(fact, { warmth: 0, trust: 0 }, 1);
  assert.ok(entangled > lone);
  assert.ok(Math.abs(entangled - lone - 0.2) < 1e-9);
  const scored = recallScore({ similarity: 0.5, fact, nowMs: T0, relationship: {}, coEvent: 1 });
  const plain = recallScore({ similarity: 0.5, fact, nowMs: T0, relationship: {} });
  assert.ok(scored.score > plain.score);
  assert.equal(scored.parts.relationship, entangled);
});
