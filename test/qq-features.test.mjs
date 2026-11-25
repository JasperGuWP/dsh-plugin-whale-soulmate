// New official-QQ capability surface: live inbound mirror, media/recall/typing/wakeup/
// buttons/stream ops, lifecycle+interaction journals, vision descriptions, and the
// bridge's live-source import path. All network I/O is injectable; no real endpoints.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import zlib from 'node:zlib';
import { resolveSoulmateHome, saveConfigAuto } from '../packages/soulmate-core/state.mjs';
import {
  setQqInboundStore, recordQqInbound, readQqInboundSince, recordQqLifecycle,
  recordQqInteraction, installQqInboundMirror, installQqBotEventMirror, normalizeAttachments,
} from '../packages/soulmate-core/qqbot-inbound-mirror.mjs';
import { mirrorRowToImEntry, importLiveQqInbound } from '../packages/soulmate-core/runtime/qqbot-live-source.mjs';
import { describeAttachments, runQqVisionIfEnabled, readQqVisionDescriptions } from '../packages/soulmate-core/runtime/qq-vision-runtime.mjs';
import { createOfficialQqOps } from '../packages/soulmate-core/runtime/qq-official-ops.mjs';
import { createOfficialQqStream } from '../packages/soulmate-core/runtime/qq-official-stream.mjs';
import { createOfficialQqSender } from '../packages/soulmate-core/runtime/qq-official-send.mjs';
import { setQqMsgIdStore } from '../packages/soulmate-core/qqbot-msgid-mirror.mjs';
import { createQqbotBridgeRuntime, parseQqSession } from '../packages/soulmate-core/runtime/qqbot-bridge-runtime.mjs';
import { appendImChat, listImChat } from '../packages/soulmate-core/im-chat.mjs';

const OWNER = 'A1B2C3D4E5F60718293A4B5C6D7E8F90';
const GROUP = 'F0E1D2C3B4A5968778695A4B3C2D1E0F';

async function tmp() {
  const dir = await mkdtemp(join(tmpdir(), 'sm-qqfeat-'));
  setQqInboundStore(dir);
  const store = join(dir, 'qq-msgids.json');
  setQqMsgIdStore(store);
  return { dir, store };
}

async function cleanup(dir) {
  setQqInboundStore(null);
  setQqMsgIdStore(null);
  await rm(dir, { recursive: true, force: true });
}

const okFetch = (calls, body = { id: 'MSG-1' }) => async (url, init) => {
  calls.push({ url: String(url), init });
  if (String(url).includes('getAppAccessToken')) {
    return { status: 200, text: async () => JSON.stringify({ access_token: 'TOK', expires_in: 7200 }) };
  }
  return { status: 200, text: async () => JSON.stringify(body) };
};

const bridgeWith = (targets = []) => ({
  officialSendTargets: async () => ({ ok: true, creds: { appId: '190', appSecret: 'sec' }, targets }),
});

async function freshWindow(store, key) {
  await writeFile(store, JSON.stringify({ targets: { [key]: [{ msgId: 'REAL-1', at: Date.now() }] } }));
}

// ---------------------------------------------------------------------------
// 1. inbound mirror
// ---------------------------------------------------------------------------

test('inbound mirror: records full rows (attachments/nicknames), reads incrementally, dedups by cursor', async () => {
  const { dir } = await tmp();
  try {
    const raw = {
      kind: 'group', groupOpenid: GROUP, senderId: OWNER, senderName: '等风',
      messageId: 'QQ-MSG-1', content: '看看这张图', timestamp: new Date().toISOString(),
      attachments: [{ content_type: 'image/png', url: 'https://example.com/a.png', width: 100, height: 80 }],
    };
    const row = await recordQqInbound(raw);
    assert.equal(row.targetId, GROUP);
    assert.equal(row.attachments[0].contentType, 'image/png');
    const rows = await readQqInboundSince('');
    assert.equal(rows.length, 1);
    // cursor at/after receivedAt → nothing new
    assert.equal((await readQqInboundSince(rows[0].receivedAt)).length, 0);
    // non-message kinds are ignored
    assert.equal(await recordQqInbound({ kind: 'guild', messageId: 'x', senderId: 'y' }), null);
    assert.deepEqual(normalizeAttachments([{ content_type: 'voice', url: 'u', asr_refer_text: '你好' }])[0].asrText, '你好');
  } finally { await cleanup(dir); }
});

test('inbound mirror: prototype wrap records then calls through; dispose restores', async () => {
  const { dir } = await tmp();
  try {
    let called = 0;
    class FakeBot {
      async handleInboundMessage(raw) { called += 1; return raw; }
    }
    const dispose = installQqInboundMirror({}, FakeBot);
    const bot = new FakeBot();
    await bot.handleInboundMessage({ kind: 'c2c', senderId: OWNER, messageId: 'M1', content: 'hi', timestamp: new Date().toISOString() });
    assert.equal(called, 1);
    assert.equal((await readQqInboundSince('')).length, 1);
    dispose();
    await bot.handleInboundMessage({ kind: 'c2c', senderId: OWNER, messageId: 'M2', content: 'again' });
    assert.equal(called, 2);
    assert.equal((await readQqInboundSince('')).length, 1, 'after dispose nothing more is mirrored');
  } finally { await cleanup(dir); }
});

test('event mirror: lifecycle + interaction listeners attach on start and journal events', async () => {
  const { dir } = await tmp();
  try {
    class FakeBot {
      constructor() { this.handlers = {}; }
      on(ev, fn) { (this.handlers[ev] ||= []).push(fn); return this; }
      async start() {
        for (const fn of this.handlers.rawEvent || []) fn({ eventType: 'GROUP_ADD_ROBOT', data: { group_openid: GROUP, op_member_openid: OWNER } });
        for (const fn of this.handlers.interaction || []) fn({ event: { id: 'I-1', data: { resolved: { button_id: 'b', button_data: 'yes' } }, group_openid: GROUP } });
      }
    }
    const dispose = installQqBotEventMirror({}, FakeBot);
    await new FakeBot().start();
    await new Promise((r) => setTimeout(r, 20));
    const life = JSON.parse((await readFile(join(dir, 'qq-lifecycle.jsonl'), 'utf8')).trim());
    assert.equal(life.type, 'GROUP_ADD_ROBOT');
    assert.equal(life.groupOpenid, GROUP);
    const inter = JSON.parse((await readFile(join(dir, 'qq-interactions.jsonl'), 'utf8')).trim());
    assert.equal(inter.buttonData, 'yes');
    dispose();
  } finally { await cleanup(dir); }
});

// ---------------------------------------------------------------------------
// 2. live-source import into the bridge
// ---------------------------------------------------------------------------

test('live source: mirror rows land in im-chat with owner labels + media; transcript scan skips their real ids', async () => {
  const { dir } = await tmp();
  try {
    const home = resolveSoulmateHome(join(dir, 'home'));
    await mkdir(home.rootDir, { recursive: true });
    await saveConfigAuto(home, { extensions: { imOwnerQq: OWNER } });
    await recordQqInbound({
      kind: 'group', groupOpenid: GROUP, senderId: OWNER, senderName: '等风',
      messageId: 'REAL-9', content: '<@bot> 在吗 (@you)', timestamp: new Date().toISOString(),
      attachments: [{ content_type: 'image/jpeg', url: 'https://x/i.jpg' }],
    });
    const cursor = {};
    const res = await importLiveQqInbound(home, cursor, { ownerId: OWNER });
    assert.equal(res.imported, 1);
    const rows = await listImChat(home, { platform: 'qq', groupId: GROUP });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].peerLabel, '主人');
    assert.equal(rows[0].text, '在吗');
    assert.equal(rows[0].media[0].contentType, 'image/jpeg');
    assert.equal(rows[0].messageId, 'REAL-9');
    // second pass: cursor dedupe
    assert.equal((await importLiveQqInbound(home, cursor, { ownerId: OWNER })).imported, 0);
    // transcript scan must skip a user row whose data.id was already mirrored
    const lines = [{ seq: 5, type: 'user/message', time: Date.now(), data: { id: 'REAL-9', content: [{ type: 'text', text: `[等风 (${OWNER})] 在吗` }] } }];
    const { getSeenRealIds } = await import('../packages/soulmate-core/runtime/qqbot-live-source.mjs');
    assert.equal(parseQqSession(lines, { kind: 'group', skipRealIds: getSeenRealIds(cursor) }).length, 0);
    assert.equal(parseQqSession(lines, { kind: 'group' }).length, 1);
  } finally { await cleanup(dir); }
});

test('bridge: live mirror + transcript bot reply merge into one timeline and star', async () => {
  const { dir } = await tmp();
  try {
    const home = resolveSoulmateHome(join(dir, 'home'));
    await mkdir(home.rootDir, { recursive: true });
    await saveConfigAuto(home, { extensions: { imOwnerQq: OWNER } });
    const sessionsRoot = join(dir, 'sessions');
    const sessDir = join(sessionsRoot, 'ws-qqbot', 'session-live');
    await mkdir(sessDir, { recursive: true });
    const now = Date.now();
    const rows = [
      { seq: 1, type: 'user/message', time: now, data: { id: 'REAL-11', content: [{ type: 'text', text: `[等风 (${OWNER})] 早` }] } },
      { seq: 2, type: 'assistant/message', time: now + 1000, data: { message: { content: [{ type: 'text', text: '早呀。' }] } } },
    ];
    await writeFile(join(sessDir, 'session.v4.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(rows.map((r) => JSON.stringify(r)).join('\n') + '\n')));
    const prefsPath = join(dir, 'prefs.json');
    await writeFile(prefsPath, JSON.stringify({ sessionIds: { [`qqbot:190:group:${GROUP}`]: 'session-live' } }));
    await recordQqInbound({ kind: 'group', groupOpenid: GROUP, senderId: OWNER, senderName: '等风', messageId: 'REAL-11', content: '早', timestamp: new Date(now).toISOString() });
    const rt = createQqbotBridgeRuntime({ home, warn: () => {}, pushEvent: () => 0, prefsPath, sessionsRoot });
    const res = await rt.runQqbotBridgeIfEnabled();
    assert.equal(res.imported, 2, JSON.stringify(res));
    const chat = await listImChat(home, { platform: 'qq', groupId: GROUP, limit: 10 });
    assert.equal(chat.length, 2, 'user line imported ONCE (live), bot reply from transcript');
    assert.equal(chat.filter((r) => r.role === 'user').length, 1);
  } finally { await cleanup(dir); }
});

// ---------------------------------------------------------------------------
// 3. vision descriptions
// ---------------------------------------------------------------------------

test('qq vision: attachment text rendering + describe pass journals once per url', async () => {
  const { dir } = await tmp();
  try {
    const home = resolveSoulmateHome(join(dir, 'home'));
    await mkdir(home.rootDir, { recursive: true });
    await saveConfigAuto(home, {});
    assert.equal(describeAttachments([{ contentType: 'image/png', url: 'u1' }]), '[图片]');
    assert.equal(describeAttachments([{ contentType: 'image/png', url: 'u1' }], { descriptions: { u1: '一只猫' } }), '[图片] 一只猫');
    assert.equal(describeAttachments([{ contentType: 'voice', asrText: '在吗' }]), '[语音] 在吗');
    await appendImChat(home, {
      platform: 'qq', peerId: OWNER, role: 'user', text: '',
      media: [{ contentType: 'image/png', url: 'https://x/cat.png' }],
    });
    let calls = 0;
    const describe = async () => { calls += 1; return { text: '一只橘猫趴在窗台' }; };
    const r1 = await runQqVisionIfEnabled({ home, warn: () => {}, describe });
    assert.equal(r1.described, 1);
    const r2 = await runQqVisionIfEnabled({ home, warn: () => {}, describe });
    assert.equal(r2.described, 0, 'already-described url is not retried');
    assert.equal(calls, 1);
    const map = await readQqVisionDescriptions(home);
    assert.equal(map['https://x/cat.png'], '一只橘猫趴在窗台');
    // disabled switch short-circuits
    await saveConfigAuto(home, { extensions: { qqVisionEnabled: false } });
    assert.equal((await runQqVisionIfEnabled({ home, warn: () => {}, describe })).reason, 'disabled');
  } finally { await cleanup(dir); }
});

// ---------------------------------------------------------------------------
// 4. official ops: media / recall / typing / wakeup / buttons
// ---------------------------------------------------------------------------

test('official ops: media uploads then sends msg_type 7 with real window id; closed window refuses', async () => {
  const { dir, store } = await tmp();
  try {
    const calls = [];
    const ops = createOfficialQqOps({
      bridge: bridgeWith(), cfg: { fetch: okFetch(calls, { file_info: 'FI-1', id: 'MEDIA-1' }) }, warn: () => {},
      outboundRecord: async () => {},
    });
    const closed = await ops.sendMedia({ target: { to: OWNER }, mediaType: 'image', url: 'https://x/a.png' });
    assert.equal(closed.ok, false);
    assert.match(closed.error, /被动窗口/);
    await freshWindow(store, `c2c:${OWNER}`);
    const res = await ops.sendMedia({ target: { to: OWNER }, mediaType: 'image', url: 'https://x/a.png', caption: '给你看' });
    assert.equal(res.ok, true, JSON.stringify(res));
    const upload = calls.find((c) => c.url.includes('/files'));
    assert.equal(JSON.parse(upload.init.body).file_type, 1);
    assert.equal(JSON.parse(upload.init.body).url, 'https://x/a.png');
    const send = calls.find((c) => c.url.includes('/messages'));
    const body = JSON.parse(send.init.body);
    assert.equal(body.msg_type, 7);
    assert.equal(body.media.file_info, 'FI-1');
    assert.equal(body.msg_id, 'REAL-1');
    assert.equal(body.content, '给你看');
  } finally { await cleanup(dir); }
});

test('official ops: wakeup posts is_wakeup without msg_id; recall DELETEs; typing uses msg_type 6; buttons carry keyboard', async () => {
  const { dir, store } = await tmp();
  try {
    const calls = [];
    const ops = createOfficialQqOps({ bridge: bridgeWith(), cfg: { fetch: okFetch(calls) }, warn: () => {}, outboundRecord: async () => {} });
    const w = await ops.wakeup({ to: OWNER, text: '想你了' });
    assert.equal(w.ok, true, JSON.stringify(w));
    const wCall = calls.find((c) => c.url.includes('/messages'));
    const wBody = JSON.parse(wCall.init.body);
    assert.equal(wBody.is_wakeup, true);
    assert.equal(wBody.msg_id, undefined, 'wakeup needs NO msg_id');

    const r = await ops.recall({ target: { to: OWNER }, messageId: 'MSG-9' });
    assert.equal(r.ok, true);
    const del = calls.find((c) => c.init.method === 'DELETE');
    assert.ok(del.url.endsWith('/messages/MSG-9'));

    await freshWindow(store, `c2c:${OWNER}`);
    const t = await ops.typing({ to: OWNER });
    assert.equal(t.ok, true);
    const tBody = JSON.parse(calls.filter((c) => c.url.includes('/messages') && c.init.method !== 'DELETE').pop().init.body);
    assert.equal(tBody.msg_type, 6);
    assert.equal(tBody.input_notify.input_type, 1);

    const b = await ops.sendButtons({ target: { to: OWNER }, text: '选一个', buttons: [{ label: '好', data: 'yes' }, { label: '不好', data: 'no' }] });
    assert.equal(b.ok, true, JSON.stringify(b));
    const bBody = JSON.parse(calls.filter((c) => c.url.includes('/messages') && c.init.method !== 'DELETE').pop().init.body);
    assert.equal(bBody.keyboard.content.rows[0].buttons.length, 2);
    assert.equal(bBody.keyboard.content.rows[0].buttons[0].action.data, 'yes');

    const ack = await ops.ackInteraction({ interactionId: 'I-1' });
    assert.equal(ack.ok, true);
    const ackCall = calls.find((c) => c.url.includes('/interactions/I-1'));
    assert.equal(ackCall.init.method, 'PUT');
  } finally { await cleanup(dir); }
});

test('official sender: firewall blocks secrets; closed window falls back to the active-message quota', async () => {
  const { dir, store } = await tmp();
  try {
    const calls = [];
    const ops = createOfficialQqOps({ bridge: bridgeWith(), cfg: { fetch: okFetch(calls) }, warn: () => {}, outboundRecord: async () => {} });
    const send = createOfficialQqSender({ bridge: bridgeWith(), cfg: { fetch: okFetch(calls) }, warn: () => {}, ops, outboundRecord: async () => {} });
    // closed c2c window → wakeup recall first (no msg_id, is_wakeup true)
    const res = await send({ target: { platform: 'qq', to: OWNER, groupId: '' }, text: '半天没说话了，冒个泡' });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.mode, 'official-wakeup');
    const body = JSON.parse(calls.find((c) => c.url.includes('/messages')).init.body);
    assert.equal(body.is_wakeup, true);
    // closed GROUP window → active push (no msg_id, no is_wakeup), platform daily quota
    const g = await send({ target: { platform: 'qq', to: GROUP, groupId: GROUP }, text: 'hi' });
    assert.equal(g.ok, true, JSON.stringify(g));
    assert.equal(g.mode, 'official-active');
    const gBody = JSON.parse(calls.filter((c) => c.url.includes('/messages')).pop().init.body);
    assert.equal(gBody.msg_id, undefined, 'active push needs NO msg_id');
    assert.equal(gBody.is_wakeup, undefined);
    assert.ok(Number.isFinite(gBody.msg_seq));
    // secret text is refused before any network call
    const before = calls.length;
    const blocked = await send({ target: { platform: 'qq', to: OWNER }, text: '我的密码是 sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ' });
    assert.equal(blocked.ok, false);
    assert.ok(blocked.blockedReason || /防火墙/.test(blocked.error || ''));
    assert.equal(calls.length, before, 'firewall refusal must not hit the network');
  } finally { await cleanup(dir); }
});

test('official sender: wakeup quota refusal falls through to active push; both failing is honest', async () => {
  const { dir } = await tmp();
  try {
    // wakeup → 400 quota; the follow-up id-less active post succeeds.
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).includes('getAppAccessToken')) {
        return { status: 200, text: async () => JSON.stringify({ access_token: 'TOK', expires_in: 7200 }) };
      }
      const body = JSON.parse(init.body || '{}');
      if (body.is_wakeup) {
        return { status: 400, text: async () => JSON.stringify({ message: '消息发送失败，召回消息已达区间上限' }) };
      }
      return { status: 200, text: async () => JSON.stringify({ id: 'ACTIVE-1' }) };
    };
    const ops = createOfficialQqOps({ bridge: bridgeWith(), cfg: { fetch: fetchImpl }, warn: () => {}, outboundRecord: async () => {} });
    const send = createOfficialQqSender({ bridge: bridgeWith(), cfg: { fetch: fetchImpl }, warn: () => {}, ops, outboundRecord: async () => {} });
    const r = await send({ target: { platform: 'qq', to: OWNER, groupId: '' }, text: '召回额度没了也要说话' });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.mode, 'official-active');
    // both paths refused → honest combined error, no fake success
    const deadFetch = async (url, init) => {
      if (String(url).includes('getAppAccessToken')) {
        return { status: 200, text: async () => JSON.stringify({ access_token: 'TOK', expires_in: 7200 }) };
      }
      return { status: 400, text: async () => JSON.stringify({ message: '主动消息超过每日上限' }) };
    };
    const ops2 = createOfficialQqOps({ bridge: bridgeWith(), cfg: { fetch: deadFetch }, warn: () => {}, outboundRecord: async () => {} });
    const send2 = createOfficialQqSender({ bridge: bridgeWith(), cfg: { fetch: deadFetch }, warn: () => {}, ops: ops2, outboundRecord: async () => {} });
    const dead = await send2({ target: { platform: 'qq', to: OWNER, groupId: '' }, text: 'hi' });
    assert.equal(dead.ok, false);
    assert.match(dead.error, /wakeup 召回失败/);
    assert.match(dead.error, /主动消息也失败/);
  } finally { await cleanup(dir); }
});

// ---------------------------------------------------------------------------
// 5. stream
// ---------------------------------------------------------------------------

test('official stream: replace frames share msg_seq, index advances, DONE frame completes', async () => {
  const { dir, store } = await tmp();
  try {
    await freshWindow(store, `c2c:${OWNER}`);
    const calls = [];
    const stream = createOfficialQqStream({
      bridge: bridgeWith(), cfg: { fetch: okFetch(calls, { id: 'STREAM-1' }) }, warn: () => {}, outboundRecord: async () => {},
    });
    const res = await stream.streamText({ to: OWNER, text: '一二三四五六七八九十'.repeat(6), chunkChars: 10 });
    assert.equal(res.ok, true, JSON.stringify(res));
    const frames = calls.filter((c) => c.url.includes('/stream_messages')).map((c) => JSON.parse(c.init.body));
    assert.ok(frames.length >= 2);
    assert.equal(frames[0].input_mode, 'replace');
    assert.equal(frames[0].msg_id, 'REAL-1');
    assert.equal(frames[frames.length - 1].input_state, 10, 'last frame is DONE');
    assert.ok(frames.every((f) => f.msg_seq === frames[0].msg_seq), 'one msg_seq per stream');
    assert.ok(frames.every((f, i) => f.index === i), 'index advances 0..n');
    assert.ok(frames[frames.length - 1].content_raw.length >= frames[0].content_raw.length, 'replace semantics: full text grows');
    // closed window → honest failure
    await writeFile(store, JSON.stringify({ targets: {} }));
    const closed = await stream.openStream({ to: OWNER });
    assert.equal(closed.ok, false);
  } finally { await cleanup(dir); }
});

// ---------------------------------------------------------------------------
// 6. tools surface
// ---------------------------------------------------------------------------

test('qq tools: 7 tools registered; events tool reads journals and window state', async () => {
  const { dir, store } = await tmp();
  try {
    const home = resolveSoulmateHome(join(dir, 'home'));
    await mkdir(home.rootDir, { recursive: true });
    await saveConfigAuto(home, { extensions: { imOwnerQq: OWNER } });
    const { qqTools } = await import('../packages/soulmate-core/tools/qq-tools.mjs');
    const makeTool = (def) => def;
    const ops = createOfficialQqOps({ bridge: bridgeWith(), cfg: { fetch: okFetch([]) }, warn: () => {}, outboundRecord: async () => {} });
    const { tools } = qqTools({ makeTool, home, pushEvent: () => 0, qqOps: ops });
    assert.equal(tools.length, 7);
    const names = tools.map((t) => t.name);
    for (const n of ['soulmate_qq_send_media', 'soulmate_qq_recall', 'soulmate_qq_typing', 'soulmate_qq_wakeup', 'soulmate_qq_buttons', 'soulmate_qq_stream', 'soulmate_qq_events']) {
      assert.ok(names.includes(n), n);
    }
    await recordQqLifecycle('FRIEND_ADD', { openid: OWNER });
    await freshWindow(store, `c2c:${OWNER}`);
    const events = tools.find((t) => t.name === 'soulmate_qq_events');
    const out = await events.run({ kind: 'all' });
    assert.equal(out.ok, true);
    assert.equal(out.lifecycle[0].type, 'FRIEND_ADD');
    assert.equal(out.window.open, true);
    assert.equal(out.window.targetId, OWNER, 'defaults to the owner openid');
    // no ops → honest error, never a fake success
    const bare = qqTools({ makeTool, home, pushEvent: () => 0, qqOps: null });
    const res = await bare.tools.find((t) => t.name === 'soulmate_qq_wakeup').run({ text: 'hi' });
    assert.equal(res.ok, false);
  } finally { await cleanup(dir); }
});
// ---------------------------------------------------------------------------
// 7. QR encoder: CJS interop must survive the host loader (createRequire path)
// ---------------------------------------------------------------------------

test('qr-encode: data URL and SVG both render; bili/weixin wrappers share the core', async () => {
  const { encodeQrDataUrl, encodeQrSvgString } = await import('../packages/soulmate-core/qr-encode.mjs');
  const png = await encodeQrDataUrl('https://example.com/qr');
  assert.ok(png.startsWith('data:image/png;base64,'));
  const svg = await encodeQrSvgString('https://example.com/qr');
  assert.ok(svg.trimStart().startsWith('<svg'));
  const bili = await import('../packages/soulmate-bili/auth/qr-svg.mjs');
  assert.ok((await bili.encodeQrDataUrl('x')).startsWith('data:image/png;base64,'));
  assert.ok((await bili.encodeQrSvg('x')).svg.startsWith('<svg'));
});

test('qq vision: foreign-referer fix — qq purpose fetches without bili referer; transient failure retried once', async () => {
  const { materializeVisionImages } = await import('../packages/soulmate-bili/vision-summary.mjs');
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push(init?.headers || {});
    const hasBiliRef = Boolean(init?.headers?.referer);
    if (hasBiliRef) return { ok: false, status: 400, headers: { get: () => 'application/json' }, arrayBuffer: async () => new ArrayBuffer(0) };
    const bytes = Buffer.from('GIF89a pixels');
    return { ok: true, status: 200, headers: { get: () => 'image/gif' }, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
  };
  const out = await materializeVisionImages([{ url: 'https://multimedia.nt.qq.com.cn/x' }], { fetchImpl, referer: '' });
  assert.equal(out.length, 1);
  assert.ok(out[0].url.startsWith('data:image/gif;base64,'));
  assert.ok(!seen[0].referer, 'qq fetch must carry NO bili referer');
  // default (bili) still sends its referer
  await materializeVisionImages([{ url: 'https://i0.hdslb.com/x.jpg' }], { fetchImpl }).catch(() => {});
  assert.equal(seen[1].referer, 'https://www.bilibili.com');

  // one retry for transient failures, then stop
  const { dir } = await tmp();
  try {
    const home = resolveSoulmateHome(join(dir, 'home'));
    await mkdir(home.rootDir, { recursive: true });
    await saveConfigAuto(home, {});
    await appendImChat(home, { platform: 'qq', peerId: OWNER, role: 'user', text: '', media: [{ contentType: 'image/gif', url: 'https://x/retry.gif' }] });
    let calls = 0;
    const failing = async () => { calls += 1; throw new Error('no-images'); };
    await runQqVisionIfEnabled({ home, warn: () => {}, describe: failing });
    await runQqVisionIfEnabled({ home, warn: () => {}, describe: failing });
    const third = await runQqVisionIfEnabled({ home, warn: () => {}, describe: failing });
    assert.equal(calls, 2, 'failed url retried exactly once');
    assert.equal(third.described, 0);
  } finally { await cleanup(dir); }
});
