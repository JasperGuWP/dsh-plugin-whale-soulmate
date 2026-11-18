import test from 'node:test';
import assert from 'node:assert/strict';
import { chatRoutes } from '../packages/soulmate-core/routes/chat-routes.mjs';

const route = (deps) => chatRoutes(deps).find((r) => r.paths.includes('/dsh-soulmate/api/ffmpeg-download'));

test('ffmpeg-download: asks the home conversation to download ffmpeg', async () => {
  let seen = '';
  const r = route({ askHomeAgent: async (text) => { seen = text; return { ok: true, via: 'prompt' }; } });
  assert.equal(r.method, 'POST');
  const out = await r.handler({ body: {} });
  assert.equal(out.status, 200);
  assert.deepEqual(JSON.parse(out.body), { ok: true, via: 'prompt' });
  assert.match(seen, /ffmpeg/);
  assert.match(seen, /下载/);
});

test('ffmpeg-download: reports 502 when the conversation cannot be reached', async () => {
  const r = route({ askHomeAgent: async () => ({ ok: false, error: 'no-prompt-api' }) });
  const out = await r.handler({ body: {} });
  assert.equal(out.status, 502);
  assert.deepEqual(JSON.parse(out.body), { ok: false, error: 'no-prompt-api' });
});

test('ffmpeg-download: 502 when the ask throws, 503 when unwired', async () => {
  const thrown = route({ askHomeAgent: async () => { throw new Error('agent-busy'); } });
  const a = await thrown.handler({ body: {} });
  assert.equal(a.status, 502);
  assert.equal(JSON.parse(a.body).error, 'agent-busy');

  const unwired = route({});
  const b = await unwired.handler({ body: {} });
  assert.equal(b.status, 503);
  assert.equal(JSON.parse(b.body).error, 'chat-home-unavailable');
});
test('pet-electron-install: asks the home conversation to install Electron', async () => {
  let seen = '';
  const r = chatRoutes({ askHomeAgent: async (text) => { seen = text; return { ok: true }; } })
    .find((x) => x.paths.includes('/dsh-soulmate/api/pet-electron-install'));
  assert.equal(r.method, 'POST');
  const out = await r.handler({ body: {} });
  assert.equal(out.status, 200);
  assert.match(seen, /Electron/);
  assert.match(seen, /electron\.exe/);
  assert.match(seen, /\.dsh\/electron/);
});
