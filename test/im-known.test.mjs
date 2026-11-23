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
    'qqbot:1906510594:c2c:7C1158ADDC8CA761069C552A933687A3': 'session-a',
    'qqbot:1906510594:group:4A4029A7852330DD24F71399A4C7FEDE': 'session-b',
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
  assert.equal(c2c.to, '7C1158ADDC8CA761069C552A933687A3');
  assert.equal(c2c.groupId, '');
  assert.equal(grp.groupId, '4A4029A7852330DD24F71399A4C7FEDE');
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
    await appendImChat(home, { platform: 'qq', peerId: '7C1158ADDC8CA761069C552A933687A3', peerLabel: '重复私聊', role: 'user', text: 'hi' });
    await appendImChat(home, { platform: 'weixin', peerId: 'wxid_abc', peerLabel: '阿澈', role: 'user', text: '在吗' });
    const out = await listKnownImConversations(home, { readFileImpl: async () => PREFS });
    assert.equal(out.filter((c) => c.platform === 'qq' && c.to === '7C1158ADDC8CA761069C552A933687A3').length, 1, 'prefs 与台账去重');
    assert.ok(out.some((c) => c.platform === 'weixin' && c.to === 'wxid_abc' && c.label === '阿澈'));
    assert.ok(out.some((c) => c.groupId === '4A4029A7852330DD24F71399A4C7FEDE'));
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