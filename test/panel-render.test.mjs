import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

/**
 * The settings page used to be covered only by string slicing over the bundle
 * (`source.slice(source.indexOf('function SoulmatePanelPage')...)`), which cannot see a
 * runtime error. That is exactly how `ReferenceError: proDraft is not defined` shipped:
 * a refactor deleted the `proDraft` local while `rhythmCard` still read it, and every
 * assertion still passed because nothing ever *called* the component.
 *
 * So: load the real bundle, mount the panel through a minimal React shim, and let the
 * component body run with a populated draft. Any undefined identifier or TDZ error in
 * the real render path now fails the suite.
 */

const DRAFT = {
  name: '鱼', callUser: '搭档', selfRef: '本鱼', customBody: '',
  preset: 'rice-whale',
  traitScheme: 'five',
  traits: { tsundere: 75, clinginess: 60, sassiness: 55, curiosity: 70, brevity: 65 },
  mbti: { type: 'INFP', axes: { EI: 75, SN: 75, TF: 75, JP: 75 } },
  schemeSnapshots: { five: { traits: null }, mbti: null },
  appearance: {
    formPreset: 'whale-girl', primaryColor: '#4176e6', accentColor: '#7aaaff',
    auraColor: '#e4edfd', scale: 1, accessories: {},
    customSpriteUrl: '/dsh-soulmate/api/sprite',
  },
  pet: { enabled: true, sizePx: 180, sleepAfterIdleSec: 300, skin: 'winterboy-chibi' },
  proactive: { enabled: true, dreamReflect: true, preferOffPeak: true, maxPerDay: 3, quietHours: [] },
};

/**
 * Minimal React shim with real state/ref semantics for a single render pass.
 * `seed` maps a useState slot index to a value, letting us hand the component a
 * populated `draft` instead of the "正在读取……" placeholder path.
 */
function makeReact(seed = {}) {
  const slots = [];
  const refs = [];
  let stateSlot = 0;
  let refSlot = 0;
  return {
    createElement: (type, props, ...kids) => ({ type, props: props || {}, kids }),
    useState: (init) => {
      const i = stateSlot++;
      if (!(i in slots)) slots[i] = i in seed ? seed[i] : (typeof init === 'function' ? init() : init);
      return [slots[i], (next) => { slots[i] = typeof next === 'function' ? next(slots[i]) : next; }];
    },
    useRef: (init) => {
      const i = refSlot++;
      if (!(i in refs)) refs[i] = { current: init };
      return refs[i];
    },
    useEffect: () => {},
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
  };
}

async function loadBundle() {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
  let def;
  vm.runInNewContext(source, {
    window: { __ModuleLoader__: { load: (d) => { def = d; } } },
    console,
  }, { filename: 'client.js' });
  return def;
}

/** Mount the bundle's apply() and capture the component registered on the `main` slot. */
function mountMainComponent(mod, React) {
  const slotsService = {
    inject: (name, fn) => {
      const reg = fn();
      if (name === 'main' && reg && reg.component) slotsService.page = reg.component;
      return () => {};
    },
    register: (opts, comp) => ({ opts, component: comp }),
  };
  // No `ctx.inject` on purpose: the entry then takes its documented "test / bare host"
  // probe branch, where a one-shot `ctx.get('slots')` is allowed.
  mod.apply({
    get: (name) => {
      if (name === 'slots') return slotsService;
      if (name === 'conversationEvents') return { register: () => {} };
      return undefined;
    },
    effect: (fn) => { if (typeof fn === 'function') { const d = fn(); if (typeof d === 'function') d(); } },
    on: () => () => {},
    tools: { register: () => () => {} },
    log: { info: () => {}, warn: () => {}, error: () => {} },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  }, {});
  return slotsService.page;
}

test('render: the settings page renders its populated state without a ReferenceError', async () => {
  const def = await loadBundle();

  // Panel state slot order (see SoulmatePanelPage): 0 snap, 1 engine, 2 draft, 3 error,
  // 4 busy, 5 note, 6 tab, 7 graph, 8 spriteNote, 9 proStatus. Seed the ones the cards
  // read so the render walks the real tab bodies instead of the placeholder early return.
  // Every tab is rendered: only the visible one used to be exercised by hand, and the
  // rhythm tab is exactly where `proDraft` went missing.
  const TABS = ['status', 'personality', 'neurons', 'identity', 'rhythm'];
  for (const tab of TABS) {
    const React = makeReact({ 2: DRAFT, 6: tab });
    const mod = def.factory((id) => {
      assert.equal(id, 'react');
      return React;
    });
    const Page = mountMainComponent(mod, React);
    assert.ok(Page, 'the settings page must be registered on the main slot');
    // Before the fix, rendering the rhythm tab threw
    //   ReferenceError: proDraft is not defined
    assert.doesNotThrow(() => Page({}), `the "${tab}" tab must render without throwing`);
  }

  // MBTI scheme: 16-grid + toggle must render on the personality tab.
  const mbtiDraft = Object.assign({}, DRAFT, {
    traitScheme: 'mbti',
    mbti: { type: 'ENFP', axes: { EI: 25, SN: 75, TF: 75, JP: 75 } },
  });
  const ReactMbti = makeReact({ 2: mbtiDraft, 6: 'personality' });
  const modMbti = def.factory((id) => {
    assert.equal(id, 'react');
    return ReactMbti;
  });
  const PageMbti = mountMainComponent(modMbti, ReactMbti);
  let tree;
  assert.doesNotThrow(() => { tree = PageMbti({}); }, 'MBTI personality tab must render');
  const flat = JSON.stringify(tree);
  assert.match(flat, /用 16 型人格/);
  assert.match(flat, /ENFP/);
  assert.match(flat, /sm-mbti-grid/);
  assert.match(flat, /测你想要.*是什么人格/);
});