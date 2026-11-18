import assert from 'node:assert/strict';
import { test } from 'node:test';

import { transcribeViaEndpoint, fetchAsrModels, transcribeOpenAiAudio, transcribeDashScope, transcribeDeepseek, resolveAsrProtocol, preferAsrTranscript } from '../packages/soulmate-bili/asr-client.mjs';

test('ASR unconfigured skips', async () => {
  const r = await transcribeViaEndpoint({ endpoint: '' });
  assert.equal(r.ok, false);
  assert.equal(r.channel, 'skip:unconfigured');
});

test('ASR mock success joins segments', async () => {
  const r = await transcribeViaEndpoint({
    endpoint: 'https://asr.example/v1',
    apiKey: 'secret',
    bvid: 'BV1test',
    fetchImpl: async (url, init) => {
      assert.match(url, /asr\.example/);
      assert.equal(init.headers.authorization, 'Bearer secret');
      const body = JSON.parse(init.body);
      assert.equal(body.bvid, 'BV1test');
      return {
        ok: true,
        json: async () => ({
          segments: [
            { startSec: 0, endSec: 5, text: '整数' },
            { startSec: 5, endSec: 10, text: '浮点数' },
          ],
        }),
      };
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.channel, 'ok');
  assert.match(r.text, /整数/);
  assert.match(r.text, /浮点数/);
});

test('ASR http error soft-fails', async () => {
  const r = await transcribeViaEndpoint({
    endpoint: 'https://asr.example/v1',
    fetchImpl: async () => ({ ok: false, status: 502, json: async () => ({}) }),
  });
  assert.equal(r.channel, 'skip:error');
});

test('ASR model id is forwarded in the request body when configured', async () => {
  const r = await transcribeViaEndpoint({
    endpoint: 'https://asr.example/v1',
    model: 'sensevoice-small',
    bvid: 'BV1test',
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      assert.equal(body.model, 'sensevoice-small');
      return { ok: true, json: async () => ({ text: 'ok' }) };
    },
  });
  assert.equal(r.ok, true);
});

test('ASR request omits model when not configured', async () => {
  await transcribeViaEndpoint({
    endpoint: 'https://asr.example/v1',
    bvid: 'BV1test',
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      assert.equal('model' in body, false);
      return { ok: true, json: async () => ({ text: 'ok' }) };
    },
  });
});

test('fetchAsrModels derives /models URL and parses OpenAI data[] shape', async () => {
  const r = await fetchAsrModels({
    endpoint: 'https://asr.example/v1/transcribe',
    apiKey: 'k',
    fetchImpl: async (url, init) => {
      assert.equal(url, 'https://asr.example/v1/models');
      assert.equal(init.headers.authorization, 'Bearer k');
      return { ok: true, json: async () => ({ data: [{ id: 'whisper-1' }, { id: 'sensevoice-small' }] }) };
    },
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.models, ['whisper-1', 'sensevoice-small']);
});

test('fetchAsrModels parses models[] string shape and dedupes', async () => {
  const r = await fetchAsrModels({
    endpoint: 'https://asr.example/v1/audio/transcriptions',
    fetchImpl: async () => ({ ok: true, json: async () => ({ models: ['a', { id: 'b' }, 'a'] }) }),
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.models, ['a', 'b']);
});

test('fetchAsrModels soft-fails on http error or bad endpoint', async () => {
  const bad = await fetchAsrModels({ endpoint: 'not a url' });
  assert.equal(bad.ok, false);
  const http = await fetchAsrModels({
    endpoint: 'https://asr.example/v1/transcribe',
    fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }),
  });
  assert.equal(http.ok, false);
  assert.equal(http.error, 'http-401');
});

test('fetchAsrModels keeps the version segment: base /v1 → /v1/models (aliyun-compatible)', async () => {
  const r = await fetchAsrModels({
    endpoint: 'https://x.maas.aliyuncs.com/compatible-mode/v1',
    fetchImpl: async (url) => {
      assert.equal(url, 'https://x.maas.aliyuncs.com/compatible-mode/v1/models');
      return { ok: true, json: async () => ({ data: [{ id: 'paraformer-v2' }] }) };
    },
  });
  assert.equal(r.ok, true);
});

test('fetchAsrModels deep action path falls back to the version-scoped /models', async () => {
  const r = await fetchAsrModels({
    endpoint: 'https://api.example/v1/audio/transcriptions',
    fetchImpl: async (url) => {
      assert.equal(url, 'https://api.example/v1/models');
      return { ok: true, json: async () => ({ data: [] }) };
    },
  });
  assert.equal(r.ok, true);
});

test('transcribe: base /v1 endpoint auto-completes /audio/transcriptions', async () => {
  const r = await transcribeViaEndpoint({
    endpoint: 'https://x.maas.aliyuncs.com/compatible-mode/v1',
    bvid: 'BV1',
    fetchImpl: async (url) => {
      assert.equal(url, 'https://x.maas.aliyuncs.com/compatible-mode/v1/audio/transcriptions');
      return { ok: true, json: async () => ({ text: 'ok' }) };
    },
  });
  assert.equal(r.ok, true);
});

test('resolveAsrProtocol: explicit families pass through, auto recommends deepseek', () => {
  assert.equal(resolveAsrProtocol('https://x.maas.aliyuncs.com/compatible-mode/v1', 'auto'), 'dashscope');
  assert.equal(resolveAsrProtocol('https://api.deepseek.com/v1', 'auto'), 'deepseek');
  assert.equal(resolveAsrProtocol('https://api.openai.com/v1', 'auto'), 'deepseek');
  assert.equal(resolveAsrProtocol('https://x.aliyuncs.com/v1', 'json'), 'json');
  assert.equal(resolveAsrProtocol('https://x.ok.com/v1', 'dashscope'), 'dashscope');
});

test('transcribeOpenAiAudio: downloads audio then posts multipart with model', async () => {
  const calls = [];
  const r = await transcribeOpenAiAudio({
    endpoint: 'https://volc.example/v1',
    apiKey: 'k',
    model: 'whisper-1',
    audioUrl: 'https://cdn.example/audio.m4s',
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).includes('cdn.example')) {
        return { ok: true, arrayBuffer: async () => new TextEncoder().encode('AUDIO').buffer };
      }
      return { ok: true, json: async () => ({ text: '转写结果' }) };
    },
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, 'https://volc.example/v1/audio/transcriptions');
  assert.equal(calls[1].init.method, 'POST');
  const form = calls[1].init.body;
  assert.ok(form instanceof FormData);
  assert.equal(form.get('model'), 'whisper-1');
  assert.ok(form.get('file'), 'file part present');
  assert.equal(r.ok, true);
  assert.match(r.text, /转写结果/);
});

test('transcribeOpenAiAudio: missing audio url soft-fails before any request', async () => {
  const r = await transcribeOpenAiAudio({ endpoint: 'https://x/v1', audioUrl: '' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'no-audio-url');
});

test('transcribeDashScope: downloads audio then posts base64 data URI via chat/completions', async () => {
  const calls = [];
  const r = await transcribeDashScope({
    endpoint: 'https://x.maas.aliyuncs.com/compatible-mode/v1',
    apiKey: 'k',
    model: 'qwen-audio-asr',
    audioUrl: 'https://cdn.example/a.m4s',
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).includes('cdn.example')) {
        return { ok: true, arrayBuffer: async () => new TextEncoder().encode('AUDIO').buffer };
      }
      return {
        ok: true,
        text: async () => JSON.stringify({ choices: [{ message: { content: '阿里转写' } }] }),
      };
    },
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, 'https://x.maas.aliyuncs.com/compatible-mode/v1/chat/completions');
  assert.equal(calls[1].init.headers.authorization, 'Bearer k');
  const body = JSON.parse(calls[1].init.body);
  assert.equal(body.model, 'qwen-audio-asr');
  const part = body.messages[0].content[0];
  assert.equal(part.type, 'input_audio');
  assert.match(part.input_audio.data, /^data:audio\/mp4;base64,/);
  assert.equal(part.input_audio.data, 'data:audio/mp4;base64,' + Buffer.from('AUDIO').toString('base64'));
  assert.equal(r.ok, true);
  assert.match(r.text, /阿里转写/);
});

test('transcribeDashScope: 400 falls back to qwen3-asr-flash', async () => {
  const models = [];
  const r = await transcribeDashScope({
    endpoint: 'https://x.maas.aliyuncs.com/compatible-mode/v1',
    apiKey: 'k',
    model: 'qwen-audio-3.0-asr-flash',
    audioUrl: 'https://cdn.example/a.m4s',
    fetchImpl: async (url, init) => {
      if (String(url).includes('cdn.example')) {
        return { ok: true, arrayBuffer: async () => new TextEncoder().encode('AUDIO').buffer };
      }
      const model = JSON.parse(init.body).model;
      models.push(model);
      if (model !== 'qwen3-asr-flash') return { ok: false, status: 400, text: async () => '{"error":"bad model"}' };
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: '回退成功' } }] }) };
    },
  });
  assert.deepEqual(models, ['qwen-audio-3.0-asr-flash', 'qwen3-asr-flash']);
  assert.equal(r.ok, true);
  assert.equal(r.text, '回退成功');
});

test('transcribeDeepseek: missing audio url soft-fails before any request', async () => {
  const r = await transcribeDeepseek({ endpoint: 'https://api.deepseek.com/v1', audioUrl: '' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'no-audio-url');
});

test('transcribeDeepseek: reports no-ffmpeg instead of throwing when ffmpeg is missing', async () => {
  const r = await transcribeDeepseek({
    endpoint: 'https://api.deepseek.com/v1',
    apiKey: 'k',
    audioUrl: 'https://cdn.example/a.m4s',
    ffmpegPath: 'definitely-not-a-real-ffmpeg-binary',
    fetchImpl: async (url) => {
      assert.match(String(url), /cdn\.example/);
      return { ok: true, arrayBuffer: async () => new TextEncoder().encode('AUDIO').buffer };
    },
  });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'no-ffmpeg');
});

test('preferAsrTranscript: replaces missing/mismatched subtitles, needs 30% coverage otherwise', () => {
  assert.equal(preferAsrTranscript({ official: '', asrText: 'x', transcriptEmpty: false }), true);
  assert.equal(preferAsrTranscript({ official: 'a'.repeat(500), asrText: 'b'.repeat(200), transcriptEmpty: true }), true);
  assert.equal(preferAsrTranscript({ official: 'a'.repeat(1000), asrText: 'b'.repeat(500), transcriptEmpty: false }), true);
  assert.equal(preferAsrTranscript({ official: 'a'.repeat(1000), asrText: 'b'.repeat(100), transcriptEmpty: false }), false);
  assert.equal(preferAsrTranscript({ official: 'a'.repeat(100), asrText: 'b'.repeat(39), transcriptEmpty: false }), false);
  assert.equal(preferAsrTranscript({ official: 'a'.repeat(100), asrText: 'b'.repeat(40), transcriptEmpty: false }), true);
  assert.equal(preferAsrTranscript({ official: 'a'.repeat(100), asrText: '   ', transcriptEmpty: true }), false);
});
