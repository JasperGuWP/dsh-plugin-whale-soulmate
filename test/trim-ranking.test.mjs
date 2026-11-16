import test from 'node:test';
import assert from 'node:assert/strict';
import { fitMemoryDigest, rankForTrim } from '../packages/soulmate-core/budget.mjs';
import { recallScore, RECALL_WEIGHTS } from '../packages/soulmate-core/memory-contract.mjs';

/**
 * #11 from the gap review: trimming must drop the *least* important memory, not whatever
 * happens to be last in the array. An older, strongly-bonded memory should outlive a fresh
 * trivial one.
 *
 * The old `fitMemoryDigest` kept items in array order and stopped at the first overflow, so
 * "先到先得" decided what survived — and the caller never pre-sorted, despite the comment
 * claiming it did.
 */

const render = (items) => items.map((i) => `- ${i.text}`).join('\n');

test('trim ranking: bond matter outweighed by recency and salience', async () => {
  const now = Date.parse('2026-11-10T00:00:00Z');
  const fresh = { text: '今天喝了水', salience: 0.2, t: new Date(now - 60_000).toISOString(), decayClass: 'fact' };
  const bonded = { text: '她说过最怕被丢下', salience: 0.9, t: new Date(now - 200 * 86400_000).toISOString(), decayClass: 'preference' };
  // A high-salience, high-bond memory from long ago must outrank a trivial fresh one.
  const ranked = rankForTrim([fresh, bonded], { nowMs: now });
  assert.equal(ranked[0].text, bonded.text, 'the bonded memory must rank first');
});

test('fitMemoryDigest keeps the highest-ranked rows when the budget bites', async () => {
  const now = Date.parse('2026-11-10T00:00:00Z');
  const items = [
    { text: '琐事 A', salience: 0.1, t: new Date(now - 30_000).toISOString(), decayClass: 'fact' },
    { text: '重要 B', salience: 1.0, t: new Date(now - 300 * 86400_000).toISOString(), decayClass: 'preference' },
    { text: '琐事 C', salience: 0.1, t: new Date(now - 20_000).toISOString(), decayClass: 'fact' },
  ];
  // Room for exactly one line.
  const out = fitMemoryDigest(items, { maxChars: 10, render, nowMs: now });
  assert.equal(out.items.length, 1, 'only one item fits');
  assert.equal(out.items[0].text, '重要 B', 'the strongest memory survives, not the first one');
});

test('fitMemoryDigest preserves the caller order when no clock is given', async () => {
  // Backwards compatibility: without `nowMs` there is nothing to rank against, so the
  // historical behaviour (keep in order) stands.
  const items = [{ text: 'a' }, { text: 'b' }];
  const out = fitMemoryDigest(items, { maxChars: 100, render });
  assert.deepEqual(out.items.map((i) => i.text), ['a', 'b']);
});

test('recall weights still sum to one after the relationship bump', () => {
  const sum = Object.values(RECALL_WEIGHTS).reduce((a, b) => a + b, 0);
  assert.equal(Math.round(sum * 1000) / 1000, 1, 'the four weights must sum to 1');
  assert.ok(RECALL_WEIGHTS.relationship >= 0.2, 'relationship must not regress to the old 0.15');
});

test('recallScore rewards a shared-event history over a bare topical match', () => {
  const now = Date.parse('2026-11-10T00:00:00Z');
  const t = new Date(now - 10 * 86400_000).toISOString();
  const base = { text: 'x', salience: 0.5, t, decayClass: 'event' };
  const topical = recallScore({ similarity: 1, fact: base, nowMs: now, relationship: { warmth: 50, trust: 50 }, coEvent: 0 });
  const bonded = recallScore({ similarity: 1, fact: base, nowMs: now, relationship: { warmth: 50, trust: 50 }, coEvent: 1 });
  assert.ok(bonded.score > topical.score, 'a memory you lived through together must score higher');
  assert.ok(bonded.parts.relationship > topical.parts.relationship, 'the bond term is what moved');
});