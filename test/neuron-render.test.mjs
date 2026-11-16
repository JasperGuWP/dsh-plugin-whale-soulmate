import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { collectModules, emitOrder } from '../browser/build.mjs';

/**
 * The neuron tab rendered a blank canvas in the live UI even though the header reported
 * "星辰 6 星丝 2" — the data was there, the pixels were not. A drawing crash inside
 * `drawNeurons` is swallowed by the rAF loop (an exception just kills that one frame), so
 * the tab looks empty forever with no console error the user would notice.
 *
 * These tests run the *real* bundled module graph against a recording 2D context, so a
 * thrown error or a zero-draw frame fails here instead of showing up as a black box.
 */

async function loadNeuron() {
  const { sources, deps } = await collectModules('./neuron/index.mjs');
  const order = emitOrder('./neuron/index.mjs', deps);
  const defs = {};
  const posix = {
    normalize(spec) {
      const parts = [];
      for (const seg of spec.split('/')) {
        if (seg === '..') parts.pop();
        else if (seg !== '.' && seg !== '') parts.push(seg);
      }
      return './' + parts.join('/');
    },
    dirname(spec) {
      const i = spec.lastIndexOf('/');
      return i <= 0 ? '.' : spec.slice(0, i);
    },
  };
  const resolve = (fromKey, spec) => posix.normalize(posix.dirname(fromKey) + '/' + spec.slice(2));
  let currentKey = null;
  const sandbox = {
    module: { exports: {} },
    exports: {},
    require: (spec) => {
      if (!spec.startsWith('.')) throw new Error(`unexpected external require: ${spec}`);
      const key = resolve(currentKey, spec);
      if (defs[key]) return defs[key];
      throw new Error(`unexpected external require: ${spec} (resolved ${key})`);
    },
    console,
    Math,
    Date,
    performance,
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
    WeakMap,
    Map,
    Set,
    Object,
    Array,
    Number,
    String,
    JSON,
    isFinite,
    isNaN,
    parseFloat,
    parseInt,
  };
  vm.createContext(sandbox);
  for (const key of order) {
    currentKey = key;
    const fn = vm.runInContext(
      `(function (module, exports, require) {\n${sources.get(key)}\n})`,
      sandbox,
      { filename: key },
    );
    const mod = { exports: {} };
    fn(mod, mod.exports, sandbox.require);
    defs[key] = mod.exports;
  }
  return defs['./neuron/index.mjs'];
}

function recordingCtx() {
  const calls = {};
  const noop = () => {};
  const target = {
    canvas: { width: 720, height: 360 },
    measureText: () => ({ width: 8 }),
    createLinearGradient: () => ({ addColorStop: noop }),
    createRadialGradient: () => ({ addColorStop: noop }),
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
    putImageData: noop,
    setTransform: noop,
    save: noop,
    restore: noop,
  };
  const ctx = new Proxy(target, {
    get(t, k) {
      if (k in t) return t[k];
      return (...args) => {
        calls[k] = (calls[k] || 0) + 1;
        return undefined;
      };
    },
    set(t, k, v) {
      t[k] = v;
      return true;
    },
  });
  return { ctx, calls };
}

function makeCanvas(width = 720, height = 360) {
  const { ctx, calls } = recordingCtx();
  return {
    canvas: {
      width,
      height,
      getContext: () => ctx,
      addEventListener: () => {},
      removeEventListener: () => {},
      getBoundingClientRect: () => ({ left: 0, top: 0, width, height }),
      style: {},
    },
    calls,
  };
}

const graph = {
  nodes: [
    { id: 'n1', label: '插件开发', kind: 'fact', salience: 0.8 },
    { id: 'n2', label: '咖啡偏好', kind: 'fact', salience: 0.6 },
    { id: 'n3', label: '怕黑', kind: 'fact', salience: 0.9 },
  ],
  synapses: [
    { id: 's1', source: 'n1', target: 'n2', kind: 'topic', strength: 0.5 },
    { id: 's2', source: 'n2', target: 'n3', kind: 'topic', strength: 0.4 },
  ],
};

test('neuron: drawNeurons paints the starfield without throwing', async () => {
  const neuron = await loadNeuron();
  assert.equal(typeof neuron.drawNeurons, 'function');
  const { canvas, calls } = makeCanvas();
  assert.doesNotThrow(() => neuron.drawNeurons(canvas, graph, 1000));
  const painted = (calls.fillRect || 0) + (calls.arc || 0) + (calls.fill || 0) + (calls.stroke || 0) + (calls.fillText || 0);
  assert.ok(painted > 20, `a real frame must paint many primitives, got ${painted}`);
});

test('neuron: an empty graph still paints the sky (never a black rectangle)', async () => {
  const neuron = await loadNeuron();
  const { canvas, calls } = makeCanvas();
  assert.doesNotThrow(() => neuron.drawNeurons(canvas, null, 1000));
  const painted = (calls.fillRect || 0) + (calls.arc || 0) + (calls.fill || 0) + (calls.stroke || 0);
  assert.ok(painted > 0, 'the empty state must still draw a sky');
});

test('neuron: the layout is stable and deterministic for the same graph', async () => {
  const neuron = await loadNeuron();
  const a = neuron.layoutMemoryGalaxy(graph);
  const b = neuron.layoutMemoryGalaxy(graph);
  assert.deepEqual(a, b, 'a cached layout must not drift between frames');
});

test('neuron: a 0×0 canvas is skipped instead of baking an empty sky', async () => {
  const neuron = await loadNeuron();
  const { canvas } = makeCanvas(0, 0);
  assert.doesNotThrow(() => neuron.drawNeurons(canvas, graph, 1000));
  // A real canvas must still paint afterwards: the empty rebuild must not have been cached.
  const big = makeCanvas(720, 360);
  neuron.drawNeurons(big.canvas, graph, 1016);
  assert.ok((big.calls.arc || 0) > 0, 'a laid-out canvas must paint stars');
});

test('neuron: null and undefined graphs do not share mutable layout state', async () => {
  const neuron = await loadNeuron();
  const a = neuron.layoutMemoryGalaxy(null);
  const b = neuron.layoutMemoryGalaxy(undefined);
  assert.notEqual(a.world, b.world, 'each empty layout needs its own Map');
  assert.equal(a.world.size, 0);
});

test('neuron: session_star has warm tint and lays out near episodes', async () => {
  const { readFile } = await import('node:fs/promises');
  const { dirname, join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const paletteSrc = await readFile(join(root, 'browser/neuron/palette.mjs'), 'utf8');
  assert.match(paletteSrc, /session_star:\s*\[255,\s*179,\s*71\]/, 'session_star tint is warm orange #ffb347');
  const renderSrc = await readFile(join(root, 'browser/neuron/render.mjs'), 'utf8');
  assert.match(renderSrc, /session_star:\s*\[[0-9.]+,\s*[0-9.]+\]/, 'session_star has LAYER_BAND');

  const neuron = await loadNeuron();
  const g = {
    nodes: [
      { id: 'w1', kind: 'wiki_star', label: 'topic', importance: 5 },
      { id: 'ep1', kind: 'episode_crystal', label: 'diary', importance: 3 },
      { id: 'ss1', kind: 'session_star', label: 'chat', importance: 3 },
    ],
    synapses: [],
  };
  const layout = neuron.layoutMemoryGalaxy(g);
  assert.ok(layout.world.has('ss1'), 'session_star is placed');
  assert.ok(layout.world.has('ep1'), 'episode_crystal is placed');
  const rad = (p) => Math.sqrt(p.x * p.x + p.y * p.y + p.z * p.z);
  const ssR = rad(layout.world.get('ss1'));
  const epR = rad(layout.world.get('ep1'));
  assert.ok(Math.abs(ssR - epR) < 4, `session_star near episode band (ss=${ssR.toFixed(2)} ep=${epR.toFixed(2)})`);
  assert.doesNotThrow(() => neuron.drawNeurons(makeCanvas().canvas, g, 1000));
});