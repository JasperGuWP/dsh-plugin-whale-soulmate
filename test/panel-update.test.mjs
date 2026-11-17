import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

/**
 * 头部自更新徽章:三态文案(有更新/已装待重启/失败重试),无更新不占位。
 * 用最小 React shim 真 mount 组件_body_,api 走注入桩。
 */

function makeReact(seed = {}) {
  const slots = [];
  let i = 0;
  return {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter((c) => c != null && c !== false) }),
    useState: (init) => {
      const idx = i++;
      if (!(idx in slots)) slots[idx] = idx in seed ? seed[idx] : (typeof init === 'function' ? init() : init);
      return [slots[idx], (v) => { slots[idx] = typeof v === 'function' ? v(slots[idx]) : v; }];
    },
    useRef: (init) => ({ current: init }),
    useEffect: () => {},
    useCallback: (fn) => fn,
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
  return sandbox.module.exports.UpdateBadge;
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

test('badge: available update renders 更新到 <latest> button', async () => {
  const Badge = await loadBadge({ 0: { ok: true, available: true, latest: '0.2.120', phase: 'idle', current: '0.2.119' }, 1: false });
  const tree = Badge({});
  const bs = buttons(tree);
  assert.equal(bs.length, 1);
  assert.ok(texts(bs[0]).join('').includes('更新到 0.2.120'));
});

test('badge: installed phase renders 重启 button', async () => {
  const Badge = await loadBadge({ 0: { ok: true, available: false, phase: 'installed', current: '0.2.120' }, 1: false });
  const tree = Badge({});
  const bs = buttons(tree);
  assert.equal(bs.length, 1);
  assert.ok(texts(bs[0]).join('').includes('重启'));
  assert.ok(texts(tree).join('').includes('重启生效'));
});

test('badge: error phase renders retry', async () => {
  const Badge = await loadBadge({ 0: { ok: true, available: false, phase: 'error', error: 'pnpm add exited 1' }, 1: false });
  const tree = Badge({});
  assert.ok(texts(tree).join('').includes('更新失败'));
  assert.equal(buttons(tree).length, 1);
});

test('badge: up-to-date renders nothing (no placeholder)', async () => {
  const Badge = await loadBadge({ 0: { ok: true, available: false, phase: 'idle', current: '0.2.119', latest: '0.2.119' }, 1: false });
  assert.equal(Badge({}), null);
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
  const btn = buttons(tree)[0];
  await btn.props.onClick();
  assert.equal(JSON.stringify(calls[0]), JSON.stringify(['self-update', {}]));
  assert.ok(calls.some(([p]) => p === 'update-status'));
});