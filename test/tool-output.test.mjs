// Tool output contract: the host validates tool results against output.schema and
// surfaced failures as "ToolOutputError: INVALID_TOOL_OUTPUT" (QQ bot, recall).
import test from 'node:test';
import assert from 'node:assert/strict';
import { GENERIC_OUTPUT, makeToolFactory } from '../packages/soulmate-core/tool-cards.mjs';

const make = (run) => makeToolFactory({ cardKind: 'test', ready: Promise.resolve() })({ name: 'soulmate_test', description: 't', parameters: {}, run });

test('tool output schema is valid JSON Schema (required is an array, not a property flag)', () => {
  assert.equal(GENERIC_OUTPUT.type, 'object');
  assert.deepEqual(GENERIC_OUTPUT.required, ['ok']);
  assert.equal(GENERIC_OUTPUT.properties.ok.required, undefined);
  assert.equal(GENERIC_OUTPUT.additionalProperties, true);
});

test('tool results always carry a boolean ok, even for undefined or thrown values', async () => {
  const bare = make(async () => undefined);
  assert.deepEqual(await bare.execute({}, {}), { ok: true, value: undefined });

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