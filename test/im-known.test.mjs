// IM 已知会话收集：QQ 官方 prefs 解析 + im-chat 台账合并 + /im/known 路由。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseQqbotPrefs, readQqbotKnownConversations, listKnownImConversations } from '../packages/soulmate-core/im-known.mjs';
import { appendImChat } from '../packages/soulmate-core/im-chat.mjs';
import { imChatRoutes } from '../packages/soulmate-core/routes/im-chat-routes.mjs';
import { resolveSoulmateHome } from '../packages/soulmate-core/state.mjs';

const PREFS = JSON.stringify({
  sessionIds: {
    'qqbot:1900000001:c2c:A1B2C3D4E5F60718293A4B5C6D7E8F90': 'session-a',
    'qqbot:1900000001:group:F0E1D2C3B4A5968778695A4B3C2D1E0F': 'session-b',
    'not-a-key': 'x',
  },
  presets: {},
});

test('parseQqbotPrefs maps c2c/group session keys to whitelist entries', () => {
  const out = parseQqbotPrefs(PREFS);
  assert.equal(out.length, 2);
  const c2c = out.find((c) => c.to);
  const grp = out.find((c) => c.groupId);
  assert.equal(c2c.platform, 'qq');
  assert.equal(c2c.to, 'A1B2C3D4E5F60718293A4B5C6D7E8F90');
  assert.equal(c2c.groupId, '');
  assert.equal(grp.groupId, 'F0E1D2C3B4A5968778695A4B3C2D1E0F');
  assert.equal(grp.to, '');
  assert.match(grp.label, /QQ群/);
  assert.deepEqual(parseQqbotPrefs('not json'), []);
  assert.deepEqual(parseQqbotPrefs({}), []);
});

test('readQqbotKnownConversations soft-fails when prefs file missing', async () => {
  const out = await readQqbotKnownConversations({ readFileImpl: async () => { throw new Error('ENOENT'); } });
  assert.deepEqual(out, []);
  const ok = await readQqbotKnownConversations({ readFileImpl: async () => PREFS });
  assert.equal(ok.length, 2);
});

test('listKnownImConversations merges qq prefs + im-chat contacts, dedupes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sm-im-known-'));
  try {
    const home = resolveSoulmateHome(dir);
    await appendImChat(home, { platform: 'qq', peerId: 'A1B2C3D4E5F60718293A4B5C6D7E8F90', peerLabel: '重复私聊', role: 'user', text: 'hi' });
    await appendImChat(home, { platform: 'weixin', peerId: 'wxid_abc', peerLabel: '阿澈', role: 'user', text: '在吗' });
    const out = await listKnownImConversations(home, { readFileImpl: async () => PREFS });
    assert.equal(out.filter((c) => c.platform === 'qq' && c.to === 'A1B2C3D4E5F60718293A4B5C6D7E8F90').length, 1, 'prefs 与台账去重');
    assert.ok(out.some((c) => c.platform === 'weixin' && c.to === 'wxid_abc' && c.label === '阿澈'));
    assert.ok(out.some((c) => c.groupId === 'F0E1D2C3B4A5968778695A4B3C2D1E0F'));
    assert.equal(out[0].source, 'qqbot-prefs', 'QQ prefs 在前');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('GET /im/known returns conversations', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sm-im-known-route-'));
  try {
    const home = resolveSoulmateHome(dir);
    const routes = imChatRoutes({ home });
    const known = routes.find((r) => r.paths.includes('/dsh-soulmate/api/im/known'));
    assert.ok(known);
    assert.equal(known.method, 'GET');
    const out = JSON.parse((await known.handler({ query: new URLSearchParams() })).body);
    assert.equal(out.ok, true);
    assert.ok(Array.isArray(out.conversations));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('im-known: QQ conversations carry real speaker nicknames from bridged transcripts', async () => {
  const { mkdtemp, rm, mkdir, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const zlib = await import('node:zlib');
  const dir = await mkdtemp(join(tmpdir(), 'sm-im-known-nick-'));
  try {
    const home = { rootDir: dir, logsDir: dir };
    // fake qqbot session transcript with a speaker line
    const sessDir = join(dir, '.dsh', 'sessions', 'ws-qqbot', 'session-x');
    await mkdir(sessDir, { recursive: true });
    const OWNER = 'A1B2C3D4E5F60718293A4B5C6D7E8F90';
    const rows = [
      { type: 'user/message', seq: 1, time: 1, data: { id: 'm1', content: [{ type: 'text', text: `[等风 (${OWNER})] 你好` }] } },
    ];
    await writeFile(join(sessDir, 'session.v4.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(rows.map((r) => JSON.stringify(r)).join('\n'))));
    const prefsDir = join(dir, '.dsh-qqbot');
    await mkdir(prefsDir, { recursive: true });
    await writeFile(join(prefsDir, 'model-prefs.json'), JSON.stringify({ sessionIds: { [`qqbot:190:c2c:${OWNER}`]: 'session-x' } }));
    const list = await listKnownImConversations(home, { homeDir: dir });
    const hit = list.find((c) => c.to === OWNER);
    assert.ok(hit, 'conversation present');
    assert.equal(hit.nickname, '等风');
    assert.match(hit.label, /等风/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('zstd-frames: multi-frame session logs decode fully on old node runtimes', async () => {
  const { zstdDecodeAll } = await import('../packages/soulmate-core/zstd-frames.mjs');
  const zlib = await import('node:zlib');
  // two appended frames, like DSH session flushes
  const f1 = zlib.zstdCompressSync(Buffer.from('line-one\n'));
  const f2 = zlib.zstdCompressSync(Buffer.from('line-two\n'));
  const joined = Buffer.concat([f1, f2]);
  assert.equal(zstdDecodeAll(joined), 'line-one\nline-two\n');
  // single frame still works
  assert.equal(zstdDecodeAll(f1), 'line-one\n');
});
