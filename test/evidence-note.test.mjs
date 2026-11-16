import test from 'node:test';
import assert from 'node:assert/strict';
import { narrateEvidence, withEvidenceNotes, countWithEvidence, evidenceDay } from '../packages/soulmate-core/evidence-note.mjs';

/**
 * #12 from the gap review: `evidence` was stored (and scrubbed, and synced) but never shown.
 * The requirement is a companion-like line — "我记得，因为那天你说…" — not a bare assertion.
 */

test('evidenceDay tolerates ISO timestamps, date-only values and garbage', () => {
  assert.equal(evidenceDay('2026-11-03T21:14:00.000Z'), '11-03');
  assert.equal(evidenceDay('2026-11-03'), '11-03');
  assert.equal(evidenceDay(''), '');
  assert.equal(evidenceDay('not a date'), '');
  assert.equal(evidenceDay(null), '');
});

test('narrateEvidence returns null when the memory has no quote — never fabricate one', () => {
  assert.equal(narrateEvidence({ text: '她怕黑' }), null);
  assert.equal(narrateEvidence({ text: '她怕黑', evidence: [] }), null);
  assert.equal(narrateEvidence({ text: '她怕黑', evidence: ['', '  '] }), null);
});

test('narrateEvidence turns a stored quote into a spoken line with the day', () => {
  const note = narrateEvidence({
    text: '她怕黑',
    t: '2026-11-03T21:14:00.000Z',
    evidence: ['我从小就怕黑，晚上不敢关灯'],
  });
  assert.ok(note);
  assert.equal(note.day, '11-03');
  assert.match(note.text, /^因为 11-03 你说过「/);
  assert.match(note.text, /怕黑/);
});

test('narrateEvidence falls back to a dateless line when the timestamp is unusable', () => {
  const note = narrateEvidence({ text: '她怕黑', t: 'oops', evidence: ['我不敢关灯'] });
  assert.equal(note.day, '');
  assert.equal(note.text, '因为你说过「我不敢关灯」');
});

test('narrateEvidence clips long quotes instead of dumping the whole paragraph', () => {
  const long = '这句话特别长'.repeat(30);
  const note = narrateEvidence({ text: 'x', evidence: [long] }, { maxQuote: 30 });
  assert.ok(note.quote.length <= 31, `quote should be clipped, got ${note.quote.length}`);
  assert.match(note.quote, /…$/);
});

test('withEvidenceNotes annotates only the traceable hits and leaves the rest alone', () => {
  const facts = [
    { id: 'f1', text: '她怕黑', evidence: ['我不敢关灯'] },
    { id: 'f2', text: '她喜欢抹茶' },
    { id: 'f3', text: '她在写插件', evidence: ['我在做 dsh 插件'] },
  ];
  const out = withEvidenceNotes(facts, { maxItems: 1 });
  assert.equal(out.length, 3);
  assert.ok(out[0].evidenceNote, 'f1 must be annotated');
  assert.equal(out[1].evidenceNote, undefined, 'f2 has no evidence, so no note');
  assert.ok(out[2].evidenceNote, 'f3 must be annotated');
  // The originals must not be mutated — recall results are cached and reused.
  assert.equal(facts[0].evidenceNote, undefined);
});

test('countWithEvidence reports the traceable ratio for the recall card', () => {
  assert.equal(countWithEvidence([{ evidence: ['a'] }, {}, { evidence: ['b', 'c'] }]), 2);
  assert.equal(countWithEvidence([]), 0);
  assert.equal(countWithEvidence(null), 0);
});