// IM 主动搭话卡归属：应在 DsBot 标签（IM 通道行为），不再挂在冲浪页。
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

function makeReact() {
  const slots = [];
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

async function loadBrowser(file, extraRequires = {}) {
  const src = await readFile(new URL(`../browser/${file}`, import.meta.url), 'utf8');
  const react = makeReact();
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
      if (id.endsWith('util.mjs')) return { api: async () => ({}), companionPronoun: () => ({ third: '他' }) };
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
  assert.ok(!surfSrc.includes('imProactiveSection'), '冲浪页不再引用 IM 主动搭话');
  const dsbotSrc = await readFile(new URL('../browser/panel-dsbot.mjs', import.meta.url), 'utf8');
  assert.ok(dsbotSrc.includes('imProactiveSection'), 'DsBot 页引用 IM 主动搭话');
});