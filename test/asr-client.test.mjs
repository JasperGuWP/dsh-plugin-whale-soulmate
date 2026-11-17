import assert from 'node:assert/strict';
import { test } from 'node:test';

import { transcribeViaEndpoint } from '../packages/soulmate-bili/asr-client.mjs';

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
