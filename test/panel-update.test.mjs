import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

/**
 * 头部自更新徽章:常驻版本+「检查更新」,四态文案(最新/有更新/已装待重启/失败重试)。
 * 用最小 React shim 真 mount 组件_body_,api 走注入桩。
 */

function makeReact(seed = {}) {
  const slots = [];
  const cursor = { i: 0 };
  return {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter((c) => c != null && c !== false) }),
    useState: (init) => {
      const idx = cursor.i++;
      if (!(idx in slots)) slots[idx] = idx in seed ? seed[idx] : (typeof init === 'function' ? init() : init);
      return [slots[idx], (v) => { slots[idx] = typeof v === 'function' ? v(slots[idx]) : v; }];
    },
    useRef: (init) => ({ current: init }),
    useEffect: () => {},
    useCallback: (fn) => fn,
    __resetCursor: () => { cursor.i = 0; },
  };
}

async function loadBadge(seed, apiImpl) {
  const src = await readFile(new URL('../browser/panel-update.mjs', import.meta.url), 'utf8');
  const react = makeReact(seed);
  const sandbox = {
    module: { exports: {} }, exports: {},
    require: (id) => (id === 'react' ? react : { api: apiImpl || (async () => ({ ok: true })) }),
    setInterval: () => 0, clearInterval: () => {},
  };
  vm.runInNewContext(src, sandbox, { filename: 'panel-update.mjs' });
  const Badge = sandbox.module.exports.UpdateBadge;
  // 模拟 re-render：每次调用前重置 hook 游标（真实 React 每次 render 从头读 hook）。
  return (props) => { react.__resetCursor(); return Badge(props); };
}

const texts = (node) => {
  if (node == null || node === false) return [];
  if (typeof node === 'string' || typeof node === 'number') return [String(node)];
  if (Array.isArray(node)) return node.flatMap(texts);
  return [...(node.props && node.props.children ? texts(node.props.children) : []), ...texts(node.children)];
};
const buttons = (node) => {
  if (node == null || node === false || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap(buttons);
  const self = node.type === 'button' ? [node] : [];
  return [...self, ...buttons(node.children), ...buttons(node.props && node.props.children)];
};
const btnByText = (tree, t) => buttons(tree).find((b) => texts(b).join('').includes(t));

test('badge: available update renders 更新到 <latest> plus persistent 检查更新', async () => {
  const Badge = await loadBadge({ 0: { ok: true, available: true, latest: '0.2.120', phase: 'idle', current: '0.2.119' }, 1: false });
  const tree = Badge({});
  assert.equal(buttons(tree).length, 2);
  assert.ok(btnByText(tree, '更新到 0.2.120'));
  assert.ok(btnByText(tree, '检查更新'));
  assert.ok(texts(tree).join('').includes('v0.2.119'), '常驻当前版本');
});

test('badge: installed phase renders 重启 button and keeps 检查更新', async () => {
  const Badge = await loadBadge({ 0: { ok: true, available: false, phase: 'installed', current: '0.2.120' }, 1: false });
  const tree = Badge({});
  assert.equal(buttons(tree).length, 2);
  assert.ok(btnByText(tree, '重启'));
  assert.ok(btnByText(tree, '检查更新'));
  assert.ok(texts(tree).join('').includes('重启生效'));
});

test('badge: error phase renders retry and keeps 检查更新', async () => {
  const Badge = await loadBadge({ 0: { ok: true, available: false, phase: 'error', error: 'pnpm add exited 1' }, 1: false });
  const tree = Badge({});
  assert.ok(texts(tree).join('').includes('更新失败'));
  assert.equal(buttons(tree).length, 2);
  assert.ok(btnByText(tree, '重试'));
  assert.ok(btnByText(tree, '检查更新'));
});

test('badge: up-to-date stays visible with version + 检查更新 (persistent entry)', async () => {
  const Badge = await loadBadge({ 0: { ok: true, available: false, phase: 'idle', current: '0.2.119', latest: '0.2.119' }, 1: false });
  const tree = Badge({});
  assert.ok(tree, '无更新也常驻显示');
  assert.ok(texts(tree).join('').includes('v0.2.119'));
  assert.equal(buttons(tree).length, 1);
  assert.ok(btnByText(tree, '检查更新'));
});

test('badge: no status yet still renders 检查更新 placeholder', async () => {
  const Badge = await loadBadge({ 0: null, 1: false });
  const tree = Badge({});
  assert.ok(tree);
  assert.ok(btnByText(tree, '检查更新'));
});

test('badge: click update POSTs self-update then refreshes status', async () => {
  const calls = [];
  const apiImpl = async (path, body) => {
    calls.push([path, body]);
    if (path === 'update-status') return { ok: true, available: false, phase: 'installed', current: '0.2.120' };
    return { ok: true, version: '0.2.120', needRestart: true };
  };
  const Badge = await loadBadge({ 0: { ok: true, available: true, latest: '0.2.120', phase: 'idle' }, 1: false }, apiImpl);
  const tree = Badge({});
  const btn = btnByText(tree, '更新到');
  await btn.props.onClick();
  assert.equal(JSON.stringify(calls[0]), JSON.stringify(['self-update', {}]));
  assert.ok(calls.some(([p]) => p === 'update-status'));
});

test('badge: click 检查更新 POSTs update-check; up-to-date reply shows 已是最新', async () => {
  const calls = [];
  const apiImpl = async (path, body) => {
    calls.push([path, body]);
    if (path === 'update-check') return { ok: true, available: false, phase: 'idle', current: '0.2.119', latest: '0.2.119' };
    return { ok: true, available: false, phase: 'idle', current: '0.2.119' };
  };
  // seed: st 已有旧状态, checking=false, rerr='', note=''
  const Badge = await loadBadge({ 0: { ok: true, available: false, phase: 'idle', current: '0.2.119' }, 1: false, 2: false, 3: '', 4: '' }, apiImpl);
  const tree = Badge({});
  await btnByText(tree, '检查更新').props.onClick();
  assert.equal(JSON.stringify(calls[0]), JSON.stringify(['update-check', {}]));
  const after = Badge({});
  assert.ok(texts(after).join('').includes('已是最新'), '检查完无更新给出反馈');
});