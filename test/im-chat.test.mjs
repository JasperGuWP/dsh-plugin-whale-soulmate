import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendImChat, listImChat, listImContacts, recentImBotSend } from '../packages/soulmate-core/im-chat.mjs';
import { composeImPersonaPrompt, extractImReplyText } from '../packages/soulmate-core/im-reply.mjs';

test('im-chat: append + contacts + peer timeline paging', async () => {
  const root = await mkdtemp(join(tmpdir(), 'soulmate-im-chat-'));
  const home = { rootDir: root, logsDir: root };
  try {
    await appendImChat(home, { platform: 'weixin', peerId: 'a@im.wechat', peerLabel: '甲', role: 'user', text: '你好', at: '2026-11-16T01:00:00.000Z' });
    await appendImChat(home, { platform: 'weixin', peerId: 'a@im.wechat', peerLabel: '甲', role: 'bot', text: '嗯，在呢', at: '2026-11-16T01:00:01.000Z' });
    await appendImChat(home, { platform: 'weixin', peerId: 'b@im.wechat', peerLabel: '乙', role: 'user', text: '嗨', at: '2026-11-16T02:00:00.000Z' });

    const contacts = await listImContacts(home, { platform: 'weixin' });
    assert.equal(contacts[0].peerId, 'b@im.wechat');
    assert.equal(contacts.find((c) => c.peerId === 'a@im.wechat').count, 2);

    const newest = await listImChat(home, { platform: 'weixin', peerId: 'a@im.wechat', limit: 1 });
    assert.equal(newest.length, 1);
    assert.equal(newest[0].text, '嗯，在呢');

    const older = await listImChat(home, {
      platform: 'weixin',
      peerId: 'a@im.wechat',
      limit: 10,
      before: '2026-11-16T01:00:01.000Z',
    });
    assert.equal(older.length, 1);
    assert.equal(older[0].text, '你好');

    const recent = await recentImBotSend(home, { platform: 'weixin', peerId: 'a@im.wechat', withinMs: 86_400_000_000 });
    assert.equal(recent.text, '嗯，在呢');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('im-reply: persona prompt asks for in-character speech, extract text', () => {
  const prompt = composeImPersonaPrompt({
    persona: { name: '大海', callUser: '主人', selfRef: '本鱼', traits: { tsundere: 80, clinginess: 60, sassiness: 65, curiosity: 70, brevity: 65 } },
    state: { mood: 'happy' },
    text: '你在干嘛',
    memories: { facts: [{ topic: '独立开发', content: '喜欢小而美' }], wiki: [] },
    platform: 'weixin',
    trusted: true,
  });
  assert.match(prompt, /大海/);
  assert.match(prompt, /主人/);
  assert.match(prompt, /本鱼/);
  assert.match(prompt, /你在干嘛/);
  assert.match(prompt, /你说的「…」我收到了/);
  assert.match(prompt, /只输出一段话/);
  assert.equal(extractImReplyText({ text: ' 嗨～ ' }), '嗨～');
  assert.equal(extractImReplyText('直接字符串'), '直接字符串');
  assert.equal(extractImReplyText({ choices: [{ message: { content: '嵌套回复' } }] }), '嵌套回复');
  assert.equal(extractImReplyText({ content: [{ type: 'text', text: '块' }, { type: 'text', text: '拼接' }] }), '块拼接');
});
