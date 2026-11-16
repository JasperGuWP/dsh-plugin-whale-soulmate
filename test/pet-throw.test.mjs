import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

/**
 * Flick-throw physics (dsh-pet 同款手感):
 *   - gentle put-down / reduced motion never launch
 *   - gravity pulls down, walls/floor/ceiling bounce with restitution
 *   - ground friction brings the pet to rest on the floor; onRest fires once
 *   - sub-stepping keeps a max-speed flick from tunneling through the floor
 *   - landing squash dips the stage then restores it exactly
 *   - releaseVelocity reads the last ~120ms of pointer travel (flick fast, hold ≈0)
 */

async function loadThrow() {
  const src = await readFile(new URL('../browser/pet-throw.mjs', import.meta.url), 'utf8');
  const sandbox = { module: { exports: {} }, exports: {}, console, Math, Object, Array, Number };
  vm.runInNewContext(src, sandbox, { filename: 'pet-throw.mjs' });
  return sandbox.module.exports;
}

async function loadReleaseVelocity() {
  const src = await readFile(new URL('../browser/pet-drag.mjs', import.meta.url), 'utf8');
  const sandbox = {
    module: { exports: {} }, exports: {}, console, Math, Array, Number,
    require: () => ({ isOpaquePetPixel: () => true }),
    window: { addEventListener() {} },
    performance: { now: () => 0 },
  };
  vm.runInNewContext(src, sandbox, { filename: 'pet-drag.mjs' });
  return sandbox.module.exports.releaseVelocity;
}

function env(overrides = {}) {
  const root = { style: {} };
  const stage = { style: {} };
  const state = { W: 1280, H: 800, w: 263, h: 148, reduced: false, rests: 0, physics: null };
  Object.assign(state, overrides);
  const deps = {
    root: () => root,
    stage: () => stage,
    viewport: () => ({ width: state.W, height: state.H }),
    size: () => ({ width: state.w, height: state.h }),
    physics: () => state.physics,
    reducedMotion: () => state.reduced,
    onRest: () => { state.rests++ },
  };
  return { root, stage, state, deps };
}

const px = (root, key) => parseFloat(root.style[key]);
// viewport 1280×800, stage 263×148, pad 8 → floor top = 644, right left = 1009
const FLOOR = 644;
const RIGHT = 1009;

function run(thrower, frames, dtMs = 16) {
  let t = 0;
  for (let i = 0; i < frames; i++) { thrower.step(t); t += dtMs; }
  return t;
}

test('throw: gentle release below the threshold never launches', async () => {
  const { createPetThrow, MIN_THROW_SPEED } = await loadThrow();
  const { deps } = env();
  const thrower = createPetThrow(deps);
  assert.equal(thrower.start(600, 300, MIN_THROW_SPEED - 1, 0), false);
  assert.equal(thrower.active(), false);
});

test('throw: reduced motion keeps the gentle put-down', async () => {
  const { createPetThrow } = await loadThrow();
  const { deps } = env({ reduced: true });
  const thrower = createPetThrow(deps);
  assert.equal(thrower.start(600, 300, 2000, -1000), false);
});

test('throw: flick flies forward and gravity pulls it to the floor', async () => {
  const { createPetThrow } = await loadThrow();
  const { root, deps } = env();
  const thrower = createPetThrow(deps);
  assert.equal(thrower.start(600, 300, 800, -600), true);
  thrower.step(0);
  thrower.step(16);
  assert.ok(px(root, 'left') > 600, 'moves forward');
  run(thrower, 900); // bounce + slide until rest
  assert.equal(thrower.active(), false);
  assert.equal(px(root, 'top'), FLOOR, 'settles exactly on the floor');
});

test('throw: right wall bounce reverses direction with restitution', async () => {
  const { createPetThrow } = await loadThrow();
  const { root, deps } = env();
  const thrower = createPetThrow(deps);
  thrower.start(RIGHT - 60, 300, 2000, 0);
  thrower.step(0);
  let prev = px(root, 'left');
  let rose = false;
  let fell = false;
  let t = 16;
  for (let i = 0; i < 30; i++) {
    thrower.step(t); t += 16;
    const x = px(root, 'left');
    assert.ok(x <= RIGHT, 'never past the wall');
    if (x > prev) rose = true;
    else if (rose && x < prev) { fell = true; break; }
    prev = x;
  }
  assert.ok(rose && fell, 'travels right, bounces, then travels back left');
});

test('throw: friction settles the pet and onRest fires exactly once', async () => {
  const { createPetThrow } = await loadThrow();
  const { root, state, deps } = env();
  const thrower = createPetThrow(deps);
  thrower.start(600, 300, 900, -500);
  run(thrower, 900); // ~14s: bounce + slide to rest
  assert.equal(thrower.active(), false, 'comes to rest');
  assert.equal(state.rests, 1);
  assert.equal(px(root, 'top'), FLOOR);
  const settled = px(root, 'left');
  thrower.step(20000);
  assert.equal(px(root, 'left'), settled, 'stays put after rest');
});

test('throw: max-speed flick never tunnels through the floor', async () => {
  const { createPetThrow } = await loadThrow();
  const { root, deps } = env();
  const thrower = createPetThrow(deps);
  thrower.start(600, 600, 3500, 3500);
  thrower.step(0);
  for (let t = 33; t <= 660; t += 33) {
    thrower.step(t);
    assert.ok(px(root, 'top') <= FLOOR, 'top never past the floor at t=' + t);
    assert.ok(px(root, 'left') <= RIGHT, 'left never past the right wall at t=' + t);
  }
});

test('throw: release speed is soft-capped at 3600 × throwPower', async () => {
  const { createPetThrow } = await loadThrow();
  const { root, deps } = env();
  const thrower = createPetThrow(deps);
  thrower.start(100, 300, 100000, 0);
  thrower.step(0);
  thrower.step(16);
  const dx = px(root, 'left') - 100;
  assert.ok(Math.abs(dx - 3600 * 0.016) < 1, 'first frame travels ≈ cap × dt, got ' + dx);
});

test('throw: stop() freezes the flight in place', async () => {
  const { createPetThrow } = await loadThrow();
  const { root, state, deps } = env();
  const thrower = createPetThrow(deps);
  thrower.start(600, 300, 900, -500);
  thrower.step(0);
  thrower.step(16);
  thrower.stop();
  assert.equal(thrower.active(), false);
  const x = px(root, 'left');
  thrower.step(32);
  assert.equal(px(root, 'left'), x);
  assert.equal(state.rests, 0, 'a caught pet is not a landed pet');
});

test('throw: landing squash dips the stage then restores it exactly', async () => {
  const { createPetThrow } = await loadThrow();
  const { stage, deps } = env();
  const thrower = createPetThrow(deps);
  thrower.start(600, 100, 0, 250); // steep drop → hard landing
  let dipped = false;
  let t = 0;
  for (let i = 0; i < 900; i++) {
    thrower.step(t); t += 16;
    if (stage.style.transform && stage.style.transform.includes('scaleY')) dipped = true;
  }
  assert.ok(dipped, 'stage squashed on landing');
  assert.equal(stage.style.transform, '', 'transform fully restored afterwards');
});

test('throw: zero gravity + zero restitution drifts into a wall and rests there', async () => {
  const { createPetThrow } = await loadThrow();
  const { root, state, deps } = env({ physics: { gravity: 0, restitution: 0, groundFriction: 0 } });
  const thrower = createPetThrow(deps);
  thrower.start(RIGHT - 10, 300, 500, 0);
  run(thrower, 60);
  assert.equal(thrower.active(), false, 'dead wall hit with no gravity → rest');
  assert.equal(px(root, 'left'), RIGHT);
  assert.equal(px(root, 'top'), 300, 'no gravity → no fall');
  assert.equal(state.rests, 1);
});

test('throw: bad physics overrides fall back to defaults per key', async () => {
  const { createPetThrow } = await loadThrow();
  const { root, deps } = env({ physics: { gravity: -5, restitution: 'x', throwPower: 0 } });
  const thrower = createPetThrow(deps);
  thrower.start(100, 300, 100000, 0);
  thrower.step(0);
  thrower.step(16);
  const dx = px(root, 'left') - 100;
  assert.ok(Math.abs(dx - 3600 * 0.016) < 1, 'throwPower 0 → default 1, cap intact');
});

test('drag: releaseVelocity reads a fast flick', async () => {
  const releaseVelocity = await loadReleaseVelocity();
  const v = releaseVelocity([
    { t: 0, x: 0, y: 0 },
    { t: 16, x: 30, y: 10 },
    { t: 32, x: 60, y: 20 },
  ]);
  assert.ok(Math.abs(v.vx - 1875) < 1, 'vx = 60px / 32ms');
  assert.ok(Math.abs(v.vy - 625) < 1);
});

test('drag: holding still before release reads ~0 (gentle put-down)', async () => {
  const releaseVelocity = await loadReleaseVelocity();
  const v = releaseVelocity([
    { t: 0, x: 0, y: 0 },
    { t: 16, x: 60, y: 20 },
    { t: 200, x: 60, y: 20 }, // paused 184ms, then let go
  ]);
  assert.equal(v.vx, 0);
  assert.equal(v.vy, 0);
});

test('drag: a slow drag within the window stays below throw speed', async () => {
  const releaseVelocity = await loadReleaseVelocity();
  const v = releaseVelocity([
    { t: 0, x: 0, y: 0 },
    { t: 100, x: 10, y: 0 },
  ]);
  assert.ok(Math.hypot(v.vx, v.vy) < 200, '10px over 100ms is a put-down, not a flick');
});