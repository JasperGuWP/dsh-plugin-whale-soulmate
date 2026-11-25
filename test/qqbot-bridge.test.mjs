// Official QQ bot bridge: session files → IM timeline + memory stars, with owner detection.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import zlib from 'node:zlib';
import { resolveSoulmateHome, saveConfigAuto } from '../packages/soulmate-core/state.mjs';
import {
  createQqbotBridgeRuntime,
  parseConversationKey,
  parseQqSession,
} from '../packages/soulmate-core/runtime/qqbot-bridge-runtime.mjs';

const { setQqInboundStore } = await import('../packages/soulmate-core/qqbot-inbound-mirror.mjs');
const { mkdtemp: mkTmp } = await import('node:fs/promises');
const { tmpdir: tmpOs } = await import('node:os');
// Never read/write the developer's real mirror files during tests.
setQqInboundStore(await mkTmp(join(tmpOs(), 'sm-qqmirror-')));

const OWNER = 'A1B2C3D4E5F60718293A4B5C6D7E8F90';
const GROUP = 'F0E1D2C3B4A5968778695A4B3C2D1E0F';
const MEMBER = '0F1E2D3C4B5A69788796A5B4C3D2E1F0';

test('qqbot bridge: conversation keys map c2c and group conversations', () => {
  assert.deepEqual(parseConversationKey(`qqbot:1900000001:c2c:${OWNER}`), { kind: 'c2c', appId: '1900000001', peer: OWNER, groupId: '' });
  const g = parseConversationKey(`qqbot:1900000001:group:${GROUP}`);
  assert.equal(g.kind, 'group');
  assert.equal(g.groupId, GROUP);
  assert.equal(parseConversationKey('garbage'), null);
});

test('qqbot bridge: session parser understands envelopes, history and speaker prefixes', () => {
  const lines = [
    { seq: 1, type: 'user/message', time: 1000, data: { content: [{ type: 'text', text: '[Chat history begins]\n[等风 (' + OWNER + ')] 旧消息\n[Chat history ends]\n[Current message]\n[等风 (' + OWNER + ')] <@7DC4> 你好 (@you)' }] } },
    { seq: 2, type: 'assistant/message', time: 2000, data: { message: { content: [{ type: 'text', text: '哟，来了。' }] } } },
    { seq: 3, type: 'user/message', time: 3000, data: { content: [{ type: 'text', text: '[星☯辰 (' + MEMBER + ')] 在吗' }] } },
    { seq: 4, type: 'user/message', time: 4000, data: { content: [{ type: 'text', text: 'Time sampled while preparing turn 3, step 1: ...' }] } },
  ];
  const events = parseQqSession(lines, { sinceSeq: 0, kind: 'group' });
  assert.equal(events.length, 3);
  assert.equal(events[0].senderId, OWNER);
  assert.equal(events[0].text, '你好');
  assert.equal(events[1].role, 'bot');
  assert.equal(events[1].text, '哟，来了。');
  assert.equal(events[2].senderName, '星☯辰');
  assert.equal(events[2].text, '在吗');
  // cursor: nothing older than the last seq
  assert.equal(parseQqSession(lines, { sinceSeq: 3, kind: 'group' }).length, 0);
});

test('qqbot bridge: imports new lines once, labels owner vs member, refreshes the group star', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sm-qqbridge-'));
  try {
    const home = resolveSoulmateHome(join(dir, 'home'));
    await mkdir(home.rootDir, { recursive: true });
    await saveConfigAuto(home, { extensions: { imOwnerQq: OWNER } });

    const sessionsRoot = join(dir, 'sessions');
    const sessDir = join(sessionsRoot, 'ws-qqbot', 'session-abc');
    await mkdir(sessDir, { recursive: true });
    const rows = [
      { seq: 1, type: 'user/message', time: 1000, data: { content: [{ type: 'text', text: `[等风 (${OWNER})] 你好` }] } },
      { seq: 2, type: 'assistant/message', time: 2000, data: { message: { content: [{ type: 'text', text: '嗯，在。' }] } } },
      { seq: 3, type: 'user/message', time: 3000, data: { content: [{ type: 'text', text: `[星☯辰 (${MEMBER})] 今天天气咋样` }] } },
    ];
    await writeFile(join(sessDir, 'session.v4.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')));

    const prefsPath = join(dir, 'prefs.json');
    await writeFile(prefsPath, JSON.stringify({ sessionIds: { [`qqbot:1900000001:group:${GROUP}`]: 'session-abc' } }));

    const rt = createQqbotBridgeRuntime({ home, warn: () => {}, pushEvent: () => 0, prefsPath, sessionsRoot });
    const first = await rt.runQqbotBridgeIfEnabled();
    assert.equal(first.ran, true);
    assert.equal(first.imported, 3, JSON.stringify(first));

    const chatPath = join(home.logsDir, 'im-chat.jsonl');
    const chat = (await readFile(chatPath, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(chat.length, 3);
    assert.equal(chat[0].peerLabel, '主人');
    assert.equal(chat[0].groupId, GROUP);
    assert.equal(chat[2].peerLabel, '星☯辰');
    assert.equal(chat[1].role, 'bot');

    const eps = await readdir(join(home.memoryDir, 'episodes')).catch(() => []);
    const imFile = eps.find((n) => n.includes('im'));
    assert.ok(imFile, 'group memory star file written');

    // Second pass is a no-op thanks to the cursor.
    const second = await rt.runQqbotBridgeIfEnabled();
    assert.equal(second.imported, 0);
    const chat2 = (await readFile(chatPath, 'utf8')).split('\n').filter(Boolean);
    assert.equal(chat2.length, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('qqbot bridge: latestInboundIds respects the passive window (group 5min / c2c 30min)', async () => {
  const { latestInboundIds } = await import('../packages/soulmate-core/runtime/qqbot-bridge-runtime.mjs');
  const now = Date.parse('2026-11-24T08:00:00Z');
  const lines = [
    { seq: 1, type: 'user/message', time: now - 40 * 60_000, data: { id: 'old', content: [{ type: 'text', text: '旧消息' }] } },
    { seq: 2, type: 'user/message', time: now - 4 * 60_000, data: { id: 'fresh', content: [{ type: 'text', text: '[等风 (A1B2C3D4E5F60718293A4B5C6D7E8F90)] 在吗' }] } },
    { seq: 3, type: 'user/message', time: now - 3 * 60_000, data: { id: 'sys', content: [{ type: 'text', text: 'Time sampled while preparing turn 2' }] } },
    { seq: 4, type: 'assistant/message', time: now - 2 * 60_000, data: { message: { content: [{ type: 'text', text: '在' }] } } },
  ];
  const g = latestInboundIds(lines, { kind: 'group', nowMs: now });
  assert.equal(g.msgId, 'fresh');
  assert.equal(g.fresh, true);
  const c = latestInboundIds(lines, { kind: 'c2c', nowMs: now });
  assert.equal(c.fresh, true);
  // 6 minutes later: group window closed, c2c still open
  const later = now + 2 * 60_000;
  assert.equal(latestInboundIds(lines, { kind: 'group', nowMs: later }).fresh, false);
  assert.equal(latestInboundIds(lines, { kind: 'c2c', nowMs: later }).fresh, true);
  // nothing inbound at all
  assert.equal(latestInboundIds([], { kind: 'group', nowMs: now }), null);
});

test('official sender: closed window is an honest failure; absent creds fall back to soulmate-im', async () => {
  const { createOfficialQqSender } = await import('../packages/soulmate-core/runtime/qq-official-send.mjs');
  const closed = createOfficialQqSender({
    bridge: { officialSendTargets: async () => ({ ok: true, creds: { appId: '1', appSecret: 's' }, targets: [] }) },
    cfg: {}, warn: () => {},
  });
  const res = await closed({ target: { platform: 'qq', to: 'u1', groupId: '' }, text: 'hi' });
  assert.equal(res.ok, false);
  assert.match(res.error, /被动窗口/);
  assert.ok(!res.trySoulmateIm, 'configured channel must not silently reroute');

  const absent = createOfficialQqSender({
    bridge: { officialSendTargets: async () => ({ ok: false, reason: 'no-official-creds', targets: [] }) },
    cfg: {}, warn: () => {},
  });
  const res2 = await absent({ target: { platform: 'qq', to: 'u1' }, text: 'hi' });
  assert.equal(res2.trySoulmateIm, true);
});

test('official sender: fresh window posts with REAL msg_id from the SDK mirror', async () => {
  const { createOfficialQqSender } = await import('../packages/soulmate-core/runtime/qq-official-send.mjs');
  const { setQqMsgIdStore } = await import('../packages/soulmate-core/qqbot-msgid-mirror.mjs');
  const { mkdtemp, rm, writeFile, mkdir } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const dir = await mkdtemp(join(tmpdir(), 'sm-msgid-'));
  const store = join(dir, 'qq-msgids.json');
  setQqMsgIdStore(store);
  await mkdir(dir, { recursive: true });
  await writeFile(store, JSON.stringify({ targets: { 'group:G1': [{ msgId: 'REAL-QQ-ID', at: Date.now() }] } }));
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (String(url).includes('getAppAccessToken')) {
      return { status: 200, text: async () => JSON.stringify({ access_token: 'TOK', expires_in: 7200 }) };
    }
    return { status: 200, text: async () => JSON.stringify({ id: 'MSG-1', timestamp: 1 }) };
  };
  const send = createOfficialQqSender({
    bridge: { officialSendTargets: async () => ({ ok: true, creds: { appId: '190', appSecret: 'sec' }, targets: [{ kind: 'group', groupId: 'G1', peer: 'G1', appId: '190', msgId: 'IN-1', ageMs: 1000 }] }) },
    cfg: { fetch: fetchImpl }, warn: () => {},
  });
  try {
    const res = await send({ target: { platform: 'qq', to: 'G1', groupId: 'G1' }, text: '群里主动一句' });
    assert.equal(res.ok, true);
    assert.equal(res.mode, 'official-bridge');
    const post = calls.find((c) => String(c.url).includes('/v2/groups/G1/messages'));
    assert.ok(post, 'group endpoint hit');
    const body = JSON.parse(post.init.body);
    assert.equal(body.msg_id, 'REAL-QQ-ID', 'must use the real QQ id, not the DSH-internal one');
    assert.equal(body.content, '群里主动一句');
    assert.equal(post.init.headers.Authorization, 'QQBot TOK');
  } finally {
    setQqMsgIdStore(null);
    await rm(dir, { recursive: true, force: true });
  }
});
