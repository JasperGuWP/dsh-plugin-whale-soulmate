// Tool output contract: the host validates tool results against output.schema and
// surfaced failures as "ToolOutputError: INVALID_TOOL_OUTPUT" (QQ bot, recall).
import test from 'node:test';
import assert from 'node:assert/strict';
import { GENERIC_OUTPUT, makeToolFactory } from '../packages/soulmate-core/tool-cards.mjs';
import { jsonSafe } from '../packages/soulmate-core/small-utils.mjs';

const make = (run) => makeToolFactory({ cardKind: 'test', ready: Promise.resolve() })({ name: 'soulmate_test', description: 't', parameters: {}, run });

/** Mirror of DSH's lossless-JSON gate: any own key holding undefined rejects the call. */
function losslessProblems(value, path = '$', out = [], seen = new Set()) {
  if (value === null || typeof value !== 'object') {
    if (value === undefined || (typeof value === 'number' && !Number.isFinite(value))) out.push(`${path} = ${String(value)}`);
    return out;
  }
  if (seen.has(value)) { out.push(`${path} circular`); return out; }
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((v, i) => losslessProblems(v, `${path}[${i}]`, out, seen));
    return out;
  }
  for (const k of Object.keys(value)) {
    if (value[k] === undefined) out.push(`${path}.${k} = undefined`);
    else losslessProblems(value[k], `${path}.${k}`, out, seen);
  }
  return out;
}

test('tool output schema is valid JSON Schema (required is an array, not a property flag)', () => {
  assert.equal(GENERIC_OUTPUT.type, 'object');
  assert.deepEqual(GENERIC_OUTPUT.required, ['ok']);
  assert.equal(GENERIC_OUTPUT.properties.ok.required, undefined);
  assert.equal(GENERIC_OUTPUT.additionalProperties, true);
});

test('tool results always carry a boolean ok, even for undefined or thrown values', async () => {
  const bare = make(async () => undefined);
  assert.deepEqual(await bare.execute({}, {}), { ok: true, value: null });

  const failing = make(async () => { throw new Error('boom'); });
  const err = await failing.execute({}, {});
  assert.equal(err.ok, false);
  assert.match(err.error, /boom/);

  const explicit = make(async () => ({ ok: false, error: 'nope' }));
  const res = await explicit.execute({}, {});
  assert.equal(res.ok, false);
  assert.equal(res.error, 'nope');
});

test('render survives unserializable results and presentationMeta never throws', async () => {
  const tool = make(async () => ({ ok: true, facts: [] }));
  const circular = { ok: true };
  circular.self = circular;
  const rendered = tool.output.render({}, circular);
  assert.equal(rendered[0].type, 'text');
  assert.match(rendered[0].text, /ok/);
  const meta = tool.output.presentationMeta({}, null);
  assert.equal(typeof meta, 'object');
});

// Regression: recall used to return wiki pages with `createdAt: undefined` (pages
// written by reflectToWiki never carry the field). DSH's lossless-JSON gate runs
// BEFORE serialization and rejected the whole call: "value is not lossless JSON".
test('execute strips undefined-valued own keys so the lossless-JSON gate passes', async () => {
  const tool = make(async () => ({
    ok: true,
    wiki: [{ slug: 'self-arc', title: '自我演变', createdAt: undefined }],
    facts: [{ id: 'f_x', halfLifeDays: undefined, nested: { gone: undefined, kept: 1 } }],
    mixed: [undefined, { a: undefined, b: 2 }],
    fid: undefined,
  }));
  const res = await tool.execute({}, {});
  assert.deepEqual(losslessProblems(res), []);
  assert.equal(res.wiki[0].slug, 'self-arc');
  assert.ok(!('createdAt' in res.wiki[0]));
  assert.ok(!('fid' in res));
  assert.equal(res.facts[0].nested.kept, 1);
  assert.ok(!('gone' in res.facts[0].nested));
  assert.equal(res.mixed[0], null, 'undefined array slots become null, not dropped');
  assert.equal(res.mixed[1].b, 2);
});

test('jsonSafe keeps plain data, nulls cycles, and leaves non-plain objects intact', () => {
  const date = new Date('2026-11-25T00:00:00.000Z');
  const cyclic = { ok: true };
  cyclic.self = cyclic;
  const cleaned = jsonSafe({ a: 1, b: undefined, when: date, deep: { c: undefined, d: [1, undefined, 'x'] }, loop: cyclic });
  assert.deepEqual(Object.keys(cleaned), ['a', 'when', 'deep', 'loop']);
  assert.equal(cleaned.when, date, 'Date instance is preserved for toJSON semantics');
  assert.deepEqual(cleaned.deep.d, [1, null, 'x']);
  assert.equal(cleaned.loop.self, null);
  assert.deepEqual(losslessProblems(cleaned), []);
});