import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

/**
 * The desktop pet's acting rules:
 *   - user sends a message  -> `think` (the 3-frame pondering loop)
 *   - answer arrives        -> `eureka` (the lightbulb flash) immediately
 *   - walking happens only on a conversation switch, never as idle filler
 *
 * Two things must both work or she looks asleep:
 *   1. Node: host assemble() must latch petThinking via `section.text(ctx)`, then
 *      release on whenIdle (quiet window is fallback only).
 *   2. Browser: poll tightly while acting so the think→eureka edge is not missed.
 */

const BUNDLE = new URL('../client.js', import.meta.url);

function makeReact() {
  const slots = [], refs = [];
  let s = 0, r = 0;
  return {
    createElement: (type, props, ...kids) => ({ type, props: props || {}, kids }),
    useState: (init) => { const i = s++; if (!(i in slots)) slots[i] = typeof init === 'function' ? init() : init; return [slots[i], (n) => { slots[i] = n; }]; },
    useRef: (init) => { const i = r++; if (!(i in refs)) refs[i] = { current: init }; return refs[i]; },
    useEffect: () => {}, useCallback: (fn) => fn, useMemo: (fn) => fn(),
  };
}

async function bundleSource() {
  return readFile(BUNDLE, 'utf8');
}

test('pet acting: acting poll is tight enough to catch think→eureka', async () => {
  const src = await bundleSource();
  const pollMatch = /const POLL_MS = (\d+)/.exec(src);
  const fastMatch = /const POLL_FAST_MS = (\d+)/.exec(src);
  assert.ok(pollMatch, 'POLL_MS must be declared');
  assert.ok(fastMatch, 'POLL_FAST_MS must be declared');
  const pollMs = Number(pollMatch[1]);
  const fastMs = Number(fastMatch[1]);
  assert.ok(pollMs <= 3000, `POLL_MS (${pollMs}ms) must stay responsive`);
  assert.ok(fastMs <= 800, `POLL_FAST_MS (${fastMs}ms) must notice eureka promptly`);
  assert.ok(fastMs < pollMs, 'acting poll must be faster than the calm poll');
});

test('pet acting: idle must not randomly wander off', async () => {
  // Walking is supposed to be a conversation-switch gesture, not ambient filler.
  for (const skin of ['pet-winterboy-chibi']) {
    const manifest = JSON.parse(await readFile(new URL(`../assets/${skin}/pet.json`, import.meta.url), 'utf8'));
    const idleNext = manifest.states.idle.next || {};
    assert.ok(
      !Number(idleNext.walk),
      `${skin}: idle must not transition into walk on a dice roll (saw ${idleNext.walk})`,
    );
  }
});

test('pet acting: every skin ships think + eureka + walk states', async () => {
  for (const skin of ['pet-winterboy-chibi']) {
    const manifest = JSON.parse(await readFile(new URL(`../assets/${skin}/pet.json`, import.meta.url), 'utf8'));
    for (const need of ['think', 'eureka', 'walk']) {
      assert.ok(manifest.states[need], `${skin}: missing the "${need}" state`);
      assert.ok((manifest.states[need].frames || []).length > 0, `${skin}: "${need}" has no frames`);
    }
  }
});

test('pet acting: the widget reacts to a conversation switch with a walk', async () => {
  const src = await bundleSource();
  // A conversation switch must drive the walk state. Assert the actual rule: the walk is
  // entered from a *session id change*, guarded to only fire from a resting pose — not from
  // a random idle dice roll (which is what made her wander off unprompted).
  assert.match(src, /petEvent\(\s*['"]walk['"]/, 'the widget must be able to enter walk');
  const switchRule = /lastSessionId\s*!==\s*null\s*&&\s*sessionId\s*!==\s*lastSessionId/.exec(src);
  assert.ok(switchRule, 'walk must be triggered by a session/conversation switch');
  // The id comes from the node half's /api/state payload, not from the bundle.
  // Post-split the projection lives in runtime/summary.mjs and the session latch
  // in runtime/prompt-engine.mjs; the assembler only wires them together.
  const summary = await readFile(new URL('../packages/soulmate-core/runtime/summary.mjs', import.meta.url), 'utf8');
  assert.match(summary, /sessionId\s*:\s*promptEngine\.sessionId/, 'the node half must expose the current session id');
  const engine = await readFile(new URL('../packages/soulmate-core/runtime/prompt-engine.mjs', import.meta.url), 'utf8');
  assert.match(engine, /get sessionId\(\)/, 'the prompt engine must latch the current session id');
});