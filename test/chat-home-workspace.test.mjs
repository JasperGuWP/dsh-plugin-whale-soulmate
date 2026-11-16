import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createChatHomeWorkspace } from '../packages/soulmate-core/runtime/chat-home-workspace.mjs';
import { resolveSoulmateHome, saveConfigAuto } from '../packages/soulmate-core/state.mjs';

function mockRegistry(seed = []) {
  const workspaces = seed.map((w) => ({
    ...w,
    sessionIds: [...(w.sessionIds || [])],
    async setTitle(title) { this.title = title; },
    async attachSession(sessionId) {
      if (!this.sessionIds.includes(sessionId)) this.sessionIds.unshift(sessionId);
    },
  }));
  return {
    list: () => workspaces,
    async create(path, title) {
      const ws = {
        id: `ws-${workspaces.length + 1}`,
        path,
        title: title || 'untitled',
        sessionIds: [],
        async setTitle(t) { this.title = t; },
        async attachSession(sessionId) {
          if (!this.sessionIds.includes(sessionId)) this.sessionIds.unshift(sessionId);
        },
      };
      workspaces.unshift(ws);
      return ws;
    },
  };
}

test('chat-home workspace: creates「人设名消息」and attaches known sessions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sm-ws-'));
  try {
    const home = resolveSoulmateHome(dir);
    await saveConfigAuto(home, { persona: { name: '大海' } });
    const events = [];
    const reg = mockRegistry([]);
    const { ensureChatHomeWorkspace, attachSessionsToChatHome, resolveChatHomeCreateRequest } =
      createChatHomeWorkspace({
        home,
        ctx: { get: (k) => (k === 'workspaceRegistry' ? reg : undefined) },
        pushEvent: (type, extra) => events.push({ type, ...extra }),
      });

    const ensured = await ensureChatHomeWorkspace();
    assert.ok(ensured?.workspaceId);
    assert.equal(ensured.title, '大海消息');
    assert.match(ensured.pluginDir, /plugin-sessions$/i);
    assert.equal(ensured.workspace.title, '大海消息');

    const createReq = await resolveChatHomeCreateRequest();
    assert.equal(createReq.workspaceId, ensured.workspaceId);

    const res = await attachSessionsToChatHome(['s-1', 's-2', 's-1']);
    assert.deepEqual(res.attached.sort(), ['s-1', 's-2']);
    assert.deepEqual(ensured.workspace.sessionIds.slice().sort(), ['s-1', 's-2']);

    const again = await attachSessionsToChatHome(['s-1']);
    assert.deepEqual(again.attached, []);
    assert.deepEqual(again.skipped, ['s-1']);
    assert.ok(events.some((e) => e.type === 'chat-home-workspace-attach'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('chat-home workspace: never falls back to an unrelated project workspace', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sm-ws-nofallback-'));
  try {
    const home = resolveSoulmateHome(dir);
    await saveConfigAuto(home, { persona: { name: '大海' } });
    const agentWs = {
      id: 'agent-ws',
      path: 'D:\\agent',
      title: 'agent',
      sessionIds: [],
      async setTitle() {},
      async attachSession() { throw new Error('should not attach here'); },
    };
    // Registry that can list but cannot create → must return {} / null, not agent-ws.
    const reg = {
      list: () => [agentWs],
      defaultWorkspaceId: 'agent-ws',
      // no create
    };
    const { resolveChatHomeCreateRequest, ensureChatHomeWorkspace } = createChatHomeWorkspace({
      home,
      ctx: { get: (k) => (k === 'workspaceRegistry' ? reg : undefined) },
      pushEvent: () => {},
    });
    assert.equal(await ensureChatHomeWorkspace(), null);
    assert.deepEqual(await resolveChatHomeCreateRequest(), {});
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('chat-home workspace: renames legacy「插件消息」and attaches into it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sm-ws-legacy-'));
  try {
    const home = resolveSoulmateHome(dir);
    await saveConfigAuto(home, { persona: { name: '大海' } });
    const pluginDir = join(home.rootDir, 'plugin-sessions');
    const titles = [];
    const reg = mockRegistry([{
      id: 'legacy',
      path: pluginDir,
      title: '插件消息',
      sessionIds: [],
      async setTitle(t) { titles.push(t); this.title = t; },
    }]);
    // Replace setTitle on the seeded workspace (mockRegistry already wraps, but keep explicit).
    reg.list()[0].setTitle = async function setTitle(t) { titles.push(t); this.title = t; };

    const { attachSessionsToChatHome } = createChatHomeWorkspace({
      home,
      ctx: { get: (k) => (k === 'workspaceRegistry' ? reg : undefined) },
      pushEvent: () => {},
    });
    const res = await attachSessionsToChatHome(['s-old']);
    assert.deepEqual(res.attached, ['s-old']);
    assert.equal(reg.list()[0].title, '大海消息');
    assert.ok(titles.includes('大海消息'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
