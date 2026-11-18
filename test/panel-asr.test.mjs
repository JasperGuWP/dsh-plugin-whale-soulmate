import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

/**
 * ASR 模型选择器:列表渲染、搜索过滤、选中回填。
 * 最小 React shim 真 mount 组件_body_。
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

async function loadPicker(seed) {
  const src = await readFile(new URL('../browser/panel-asr.mjs', import.meta.url), 'utf8');
  const react = makeReact(seed);
  const sandbox = {
    module: { exports: {} }, exports: {},
    require: (id) => (id === 'react' ? react : { api: async () => ({ ok: false }) }),
  };
  vm.runInNewContext(src, sandbox, { filename: 'panel-asr.mjs' });
  return sandbox.module.exports.AsrModelPicker;
}

const walk = (node, out = []) => {
  if (node == null || node === false || typeof node !== 'object') return out;
  if (Array.isArray(node)) { node.forEach((n) => walk(n, out)); return out; }
  out.push(node);
  if (node.children) walk(node.children, out);
  return out;
};
const byClass = (tree, cls) => walk(tree).filter((n) => n.type && n.props && String(n.props.className || '').includes(cls));

const MODELS = ['qwen-audio-3.1-flash', 'paraformer-v2', 'whisper-1'];

test('picker: renders a searchable select with all models', async () => {
  const Picker = await loadPicker({ 0: MODELS, 1: false, 2: '', 3: '' });
  const tree = Picker({ endpoint: 'https://x/v1', apiKey: 'k', value: '', onCommit: () => {} });
  const filter = walk(tree).find((n) => n.type === 'input' && /搜索模型/.test(String(n.props.placeholder || '')));
  assert.ok(filter, 'filter input rendered');
  assert.match(String(filter.props.placeholder), /3 个/);
  const opts = walk(tree).filter((n) => n.type === 'option');
  assert.equal(opts.length, 1 + MODELS.length);
});

test('picker: filter narrows the option list case-insensitively', async () => {
  const Picker = await loadPicker({ 0: MODELS, 1: false, 2: '', 3: 'QWEN' });
  const tree = Picker({ endpoint: 'https://x/v1', apiKey: 'k', value: '', onCommit: () => {} });
  const opts = walk(tree).filter((n) => n.type === 'option').map((o) => o.props.value);
  assert.deepEqual(opts, ['', 'qwen-audio-3.1-flash']);
});

test('picker: selecting an option commits the model id', async () => {
  const committed = [];
  const Picker = await loadPicker({ 0: MODELS, 1: false, 2: '', 3: '' });
  const tree = Picker({ endpoint: 'https://x/v1', apiKey: 'k', value: '', onCommit: (m) => committed.push(m) });
  const sel = byClass(tree, 'sm-panel-input').find((n) => n.type === 'select');
  sel.props.onChange({ target: { value: 'paraformer-v2' } });
  assert.deepEqual(committed, ['paraformer-v2']);
});