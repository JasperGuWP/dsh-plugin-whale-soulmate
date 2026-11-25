// IM 主动搭话卡归属：应在 DsBot 标签（IM 通道行为），不再挂在冲浪页。
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

function makeReact(sharedSlots) {
  const slots = sharedSlots || [];
  let i = 0;
  return {
    createElement: (type, props, ...children) => {
      if (typeof type === 'function') return type(props || {});
      return { type, props: props || {}, children: children.flat(Infinity).filter((c) => c != null && c !== false) };
    },
    useState: (init) => {
      const idx = i++;
      if (!(idx in slots)) slots[idx] = typeof init === 'function' ? init() : init;
      return [slots[idx], (v) => { slots[idx] = typeof v === 'function' ? v(slots[idx]) : v; }];
    },
    useRef: (init) => ({ current: init }),
    useEffect: () => {},
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
  };
}

const walk = (node, out = []) => {
  if (node == null || node === false) return out;
  if (typeof node === 'string') { out.push(node); return out; }
  if (typeof node !== 'object') return out;
  if (Array.isArray(node)) { node.forEach((n) => walk(n, out)); return out; }
  out.push(node);
  if (node.children) walk(node.children, out);
  return out;
};
const texts = (tree) => walk(tree).filter((n) => typeof n === 'string').join('\n');

async function loadBrowser(file, extraRequires = {}, sharedSlots) {
  const src = await readFile(new URL(`../browser/${file}`, import.meta.url), 'utf8');
  const react = makeReact(sharedSlots);
  const module = { exports: {} };
  vm.runInNewContext(src, {
    module,
    exports: module.exports,
    fetch: async () => ({ status: 200, text: async () => '{}' }),
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
    require: (id) => {
      if (id === 'react') return react;
      if (extraRequires[id]) return extraRequires[id];
      if (id.endsWith('util.mjs')) return { api: async () => ({ ok: true, conversations: [] }), companionPronoun: () => ({ third: '他' }) };
      if (id.endsWith('panel-qqbot.mjs')) return { QqBotColumn: () => null };
      if (id.endsWith('panel-engage-quota.mjs')) return realQuota;
      throw new Error('unexpected require ' + id);
    },
    console,
    window: { addEventListener: () => {}, removeEventListener: () => {} },
    document: { addEventListener: () => {}, removeEventListener: () => {} },
  }, { filename: file });
  return module.exports;
}

// 真加载配额卡模块（它只依赖 react）。
const realQuota = await loadBrowser('panel-engage-quota.mjs');

test('IM 主动搭话卡挂在 DsBot 标签，冲浪页不再渲染它', async () => {
  const { DsBotCard } = await loadBrowser('panel-dsbot.mjs');
  const patches = [];
  const tree = DsBotCard({ ext: { imProactiveEnabled: true, imProactiveWhitelist: [] }, patchExtensions: (p) => patches.push(p) });
  const txt = texts(tree);
  assert.match(txt, /IM 主动搭话/);
  assert.match(txt, /允许她主动给下面加白的会话发消息/);
  // 无 patchExtensions（旧调用方）时不渲染，也不抛错
  const bare = DsBotCard({});
  assert.doesNotMatch(texts(bare), /IM 主动搭话/);

  const surfSrc = await readFile(new URL('../browser/panel-surf.mjs', import.meta.url), 'utf8');
  assert.ok(!surfSrc.includes('ProactiveSection'), '冲浪页不再引用 IM 主动搭话');
  const dsbotSrc = await readFile(new URL('../browser/panel-dsbot.mjs', import.meta.url), 'utf8');
  assert.ok(dsbotSrc.includes("h(ImProactiveSection, { key: 'im-pro'"), 'DsBot 页必须经 h() 挂载 IM 主动搭话（含 hooks，直接调用会白屏）');
});

// 真实 React 语义回归：DsBotCard 的 hook 数不得随 imProactiveEnabled 开关变化。
// 直接函数调用含 hooks 的子组件（旧写法）会把子组件 hooks 记到父组件头上，
// 开关一翻 hook 数变化 → React #310，整页白屏。
test('IM 开关切换不改变 DsBotCard 的 hook 数（防 #310 白屏）', async () => {
  let calls = 0;
  const countingReact = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: (init) => { calls++; return [typeof init === 'function' ? init() : init, () => {}]; },
    useRef: (init) => { calls++; return { current: init }; },
    useEffect: () => { calls++; },
    useCallback: (fn) => { calls++; return fn; },
    useMemo: (fn) => { calls++; return fn(); },
  };
  const renderDsBot = async (ext) => {
    const src = await readFile(new URL('../browser/panel-dsbot.mjs', import.meta.url), 'utf8');
    const module = { exports: {} };
    calls = 0;
    vm.runInNewContext(src, {
      module, exports: module.exports,
      fetch: async () => ({ status: 200, text: async () => '{}' }),
      setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {},
      require: (id) => {
        if (id === 'react') return countingReact;
        if (id.endsWith('util.mjs')) return { api: async () => ({ ok: true }), companionPronoun: () => ({ third: '他' }) };
        if (id.endsWith('panel-qqbot.mjs')) return { QqBotColumn: () => null };
        if (id.endsWith('panel-engage-quota.mjs')) return realQuota;
        throw new Error('unexpected require ' + id);
      },
      console,
      window: { addEventListener: () => {}, removeEventListener: () => {} },
      document: { addEventListener: () => {}, removeEventListener: () => {} },
    }, { filename: 'panel-dsbot.mjs' });
    module.exports.DsBotCard({ ext, patchExtensions: () => {} });
    return calls;
  };
  const off = await renderDsBot({ imProactiveEnabled: false });
  const on = await renderDsBot({ imProactiveEnabled: true, imProactiveWhitelist: [] });
  assert.equal(on, off, '开关前后 DsBotCard 调用的 hooks 数必须一致');
});

test('白名单编辑器提供「从最近会话选」，点击拉 /im/known 并可加白', async () => {
  const slots = [];
  const quota = await loadBrowser('panel-engage-quota.mjs', {
    './util.mjs': {
      api: async (path) => {
        if (path === 'im/known') {
          return { ok: true, conversations: [{ platform: 'qq', to: 'OPENID123', groupId: '', label: 'QQ私聊 OPENID…' }] };
        }
        return {};
      },
    },
  }, slots);
  // 直接渲染内部编辑器不可得（未导出）；经 ImProactiveSection 开启态渲染。
  const patches = [];
  const tree = quota.ImProactiveSection({
    ext: { imProactiveEnabled: true, imProactiveWhitelist: [] },
    patchExtensions: (p) => patches.push(p),
  });
  const btns = walk(tree).filter((n) => n.type === 'button');
  const pick = btns.find((b) => (b.children || []).some((c) => typeof c === 'string' && c.includes('从最近会话选')));
  assert.ok(pick, '存在「从最近会话选」按钮');
  await pick.props.onClick();
  // useState 在 shim 里同步落槽，重渲染可见已知会话行
  // 重渲染复用同一份 hooks 槽（真实 React 语义），已知会话行才会出现
  const quota2 = await loadBrowser('panel-engage-quota.mjs', {
    './util.mjs': { api: async () => ({ ok: true, conversations: [] }) },
  }, slots);
  const tree2 = quota2.ImProactiveSection({
    ext: { imProactiveEnabled: true, imProactiveWhitelist: [] },
    patchExtensions: (p) => patches.push(p),
  });
  const addBtn = walk(tree2).filter((n) => n.type === 'button').find((b) => (b.children || []).includes('加白'));
  assert.ok(addBtn, '已知会话行带「加白」');
  addBtn.props.onClick();
  assert.equal(patches.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(patches[0].imProactiveWhitelist[0])), { platform: 'qq', to: 'OPENID123', groupId: '', label: 'QQ私聊 OPENID…' });
});
test('im proactive: prefers the conversation whose official window is open', async () => {
  const { createImProactiveRuntime } = await import('../packages/soulmate-core/runtime/im-proactive-runtime.mjs');
  const { mkdtemp, rm, mkdir } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { resolveSoulmateHome, saveConfigAuto } = await import('../packages/soulmate-core/state.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'sm-imwin-'));
  try {
    const home = resolveSoulmateHome(join(dir, 'home'));
    await mkdir(home.rootDir, { recursive: true });
    await saveConfigAuto(home, {
      persona: { name: '小海', city: '上海' },
      proactive: { tzOffsetMinutes: 480, quietHours: [] },
      extensions: {
        imProactiveEnabled: true,
        imProactiveWhitelist: [
          { platform: 'qq', to: 'DM1', label: 'DM' },
          { platform: 'qq', to: 'G1', groupId: 'G1', label: '群' },
        ],
      },
    });
    const sent = [];
    const rt = createImProactiveRuntime({
      home, warn: () => {}, pushEvent: () => 0,
      usage: {
        meteredCall: async ({ call }) => ({ ok: true, out: await call() }),
        listHostModels: async () => [{ id: 'm' }],
        oneShotLlm: async () => ({ text: '群里冒个泡。' }),
      },
      cfg: {},
      officialTargets: async () => ({ ok: true, targets: [{ kind: 'group', groupId: 'G1', peer: 'G1', msgId: 'IN', ageMs: 1000 }] }),
      officialSend: async ({ target, text }) => { sent.push({ target, text }); return { ok: true }; },
    });
    const res = await rt.runImProactiveIfDue({ at: Date.parse('2026-11-24T09:06:45Z') });
    assert.equal(res.sent, true, JSON.stringify(res));
    assert.equal(sent[0].target.groupId, 'G1', 'must pick the open group, not the closed DM');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
