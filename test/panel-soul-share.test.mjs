import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

// Soul-share panel card: export button, import preview → confirm flow, undo.
// Minimal React shim mounts the component body (same pattern as panel-asr.test).

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

async function loadCard(seed, apiImpl) {
  const src = await readFile(new URL('../browser/panel-soul-share.mjs', import.meta.url), 'utf8');
  const react = makeReact(seed);
  const calls = [];
  const sandbox = {
    module: { exports: {} }, exports: {},
    document: { createElement: () => ({ click: () => {} }) },
    Blob: class {}, URL: { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} },
    FileReader: class {}, setTimeout: () => {},
    require: (id) => {
      if (id === 'react') return react;
      if (id === './util.mjs') return { api: async (path, body) => { calls.push({ path, body }); return apiImpl(path, body); } };
      if (id === './panel-cards.mjs') return { engHead: (...a) => ({ type: 'head', props: {}, children: a }) };
      throw new Error('unexpected require ' + id);
    },
  };
  vm.runInNewContext(src, sandbox, { filename: 'panel-soul-share.mjs' });
  return { Card: sandbox.module.exports.SoulShareCard, calls };
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
const buttons = (tree) => walk(tree).filter((n) => n.type === 'button');
const texts = (tree) => walk(tree).filter((n) => typeof n === 'string');

test('soul-share card: renders export + import buttons and privacy note', async () => {
  const { Card } = await loadCard({}, async () => ({ ok: true }));
  const tree = Card({});
  const labels = buttons(tree).map((b) => b.children.join(''));
  assert.ok(labels.some((l) => l.includes('导出')), 'export button');
  assert.ok(labels.some((l) => l.includes('导入灵魂档案')), 'import button');
  assert.ok(texts(tree).some((t) => String(t).includes('私密记忆')), 'privacy reassurance');
});

test('soul-share card: export hits the API with the wiki flag and downloads', async () => {
  const { Card, calls } = await loadCard({ 0: true }, async () => ({ ok: true, markdown: '---\n---\n', fileName: 'x.soulmate.md', dropped: [] }));
  const tree = Card({});
  const exp = buttons(tree).find((b) => b.children.join('').includes('导出'));
  await exp.props.onClick();
  assert.equal(calls[0].path, 'soul-share/export?wiki=1');
});

test('soul-share card: preview state renders confirm + red warning, import posts markdown', async () => {
  const preview = {
    name: '大海', gender: 'female', preset: 'rice-whale', selfRef: '本鱼', callUser: '搭档',
    traits: { tsundere: 80, clinginess: 60, sassiness: 65, curiosity: 70, brevity: 65 },
    catchphrases: ['哼'], wikiImpressions: ['[[sushi]] 寿司'], welcome: '',
  };
  // slots: includeWiki, busy, msg, dropped, importText, preview, undoFile
  const { Card, calls } = await loadCard(
    { 4: '---\nmd\n---', 5: preview },
    async (path) => (path === 'soul-share/import' ? { ok: true, snapshotFile: 'snap.json' } : { ok: true }),
  );
  const tree = Card({ onImported: () => {} });
  const all = texts(tree).map(String);
  assert.ok(all.some((t) => t.includes('大海')), 'preview shows name');
  assert.ok(all.some((t) => t.includes('覆盖当前人设')), 'red overwrite warning');
  const confirm = buttons(tree).find((b) => b.children.join('').includes('确认导入'));
  assert.ok(confirm, 'confirm button');
  await confirm.props.onClick();
  const imp = calls.find((c) => c.path === 'soul-share/import');
  assert.equal(imp.body.markdown, '---\nmd\n---');
});

test('soul-share card: undo button appears with a snapshot and calls the undo API', async () => {
  const { Card, calls } = await loadCard({ 6: 'pre_soul_share.json' }, async () => ({ ok: true }));
  const tree = Card({});
  const undo = buttons(tree).find((b) => b.children.join('').includes('撤销'));
  assert.ok(undo, 'undo button');
  await undo.props.onClick();
  assert.equal(calls[0].path, 'soul-share/undo');
  assert.equal(calls[0].body.snapshotFile, 'pre_soul_share.json');
});