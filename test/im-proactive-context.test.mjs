// IM proactive grounding (2026-11-25 group incident): every proactive line is authored
// from the REAL conversation context — group + owner DM + memory digest + today's real
// finds — and the send refreshes the same memory star the bridge writes. Autonomy stays
// high (new topics / free chat), fabrication of events does not.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cleanImRowText,
  renderImContextRows,
  composeImProactiveContext,
  refreshImMemoryStar,
} from '../packages/soulmate-core/runtime/im-proactive-context.mjs';
import { composeImProactivePrompt } from '../packages/soulmate-core/runtime/im-proactive-runtime.mjs';
import { personaVoiceBrief } from '../packages/soulmate-core/persona-voice.mjs';
import { resolveSoulmateHome, saveConfigAuto } from '../packages/soulmate-core/state.mjs';
import { appendImChat } from '../packages/soulmate-core/im-chat.mjs';
import { appendSurfLog } from '../packages/soulmate-core/surf-log.mjs';
import { readEpisodes } from '../packages/soulmate-core/memory-engine.mjs';

const AT = Date.parse('2026-11-25T08:00:00Z'); // 16:00 UTC+8
const OWNER = '7C1158ADDC8CA761069C552A933687A3';
const GROUP = '4A4029A7852330DD24F71399A4C7FEDE';

test('cleanImRowText: face XML and bare image paths become human-readable', () => {
  const b64 = Buffer.from(JSON.stringify({ text: '菜汪' }), 'utf8').toString('base64');
  assert.equal(cleanImRowText(`<faceType=1,faceId="317",ext="${b64}">`), '[表情:菜汪]');
  assert.equal(cleanImRowText('<faceType=6,faceId="0",ext="">'), '[表情]');
  assert.equal(cleanImRowText('- Image: C:/Users/x/media/a.gif\n\n【表情: 未知表情】\n[图片]'), '【表情: 未知表情】\n[图片]');
  assert.equal(cleanImRowText('正常一句话'), '正常一句话');
});

test('renderImContextRows: owner by openid, sender names for members, bot as 我, media joined', () => {
  const rows = [
    { at: '2026-11-25T07:52:41Z', role: 'user', senderId: OWNER, senderName: '等风', peerLabel: 'QQ群', text: '', media: [{ contentType: 'image/jpeg', url: 'u1' }] },
    { at: '2026-11-25T07:53:34Z', role: 'bot', text: '你这表情包库存有一拼' },
    { at: '2026-11-25T07:52:08Z', role: 'user', senderId: 'D4C2', senderName: '星☯辰', peerLabel: 'QQ群', text: '哈哈' },
  ];
  const out = renderImContextRows(rows, { ownerId: OWNER, nowMs: AT, vision: { u1: '一盘白灼虾和烧肉' }, isGroup: true });
  const lines = out.split('\n');
  assert.equal(lines.length, 3);
  assert.match(lines[0], /15:52 星☯辰：哈哈/);
  assert.match(lines[1], /15:52 等风：\[图片\] 一盘白灼虾和烧肉/);
  assert.match(lines[2], /15:53 我：你这表情包库存有一拼/);
  // Older-than-today lines carry MM-DD so yesterday never reads as fresh gossip.
  const old = renderImContextRows([{ at: '2026-11-23T09:37:43Z', role: 'user', text: '你好' }], { nowMs: AT });
  assert.match(old, /^11-23 17:37 /);
});

test('im prompt: grounded context blocks, autonomy preserved, fabrication and fake-at banned', () => {
  const prompt = composeImProactivePrompt({
    target: { platform: 'qq', to: GROUP, groupId: GROUP },
    angle: '',
    voice: '护短带刺',
    context: {
      recent: '15:53 我：起来，把虾剥了。',
      dm: '13:37 他：你下次什么时候主动发消息',
      memory: '# 他此刻记得\n- 偏好：叫我「你」',
      material: '看过的视频《装机翻车合集》：供电接反主板冒烟',
      lastActivity: '7 分钟前',
    },
    persona: { callUser: '你' },
    maxChars: 120,
    clock: '16:00',
  });
  assert.match(prompt, /会话近况/);
  assert.match(prompt, /起来，把虾剥了/);
  assert.match(prompt, /私聊近况/);
  assert.match(prompt, /不得复述私聊原话/);
  assert.match(prompt, /他此刻记得/); // memory now fed to groups too (user decision)
  assert.match(prompt, /真实见闻/);
  assert.match(prompt, /开个新话题/); // autonomy: new topics allowed
  assert.match(prompt, /保持你自己的个性/);
  assert.match(prompt, /不得编造发生过的事件/);
  assert.match(prompt, /假 at/);
  assert.match(prompt, /7 分钟前/);
  assert.match(prompt, /不发/);
});

test('im prompt: empty conversation says so honestly instead of inventing recent events', () => {
  const prompt = composeImProactivePrompt({
    target: { platform: 'qq', to: OWNER },
    context: { recent: '', dm: '', memory: '', material: '', lastActivity: '' },
    persona: {},
  });
  assert.match(prompt, /还没有任何聊天记录/);
  assert.match(prompt, /不得编造发生过的事件/);
});

test('persona voice: catchphrase examples are tone-only, never staged as real events', () => {
  const brief = personaVoiceBrief({ preset: 'dark-hunter' }, {});
  assert.match(brief, /口吻参考/);
  assert.match(brief, /只学语气/);
  assert.match(brief, /不是真事/);
});

test('proactive context + star: group and owner DM both fed, send refreshes one shared star', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sm-imctx-'));
  try {
    const home = resolveSoulmateHome(join(dir, 'home'));
    await mkdir(home.rootDir, { recursive: true });
    await saveConfigAuto(home, { extensions: { imOwnerQq: OWNER } });
    await appendImChat(home, { platform: 'qq', peerId: GROUP, groupId: GROUP, role: 'user', senderId: OWNER, senderName: '等风', text: '你好啊', at: '2026-11-25T07:52:08Z' });
    await appendImChat(home, { platform: 'qq', peerId: GROUP, groupId: GROUP, role: 'bot', text: '起来，把虾剥了。', at: '2026-11-25T07:53:23Z' });
    await appendImChat(home, { platform: 'qq', peerId: OWNER, role: 'user', senderId: OWNER, text: '你下次什么时候主动发消息', at: '2026-11-25T05:37:11Z' });
    await appendSurfLog(home, { videoId: 'BV1x', title: '装机翻车合集', summary: '供电接反主板冒烟', at: '2026-11-25T06:00:00Z' });

    const ctx = await composeImProactiveContext(home, {
      target: { platform: 'qq', to: GROUP, groupId: GROUP },
      ext: { imOwnerQq: OWNER },
      nowMs: AT,
      memory: '# 他此刻记得\n- 偏好：叫我「你」',
    });
    assert.match(ctx.recent, /等风：你好啊/);
    assert.match(ctx.recent, /我：起来，把虾剥了/);
    assert.match(ctx.dm, /你下次什么时候主动发消息/);
    assert.match(ctx.material, /装机翻车合集/);
    assert.match(ctx.memory, /他此刻记得/);
    assert.equal(ctx.lastActivity, '7 分钟前');

    // DM target: the DM thread is the recent block, no duplicate dm section.
    const dmCtx = await composeImProactiveContext(home, {
      target: { platform: 'qq', to: OWNER, groupId: '' },
      ext: { imOwnerQq: OWNER },
      nowMs: AT,
    });
    assert.match(dmCtx.recent, /你下次什么时候主动发消息/);
    assert.equal(dmCtx.dm, '');

    // Star refresh: one star per conversation, same id convention as the bridge.
    const star = await refreshImMemoryStar(home, { platform: 'qq', groupId: GROUP, label: '等风的群', ownerId: OWNER, nowMs: AT });
    assert.equal(star.ok, true, JSON.stringify(star));
    const eps = await readEpisodes(home, {});
    const imStar = eps.find((e) => e.sessionId === `im:group:qq:${GROUP}`);
    assert.ok(imStar, 'group star written');
    assert.match(imStar.body, /等风：你好啊/);
    assert.match(imStar.body, /我：起来，把虾剥了/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('im runtime end-to-end: authored prompt carries real group context, send lands in star', async () => {
  const { createImProactiveRuntime } = await import('../packages/soulmate-core/runtime/im-proactive-runtime.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'sm-imrt-'));
  try {
    const home = resolveSoulmateHome(join(dir, 'home'));
    await mkdir(home.rootDir, { recursive: true });
    await saveConfigAuto(home, {
      extensions: {
        imOwnerQq: OWNER,
        imProactiveEnabled: true,
        imProactiveMinGapMinutes: 1,
        imProactiveWhitelist: [{ platform: 'qq', to: '', groupId: GROUP, label: 'QQ群 · 等风的群' }],
      },
    });
    await appendImChat(home, { platform: 'qq', peerId: GROUP, groupId: GROUP, role: 'user', senderId: OWNER, senderName: '等风', text: '把虾剥了没', at: '2026-11-25T07:58:00Z' });
    let seenPrompt = '';
    const rt = createImProactiveRuntime({
      home, warn: () => {}, pushEvent: () => 0, cfg: {},
      usage: {
        meteredCall: async ({ call }) => ({ ok: true, out: await call() }),
        listHostModels: async () => [{ id: 'm1' }],
        oneShotLlm: async ({ prompt }) => { seenPrompt = prompt; return { text: '虾剥好了没？别光躺着。' }; },
      },
      officialSend: async () => ({ ok: true, messageId: 'ROBOT1.0_test' }),
      officialTargets: async () => ({ ok: true, targets: [{ kind: 'group', groupId: GROUP, peer: GROUP, appId: '1', msgId: 'X', ageMs: 1000 }] }),
    });
    const r = await rt.runImProactiveIfDue({ at: AT });
    assert.equal(r.sent, true, JSON.stringify(r));
    assert.match(seenPrompt, /把虾剥了没/);
    assert.match(seenPrompt, /不得编造发生过的事件/);
    const eps = await readEpisodes(home, {});
    const star = eps.find((e) => e.sessionId === `im:group:qq:${GROUP}`);
    assert.ok(star, 'proactive send refreshed the group star');
    assert.match(star.body, /虾剥好了没/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});