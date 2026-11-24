// one-shot LLM adapter: desktop hosts have no generateReply but do expose the llm service.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createUsageRuntime } from '../packages/soulmate-core/runtime/usage-runtime.mjs';

const mk = (opts = {}) => createUsageRuntime({
  home: { usagePath: 'x' },
  cfg: opts.cfg || {},
  warn: () => {},
  pushEvent: () => 0,
  sessionController: opts.sessionController || (() => null),
  getLlm: opts.getLlm,
});

test('oneShotLlm: generateReply wins when the host provides it', async () => {
  let via = '';
  const rt = mk({
    sessionController: () => ({ generateReply: async () => { via = 'generateReply'; return { text: 'A' }; } }),
    getLlm: () => ({ chat: async () => { via = 'chat'; return { text: 'B' }; } }),
  });
  const out = await rt.oneShotLlm({ prompt: 'p', kind: 'intent-llm' });
  assert.equal(via, 'generateReply');
  assert.equal(out.text, 'A');
});

test('oneShotLlm: falls back to llm.chat on desktop hosts without generateReply', async () => {
  const seen = [];
  const rt = mk({
    getLlm: () => ({
      chat: async (args) => {
        seen.push(args);
        return { text: '{"action":"silent"}', usage: { totalTokens: 12 } };
      },
    }),
  });
  const out = await rt.oneShotLlm({ prompt: '决策', modelId: 'cheap', kind: 'intent-llm' });
  assert.equal(out.text, '{"action":"silent"}');
  assert.equal(seen[0].purpose, 'intent-llm');
  assert.equal(seen[0].model, 'cheap');
  assert.equal(seen[0].messages[0].content[0].text, '决策');
});

test('oneShotLlm: llm.complete is the second fallback; nothing available still throws', async () => {
  const rt = mk({
    getLlm: () => ({ complete: async (args) => ({ text: 'C', promptSeen: args.prompt }) }),
  });
  const out = await rt.oneShotLlm({ prompt: 'x', kind: 'dream-llm' });
  assert.equal(out.text, 'C');

  const bare = mk({ getLlm: () => ({}) });
  await assert.rejects(() => bare.oneShotLlm({ prompt: 'x', kind: 'dream-llm' }), /no llm one-shot/);
});
test('oneShotLlm: real host llm.stream surface (text-delta chunks) is consumed', async () => {
  const seen = [];
  const rt = mk({
    getLlm: () => ({
      listProviders: () => [{ id: 'aliyunbailian' }],
      listModels: async () => [{ id: 'deepseek-v4-pro', pricing: { input: 1 } }],
      async *stream(options) {
        seen.push(options);
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text: '{"action":' };
        yield { type: 'text-delta', index: 0, text: '"silent"}' };
        yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } };
        yield { type: 'finish', reason: 'stop' };
      },
    }),
  });
  const out = await rt.oneShotLlm({ prompt: '决策', modelId: 'deepseek-v4-pro', kind: 'intent-llm' });
  assert.equal(out.text, '{"action":"silent"}');
  assert.equal(out.usage.outputTokens, 5);
  assert.equal(seen[0].provider, 'aliyunbailian');
  assert.equal(seen[0].model, 'deepseek-v4-pro');
  assert.equal(seen[0].purpose, 'intent-llm');
  assert.equal(seen[0].messages[0].content[0].text, '决策');
});

test('oneShotLlm: no selection and no explicit model fails loudly — never guesses a route', async () => {
  const bare = mk({
    getLlm: () => ({
      listProviders: () => [{ id: 'p1' }],
      listModels: async () => [{ id: 'm1' }],
      async *stream() { yield { type: 'text-delta', index: 0, text: 'should not run' }; },
    }),
  });
  await assert.rejects(() => bare.oneShotLlm({ prompt: 'x', modelId: '', kind: 'dream-llm' }), /no DSH model selection/);
});

test('model picker: never auto-selects tts/asr/image/embedding routes for text', async () => {
  const { resolveLlmModel, isChatModel } = await import('../packages/soulmate-core/llm-model-pick.mjs');
  const catalog = [
    { id: 'qwen3-tts-flash', provider: 'p' },              // cheapest-looking, NOT chat
    { id: 'qwen-audio-3.0-asr-flash', provider: 'p' },
    { id: 'wan2.7-image', provider: 'p' },
    { id: 'qwen3.7-text-embedding', provider: 'p' },
    { id: 'qwen3-omni-flash-realtime', provider: 'p' },
    { id: 'deepseek-v4-flash', provider: 'p' },            // real chat target
    { id: 'qwen3.7-plus', provider: 'p' },
  ];
  const picked = resolveLlmModel({ models: catalog });
  assert.equal(picked.id, 'deepseek-v4-flash');
  assert.equal(isChatModel({ id: 'qwen3-tts-flash' }), false);
  assert.equal(isChatModel({ id: 'deepseek-v4-flash' }), true);
  // explicit preference still honored even for an odd route
  const forced = resolveLlmModel({ models: catalog, preferredId: 'qwen3-tts-flash' });
  assert.equal(forced.id, 'qwen3-tts-flash');
});

test('oneShotLlm: provider error in finish chunk surfaces its message, not generic no-text', async () => {
  const rt = mk({
    getLlm: () => ({
      listProviders: () => [{ id: 'p' }],
      listModels: async () => [{ id: 'chat-m' }],
      async *stream() {
        yield { type: 'usage', usage: { inputTokens: 5, outputTokens: 0 } };
        yield { type: 'finish', reason: { kind: 'error', failure: { message: 'Output data may contain inappropriate content.', code: 'PI_AI_ERROR' } } };
      },
    }),
  });
  await assert.rejects(
    () => rt.oneShotLlm({ prompt: 'x', modelId: 'chat-m', kind: 'im-proactive' }),
    /inappropriate content.*PI_AI_ERROR/
  );
});

test('oneShotLlm: block-end only adapters (no deltas) still yield text', async () => {
  const rt = mk({
    getLlm: () => ({
      listProviders: () => [{ id: 'p' }],
      listModels: async () => [{ id: 'chat-m' }],
      async *stream() {
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'block-end', index: 0, block: { type: 'text', text: '整块交付' } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      },
    }),
  });
  const out = await rt.oneShotLlm({ prompt: 'x', modelId: 'chat-m', kind: 'dream-llm' });
  assert.equal(out.text, '整块交付');
});

test('oneShotLlm: defaults to the model currently selected in DSH (user decision)', async () => {
  const seen = [];
  const rt = createUsageRuntime({
    home: { usagePath: 'x' },
    cfg: {},
    warn: () => {},
    pushEvent: () => 0,
    sessionController: () => null,
    getLlm: () => ({
      listProviders: () => [{ id: 'other' }],
      listModels: async () => [{ id: 'cheap-flash' }],
      async *stream(o) { seen.push(o); yield { type: 'text-delta', index: 0, text: '好' }; },
    }),
    desktopSelection: { current: () => ({ provider: 'aliyunbailian', model: 'deepseek-v4.1-flash-1017', reasoningEffort: 'high' }) },
  });
  const out = await rt.oneShotLlm({ prompt: 'x', modelId: '', kind: 'im-proactive' });
  assert.equal(out.text, '好');
  assert.equal(seen[0].provider, 'aliyunbailian');
  assert.equal(seen[0].model, 'deepseek-v4.1-flash-1017');
  assert.equal(seen[0].reasoningEffort, 'high');
});

test('oneShotLlm: explicit per-feature modelId still wins over the live selection', async () => {
  const seen = [];
  const rt = createUsageRuntime({
    home: { usagePath: 'x' },
    cfg: {},
    warn: () => {},
    pushEvent: () => 0,
    sessionController: () => null,
    getLlm: () => ({
      listProviders: () => [{ id: 'p' }],
      listModels: async () => [{ id: 'chosen', provider: 'p2' }],
      async *stream(o) { seen.push(o); yield { type: 'text-delta', index: 0, text: 'ok' }; },
    }),
    desktopSelection: { current: () => ({ provider: 'aliyunbailian', model: 'live-model' }) },
  });
  await rt.oneShotLlm({ prompt: 'x', modelId: 'chosen', kind: 'dream-llm' });
  assert.equal(seen[0].model, 'chosen');
  assert.equal(seen[0].reasoningEffort, undefined);
});

test('oneShotLlm: failed route may reroute, but the user is notified (llm-rerouted event)', async () => {
  const seen = [];
  const events = [];
  const rt = createUsageRuntime({
    home: { usagePath: 'x' }, cfg: {}, warn: () => {},
    pushEvent: (type, extra) => { events.push({ type, ...extra }); return events.length; },
    sessionController: () => null,
    getLlm: () => ({
      listProviders: () => [{ id: 'broken' }, { id: 'good' }],
      listModels: async (pid) => pid === 'broken' ? [{ id: 'm-broken' }] : [{ id: 'm-good' }],
      async *stream(o) {
        seen.push(o.provider + '/' + o.model);
        if (o.provider === 'broken') {
          yield { type: 'finish', reason: { kind: 'error', failure: { message: 'Your api key is invalid', code: 'AUTH_FAILED' } } };
          return;
        }
        yield { type: 'text-delta', index: 0, text: '来自备用线路' };
      },
    }),
    desktopSelection: { current: () => ({ provider: 'broken', model: 'm-broken' }) },
  });
  const out = await rt.oneShotLlm({ prompt: 'x', modelId: '', kind: 'im-proactive' });
  assert.equal(out.text, '来自备用线路');
  assert.equal(events.length, 1, 'exactly one user-visible notice');
  assert.equal(events[0].type, 'llm-rerouted');
  assert.equal(events[0].from, 'broken/m-broken');
  assert.equal(events[0].to, 'good/m-good');
  assert.match(events[0].reason, /api key is invalid/);
});

test('oneShotLlm: all routes failing throws with the last route named — no fake success', async () => {
  const events = [];
  const rt = createUsageRuntime({
    home: { usagePath: 'x' }, cfg: {}, warn: () => {},
    pushEvent: (t, e) => { events.push({ t, ...e }); return 0; },
    sessionController: () => null,
    getLlm: () => ({
      listProviders: () => [{ id: 'p' }],
      listModels: async () => [{ id: 'm1' }, { id: 'm2' }],
      async *stream() {
        yield { type: 'finish', reason: { kind: 'error', failure: { message: 'quota exhausted', code: 'QUOTA' } } };
      },
    }),
    desktopSelection: { current: () => ({ provider: 'p', model: 'm1' }) },
  });
  await assert.rejects(() => rt.oneShotLlm({ prompt: 'x', modelId: '', kind: 'im-proactive' }), /quota exhausted/);
  assert.equal(events.length, 0, 'no reroute notice when nothing succeeded');
});
