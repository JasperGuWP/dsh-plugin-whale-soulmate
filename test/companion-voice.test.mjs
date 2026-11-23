import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { resolveSoulmateHome, loadConfig, saveConfigAuto } from '../packages/soulmate-core/state.mjs';
import { loadFacts, listWikiPages, retainFact, reflectToWiki } from '../packages/soulmate-core/memory-engine.mjs';
import { migrateLegacyDisplayName, appendSelfArc } from '../packages/soulmate-core/memory-enrichment.mjs';
import { shouldAutoSurf } from '../packages/soulmate-core/proactive.mjs';
import { getDisplayName } from '../packages/soulmate-core/persona.mjs';
import { DEFAULT_CHAT_HOME } from '../packages/soulmate-core/chat-home.mjs';

const T0 = Date.parse('2026-11-12T08:00:00.000Z'); // 16:00 UTC+8, outside quiet hours

async function withHome(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'soulmate-voice-'));
  try {
    return await fn(resolveSoulmateHome(dir), dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('defaults: companion shorthand is soulmate, never 大肥鱼', () => {
  assert.equal(getDisplayName({}), 'soulmate');
  assert.equal(getDisplayName({ name: '  ' }), 'soulmate');
  assert.equal(getDisplayName({ name: '小鲸' }), '小鲸');
  assert.equal(DEFAULT_CHAT_HOME.titlePrefix, 'soulmate');
});

test('appendSelfArc without a name titles the wiki soulmate', async () => {
  await withHome(async (home) => {
    await appendSelfArc(home, { persona: {}, reason: '测试', nowMs: T0 });
    const pages = await listWikiPages(home);
    const arc = pages.find((p) => p.slug === 'self-arc');
    assert.equal(arc.title, 'soulmate的自我演变');
  });
});

test('migrateLegacyDisplayName rewrites facts + wiki + is idempotent', async () => {
  await withHome(async (home) => {
    await retainFact(home, {
      id: 'f_identity_display_name',
      topic: 'identity:display-name',
      content: '我的名字是「大肥鱼」。',
      decayClass: 'preference',
      category: 'preference',
      nowMs: T0,
    });
    await reflectToWiki(home, {
      slug: 'self-arc',
      title: '大肥鱼的自我演变',
      summary: '主人翁第一人称自述',
      category: 'self-arc',
      content: '我最近……换了性格。',
      nowMs: T0,
    });
    const res = await migrateLegacyDisplayName(home, {}, { nowMs: T0 + 1000 });
    assert.equal(res.facts, 1);
    assert.equal(res.wiki, 1);

    const { pub } = await loadFacts(home);
    const live = pub.filter((f) => f.topic === 'identity:display-name' && !f.invalidatedAt && !f.deletedAt);
    assert.equal(live.length, 1);
    assert.equal(live[0].content, '我的名字是「soulmate」。');
    assert.ok(pub.some((f) => f.id === 'f_identity_display_name' && f.invalidatedAt), 'old anchor superseded');

    const pages = await listWikiPages(home);
    assert.equal(pages.find((p) => p.slug === 'self-arc').title, 'soulmate的自我演变');

    const again = await migrateLegacyDisplayName(home, {}, { nowMs: T0 + 2000 });
    assert.deepEqual(again, { facts: 0, wiki: 0, config: 0 });
  });
});

test('migrateLegacyDisplayName prefers the persona name over soulmate', async () => {
  await withHome(async (home) => {
    await retainFact(home, {
      topic: 'identity:display-name',
      content: '我的名字是「大肥鱼」。',
      nowMs: T0,
    });
    await migrateLegacyDisplayName(home, { name: '小鲸' }, { nowMs: T0 + 1000 });
    const { pub } = await loadFacts(home);
    const live = pub.filter((f) => f.topic === 'identity:display-name' && !f.invalidatedAt);
    assert.equal(live[0].content, '我的名字是「小鲸」。');
  });
});

test('boot migration also fixes a legacy chatHome titlePrefix on disk', async () => {
  await withHome(async (home) => {
    await saveConfigAuto(home, { chatHome: { titlePrefix: '大肥鱼' } });
    const { bootstrapHome } = await import('../packages/soulmate-core/runtime/bootstrap.mjs');
    await bootstrapHome({ home, warn: () => {}, refreshPrompt: async () => {} });
    const conf = await loadConfig(home);
    assert.equal(conf.chatHome.titlePrefix, 'soulmate');
  });
});

// ---------------------------------------------------------------------------
// auto surf scheduler (pure decision)
// ---------------------------------------------------------------------------

test('shouldAutoSurf: disabled / quiet / interval / first round', () => {
  const base = { nowMs: T0, tzOffsetMinutes: 480, config: { biliEnabled: true, biliAutoSurfEnabled: true, biliAutoSurfEveryHours: 6, quietHours: ['00:00-07:00'] } };
  assert.equal(shouldAutoSurf({ ...base, config: { ...base.config, biliAutoSurfEnabled: false } }).reason, 'disabled');
  assert.equal(shouldAutoSurf({ ...base, config: { ...base.config, biliEnabled: false } }).reason, 'bili-disabled');
  // 02:00 local → quiet hours
  const night = Date.parse('2026-11-11T18:00:00.000Z');
  assert.equal(shouldAutoSurf({ ...base, nowMs: night }).reason, 'quiet-hours');
  // never surfed → first round
  assert.equal(shouldAutoSurf({ ...base, lastAutoSurfAt: '' }).surf, true);
  // 1h ago with 6h interval → too soon
  const soon = shouldAutoSurf({ ...base, lastAutoSurfAt: new Date(T0 - 3_600_000).toISOString() });
  assert.equal(soon.surf, false);
  assert.equal(soon.reason, 'too-soon');
  assert.ok(soon.nextInMs > 0);
  // 7h ago → due
  assert.equal(shouldAutoSurf({ ...base, lastAutoSurfAt: new Date(T0 - 7 * 3_600_000).toISOString() }).surf, true);
  // 10-minute interval: minutes field wins over hours
  const ten = {
    ...base,
    config: { ...base.config, biliAutoSurfEveryMinutes: 10, biliAutoSurfEveryHours: 6 },
    lastAutoSurfAt: new Date(T0 - 11 * 60_000).toISOString(),
  };
  assert.equal(shouldAutoSurf(ten).surf, true);
  assert.equal(shouldAutoSurf({ ...ten, lastAutoSurfAt: new Date(T0 - 5 * 60_000).toISOString() }).surf, false);
});

// ---------------------------------------------------------------------------
// browser half: thinking label + toast projection (loaded from the real bundle)
// ---------------------------------------------------------------------------

async function loadBrowserModule(key) {
  // Evaluate the single browser module straight from source (CJS format), with a
  // stubbed ./util.mjs so no network is touched. Same code the bundle ships.
  const file = new URL('../browser/' + key.slice(2), import.meta.url);
  const src = await readFile(file, 'utf8');
  const module = { exports: {} };
  const fn = new Function('module', 'exports', 'require', src);
  fn(module, module.exports, (id) => {
    if (id === './util.mjs') return { api: async () => ({ ok: false }) };
    if (id === './panel-mbti.mjs') return { tryOpenSessionClient: () => false, setHostOpenSession: () => {} };
    if (id === './panel-nav.mjs') return { requestSoulmateTab: () => {} };
    throw new Error('unexpected require ' + id);
  });
  return module.exports;
}

test('thinking-label: host brand string becomes companion thinking voice', async () => {
  const { labelFor, rewriteTextNode, LEGACY } = await loadBrowserModule('./thinking-label.mjs');
  assert.equal(labelFor(''), 'soulmate思考中');
  assert.equal(labelFor('小鲸'), '小鲸思考中');
  const node = { nodeValue: LEGACY + '中，用时 24秒' };
  rewriteTextNode(node);
  assert.equal(node.nodeValue, 'soulmate思考中，用时 24秒');
  rewriteTextNode(node); // idempotent — no stacking
  assert.equal(node.nodeValue, 'soulmate思考中，用时 24秒');
});

test('thinking-label: TextShimmer data-shimmer-text stays in sync (no ghost overlap)', async () => {
  // Host TextShimmer paints a decorative ::after from data-shimmer-text while the
  // real text node is rewritten — both must become companion voice or they stack.
  const { rewriteTextNode, rewriteShimmerAttr, LEGACY } = await loadBrowserModule('./thinking-label.mjs');
  const host = LEGACY + '中，用时 42秒 ···';
  const attrs = { 'data-shimmer-text': host };
  const shimmerEl = {
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null },
    setAttribute(name, value) { attrs[name] = value },
    hasAttribute(name) { return Object.prototype.hasOwnProperty.call(attrs, name) },
  };
  rewriteShimmerAttr(shimmerEl);
  assert.equal(attrs['data-shimmer-text'], 'soulmate思考中，用时 42秒 ···');
  rewriteShimmerAttr(shimmerEl); // idempotent
  assert.equal(attrs['data-shimmer-text'], 'soulmate思考中，用时 42秒 ···');

  // rewriteTextNode near a shimmer root must sync the decorative attr too.
  const root = {
    hasAttribute(name) { return name === 'data-shimmer' },
    querySelectorAll() { return [shimmerEl] },
    parentElement: null,
  };
  const textParent = { parentElement: root };
  attrs['data-shimmer-text'] = host; // host tick just repainted brand into attr
  const node = { nodeValue: host, parentElement: textParent };
  rewriteTextNode(node);
  assert.equal(node.nodeValue, 'soulmate思考中，用时 42秒 ···');
  assert.equal(attrs['data-shimmer-text'], 'soulmate思考中，用时 42秒 ···');
});

test('notify: toast click opens the matching session', async () => {
  const opened = [];
  const focusCalls = [];
  const file = new URL('../browser/notify.mjs', import.meta.url);
  const src = await readFile(file, 'utf8');
  const module = { exports: {} };
  const fn = new Function('module', 'exports', 'require', src);
  fn(module, module.exports, (id) => {
    if (id === './util.mjs') {
      return {
        api: async (path, body) => {
          if (path === 'notify/focus') focusCalls.push(body || {});
          return { ok: true };
        },
      };
    }
    if (id === './panel-mbti.mjs') {
      return {
        tryOpenSessionClient: (sessionId) => {
          opened.push(String(sessionId));
          return true;
        },
        setHostOpenSession: () => {},
      };
    }
    if (id === './panel-nav.mjs') return { requestSoulmateTab: () => {} };
    throw new Error('unexpected require ' + id);
  });
  const { openToastTarget, toastFor } = module.exports;
  const toast = toastFor({
    type: 'pet-say',
    kind: 'chat',
    text: '去专属窗看看这句话。',
    sessionId: 'session-click-1',
  }, '大海');
  assert.equal(toast.sessionId, 'session-click-1');
  openToastTarget(toast);
  assert.deepEqual(opened, ['session-click-1']);
  assert.deepEqual(focusCalls, [{ sessionId: 'session-click-1' }]);
  openToastTarget({ sessionId: '' });
  assert.deepEqual(opened, ['session-click-1']);
  assert.equal(focusCalls.length, 2);
});

test('notify/focus route uses OS protocol helper', async () => {
  const { focusDshViaProtocol, eventRoutes } = await import('../packages/soulmate-core/routes/event-routes.mjs');
  assert.equal(typeof focusDshViaProtocol, 'function');
  const routes = eventRoutes({ events: [], eventSeq: () => 0, pushEvent: () => 1 });
  const focus = routes.find((r) => r.paths.includes('/dsh-soulmate/api/notify/focus'));
  assert.ok(focus);
  assert.equal(focus.method, 'POST');
});

test('notify: toast projection covers the meaningful moments only', async () => {
  const { toastFor } = await loadBrowserModule('./notify.mjs');
  assert.equal(toastFor({ type: 'proactive', text: '该吃饭啦' }, '小鲸').title, '小鲸');
  assert.match(toastFor({ type: 'proactive', text: '该吃饭啦' }, '小鲸').body, /吃饭/);
  assert.match(toastFor({ type: 'video-watch', title: '测试视频', worthScore: 12 }, '').body, /12\/20/);
  assert.match(toastFor({ type: 'video-surf', pickedCount: 2, videos: [{ title: 'A' }] }, '').body, /2 个/);
  assert.ok(toastFor({ type: 'daily-diary', quiet: false }, ''));
  assert.ok(toastFor({ type: 'dream', count: 3 }, ''));
  assert.ok(toastFor({ type: 'promise-patrol', ask: true }, ''));
  assert.equal(toastFor({ type: 'retain' }, ''), null);
  assert.equal(toastFor({ type: 'boot-greeting', via: 'silent' }, ''), null);
  assert.equal(toastFor({ type: 'boot-greeting', via: 'host' }, ''), null);
  assert.match(toastFor({ type: 'pet-say', kind: 'boot', text: '醒了，在专属窗等你' }, '大哥').body, /醒了/);
  assert.equal(toastFor({ type: 'pet-say', kind: 'boot', text: '你。醒了。', preview: true }, '大哥'), null);
  assert.equal(toastFor({ type: 'pet-say', kind: 'boot', text: 'Same wake again, new port 50396' }, '大哥'), null);
  assert.equal(
    toastFor({
      type: 'pet-say',
      kind: 'boot',
      text: 'Again. Keep it to one short line. Maybe vary. "在。第八回。" Actually counting: turn1 wake',
    }, '大哥'),
    null,
  );
  assert.equal(toastFor({ type: 'pet-say', kind: 'proactive', text: '去修日记' }, '大哥'), null);
  assert.match(
    toastFor({
      type: 'pet-say',
      kind: 'boot',
      text: '没干正事，就在这儿待着。终端没动静，我顺手把工作区的状态扫了一眼——都安静。',
    }, '大哥').body,
    /没干正事/,
  );
  const chatToast = toastFor({
    type: 'pet-say',
    kind: 'chat',
    text: '嗯，这句就是对话结果。',
    sessionId: 'session-abc',
  }, '大哥');
  assert.match(chatToast.body, /对话结果/);
  assert.equal(chatToast.fullText, '嗯，这句就是对话结果。');
  assert.equal(chatToast.sessionId, 'session-abc');
  const stripped = toastFor({
    type: 'pet-say',
    kind: 'chat',
    text: '保持沉静守护者人设，话少。\n我在。晚上了，海面挺安静的。',
  }, '大哥');
  assert.match(stripped.body, /^我在。/);
  assert.doesNotMatch(stripped.fullText, /人设/);
  const long = '甲'.repeat(200);
  const clipped = toastFor({ type: 'pet-say', kind: 'chat', text: long }, '大哥');
  assert.ok(clipped.body.endsWith('…'));
  assert.ok(clipped.body.length < long.length);
  assert.equal(clipped.fullText, long);
});

test('notify/focus: electron direct focus preferred, protocol fallback, bounded retries', async () => {
  const { focusHarnessForToast, clearFocusRetryTimers } = await import('../packages/soulmate-core/routes/event-routes.mjs');
  try {
    const directCalls = [];
    const protoCalls = [];
    const out = focusHarnessForToast({
      directImpl: () => { directCalls.push(Date.now()); return 2; },
      protocolImpl: () => { protoCalls.push(Date.now()); return true; },
    });
    assert.equal(out.via, 'electron');
    assert.equal(out.windows, 2);
    assert.equal(out.protocol, true);
    assert.equal(directCalls.length, 1);
    assert.equal(protoCalls.length, 1, '协议始终补一发（覆盖未进工作区等状态）');
    await new Promise((r) => setTimeout(r, 2500));
    assert.equal(directCalls.length, 3, '0.9s/2.2s 两次重试');
    assert.equal(protoCalls.length, 3);

    // 非 Electron（direct=0）→ via protocol，仍然工作
    const fallback = focusHarnessForToast({ directImpl: () => 0, protocolImpl: () => true });
    assert.equal(fallback.via, 'protocol');
    assert.equal(fallback.windows, 0);

    // direct 抛错不致命
    const thrown = focusHarnessForToast({ directImpl: () => { throw new Error('no electron'); }, protocolImpl: () => true });
    assert.equal(thrown.via, 'protocol');
  } finally {
    clearFocusRetryTimers();
  }
});

test('notify/focus route reports via/windows and stays ok', async () => {
  const { eventRoutes, clearFocusRetryTimers } = await import('../packages/soulmate-core/routes/event-routes.mjs');
  try {
    const routes = eventRoutes({ events: [], eventSeq: () => 0, pushEvent: () => 1 });
    const focus = routes.find((r) => r.paths.includes('/dsh-soulmate/api/notify/focus'));
    const out = await focus.handler({ body: { sessionId: 's-1' } });
    const payload = JSON.parse(out.body);
    assert.equal(payload.ok, true);
    assert.equal(payload.sessionId, 's-1');
    assert.ok(['electron', 'protocol'].includes(payload.via));
    assert.equal(typeof payload.focused, 'boolean');
  } finally {
    clearFocusRetryTimers();
  }
});
