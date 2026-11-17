import test from 'node:test';
import assert from 'node:assert/strict';
import { createHostVisionSummarize } from '../packages/soulmate-bili/host-vision.mjs';

/**
 * 宿主把 admission/steer 失败统一报成 agent-busy「prompt rejected」。
 * 拒收 → 4s 重试 → 仍拒则 forceRotate 换新会话再试;拒收原因落 logs/proactive.jsonl。
 */

const REPLY = '总览:测试片\n时间线:\n· 00:00–00:30 开场:要点\n观感:清楚';

function mocks({ rejectTimes = 2 } = {}) {
  const state = { promptCalls: 0, rotateFlags: [], accepted: false };
  const controller = {
    prompt: async () => {
      state.promptCalls++;
      if (state.promptCalls <= rejectTimes) return { ok: false, error: 'prompt rejected' };
      state.accepted = true;
      return { ok: true, accepted: true };
    },
    events: async () => ({
      records: state.accepted
        ? [{ type: 'event', event: { type: 'assistant/message', data: { message: { id: 'm1', content: [{ type: 'text', text: REPLY }] } } } }]
        : [],
    }),
  };
  const chatHome = {
    ensureHomeSession: async ({ forceRotate }) => {
      state.rotateFlags.push(!!forceRotate);
      return { ok: true, sessionId: 's' + state.rotateFlags.length };
    },
  };
  return { state, controller, chatHome };
}

const IMAGES = [{ tSec: 0, url: 'data:image/jpeg;base64,QUJD', label: '00:00' }];

test('host-vision: rejection retries then rotates to a fresh session', async () => {
  const { state, controller, chatHome } = mocks({ rejectTimes: 2 });
  const summarize = createHostVisionSummarize({ controller, chatHome, soulmateRoot: '' });
  const out = await summarize({ prompt: '分析本片', images: IMAGES });
  assert.match(out.text, /总览/);
  assert.equal(state.promptCalls, 3);
  assert.deepEqual(state.rotateFlags, [false, false, true]);
});

test('host-vision: transient rejection recovers on plain retry without rotation', async () => {
  const { state, controller, chatHome } = mocks({ rejectTimes: 1 });
  const summarize = createHostVisionSummarize({ controller, chatHome, soulmateRoot: '' });
  const out = await summarize({ prompt: '分析本片', images: IMAGES });
  assert.match(out.text, /总览/);
  assert.equal(state.promptCalls, 2);
  assert.deepEqual(state.rotateFlags, [false, false]);
});

test('host-vision: non-rejection errors propagate without retry', async () => {
  const { controller, chatHome } = mocks({ rejectTimes: 0 });
  controller.prompt = async () => { throw new Error('boom'); };
  const summarize = createHostVisionSummarize({ controller, chatHome, soulmateRoot: '' });
  await assert.rejects(() => summarize({ prompt: '分析本片', images: IMAGES }), /boom/);
});
test('host-vision: thrown RemoteError rejection also retries and rotates', async () => {
  const { state, controller, chatHome } = mocks({ rejectTimes: 0 });
  controller.prompt = async () => {
    state.promptCalls++;
    if (state.promptCalls <= 2) throw new Error('prompt rejected');
    state.accepted = true;
    return { ok: true, accepted: true };
  };
  const summarize = createHostVisionSummarize({ controller, chatHome, soulmateRoot: '' });
  const out = await summarize({ prompt: '分析本片', images: IMAGES });
  assert.match(out.text, /总览/);
  assert.equal(state.promptCalls, 3);
  assert.deepEqual(state.rotateFlags, [false, false, true]);
});

test('host-vision: attachment-invalid (model lacks vision) propagates without rotation', async () => {
  const { state, controller, chatHome } = mocks({ rejectTimes: 0 });
  controller.prompt = async () => {
    state.promptCalls++;
    throw new Error('Model "x" does not support image input.');
  };
  const summarize = createHostVisionSummarize({ controller, chatHome, soulmateRoot: '' });
  await assert.rejects(() => summarize({ prompt: '分析本片', images: IMAGES }), /does not support image/);
  assert.equal(state.promptCalls, 1, 'no pointless retry for modality rejection');
});

test('host-vision: harness image parts use flat data/mediaType shape the host admission reads', async () => {
  const { state, controller, chatHome } = mocks({ rejectTimes: 0 });
  let seen = null;
  controller.prompt = async (req) => {
    seen = req.content;
    state.accepted = true;
    return { ok: true, accepted: true };
  };
  const summarize = createHostVisionSummarize({ controller, chatHome, soulmateRoot: '' });
  await summarize({ prompt: '分析本片', images: IMAGES });
  const img = seen.find((p) => p.type === 'image');
  assert.ok(img, 'image part present');
  assert.equal(img.data, 'QUJD');
  assert.equal(img.mediaType, 'image/jpeg');
  assert.equal(img.source, undefined, 'no nested source shape');
});
