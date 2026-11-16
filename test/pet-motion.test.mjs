import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

/**
 * In-viewport locomotion (PRD §5.3 / §5.6):
 *   - plan clamps distance/target, forces direction at edges, respects the move threshold
 *   - once-walk distance uses the real video duration; PNG fallback uses dwell estimate
 *   - step interpolates with lead/tail stillness windows from video.currentTime
 *   - a pending plan waits for duration, falls back after 3s; loop videos never drive position
 *   - stop/commit/clamp and reduced-motion / minimized / dragging guards
 */

async function loadMotion() {
  const src = await readFile(new URL('../browser/pet-motion.mjs', import.meta.url), 'utf8');
  const sandbox = { module: { exports: {} }, exports: {}, console, Math, Object, Array, Number, String, JSON, isFinite };
  vm.runInNewContext(src, sandbox, { filename: 'pet-motion.mjs' });
  return sandbox.module.exports.createPetMotion;
}

function fakeRoot(left = 900, top = 600) {
  const rect = { left, top };
  return {
    style: {},
    getBoundingClientRect() { return { left: rect.left, top: rect.top } },
    _rect: rect,
  };
}

function env(overrides = {}) {
  const root = overrides.root || fakeRoot();
  const state = {
    dragging: false, minimized: false, reduced: false,
    video: null, wantVideo: false, fallbacks: 0,
    W: 1280, H: 800, size: 148,
  };
  const deps = {
    root: () => root,
    viewport: () => ({ width: state.W, height: state.H }),
    size: () => state.size,
    isDragging: () => state.dragging,
    isMinimized: () => state.minimized,
    reducedMotion: () => state.reduced,
    video: () => state.video,
    wantVideo: () => state.wantVideo,
    onFallback: () => { state.fallbacks++ },
  };
  return { root, state, deps };
}

const left = (root) => parseFloat(root.style.left);

test('motion: PNG walk distance = speed × dwell, clamped to [60, W×0.6]', async () => {
  const createPetMotion = await loadMotion();
  const { root, deps } = env({ root: fakeRoot(640, 600) });
  const motion = createPetMotion(deps);
  // speed 40 × 4s = 160px; start 640 → target 800 or 480 depending on random dir
  const plan = motion.plan({ speedPxSec: 40, dwellMs: 4000 });
  assert.ok(plan, 'plan succeeds mid-viewport');
  assert.ok([1, -1].includes(plan.facing));
  motion.step(0);
  motion.step(4000); // u=1 → commit
  const final = left(root);
  assert.equal(Math.abs(final - 640), 160, 'travelled speed×dwell = 160px');
  assert.equal(motion.active(), false, 'committed at the end');
});

test('motion: minimum distance floor is 60px even for tiny dwell', async () => {
  const createPetMotion = await loadMotion();
  const { root, deps } = env({ root: fakeRoot(640, 600) });
  const motion = createPetMotion(deps);
  motion.plan({ speedPxSec: 1, dwellMs: 10 }); // 0.01px → floored to 60
  motion.step(0); motion.step(10);
  assert.equal(Math.abs(left(root) - 640), 60);
});

test('motion: distance capped at 60% of viewport width', async () => {
  const createPetMotion = await loadMotion();
  const { root, deps } = env({ root: fakeRoot(100, 600) });
  const motion = createPetMotion(deps);
  motion.plan({ speedPxSec: 1000, dwellMs: 10000 }); // huge → capped at 0.6×1280=768
  motion.step(0); motion.step(10000);
  assert.ok(Math.abs(left(root) - 100) <= 768 + 0.001, 'capped at W×0.6');
});

test('motion: target clamped inside [8, W−size−8]', async () => {
  const createPetMotion = await loadMotion();
  const { root, deps } = env({ root: fakeRoot(1200, 600) }); // near right edge
  const motion = createPetMotion(deps);
  const plan = motion.plan({ speedPxSec: 40, dwellMs: 8000 });
  assert.ok(plan);
  motion.step(0); motion.step(8000);
  const final = left(root);
  assert.ok(final >= 8 && final <= 1280 - 148 - 8, `final ${final} within bounds`);
});

test('motion: cornered with no room → returns false (no walk)', async () => {
  const createPetMotion = await loadMotion();
  // tiny viewport so both directions are below the 24px threshold
  const { root, state, deps } = env({ root: fakeRoot(8, 600) });
  state.W = 170; state.size = 148; // usable range [8, 14] → 6px wide
  const motion = createPetMotion(deps);
  const plan = motion.plan({ speedPxSec: 40, dwellMs: 4000 });
  assert.equal(plan, false, 'nowhere to go');
  assert.equal(motion.active(), false);
});

test('motion: reduced-motion / minimized / dragging all refuse to plan', async () => {
  const createPetMotion = await loadMotion();
  for (const key of ['reduced', 'minimized', 'dragging']) {
    const { state, deps } = env();
    state[key] = true;
    const motion = createPetMotion(deps);
    assert.equal(motion.plan({ speedPxSec: 40, dwellMs: 4000 }), false, `${key} blocks plan`);
  }
});

test('motion: once-walk uses real video duration for distance', async () => {
  const createPetMotion = await loadMotion();
  const { root, state, deps } = env({ root: fakeRoot(400, 600) });
  state.wantVideo = true;
  state.video = { duration: 5, currentTime: 0 };
  const motion = createPetMotion(deps);
  const plan = motion.plan({ speedPxSec: 40, dwellMs: 4000, leadSec: 0, tailSec: 0 });
  assert.ok(plan);
  assert.equal(motion.pending(), false, 'duration readable → not pending');
  // drive currentTime to the end → u=1 → commit at speed×duration = 200px
  state.video.currentTime = 5;
  motion.step(0);
  assert.equal(Math.abs(left(root) - 400), 200, 'distance = speed × video.duration');
});

test('motion: lead/tail stillness windows hold position at the ends', async () => {
  const createPetMotion = await loadMotion();
  const { root, state, deps } = env({ root: fakeRoot(400, 600) });
  state.wantVideo = true;
  state.video = { duration: 6, currentTime: 0 };
  const motion = createPetMotion(deps);
  motion.plan({ speedPxSec: 40, dwellMs: 4000, leadSec: 1, tailSec: 1 });
  const start = left(root) || 400;
  state.video.currentTime = 0.5; motion.step(0);
  assert.equal(left(root), 400, 'within leadSec → stays at start');
  state.video.currentTime = 3; motion.step(16);
  const mid = left(root);
  assert.ok(Math.abs(mid - 400) > 0 && Math.abs(mid - 400) < 240, 'mid-window interpolates');
  state.video.currentTime = 5.5; motion.step(32);
  assert.equal(Math.abs(left(root) - 400), 240, 'within tailSec → at target (speed×6)');
  void start;
});

test('motion: pending plan waits for duration then locks the target', async () => {
  const createPetMotion = await loadMotion();
  const { root, state, deps } = env({ root: fakeRoot(400, 600) });
  state.wantVideo = true;
  state.video = null; // not ready yet
  const motion = createPetMotion(deps);
  motion.plan({ speedPxSec: 40, dwellMs: 4000 });
  assert.equal(motion.pending(), true);
  motion.step(0);
  assert.equal(left(root) || 400, 400, 'pending → no movement');
  // video becomes ready with duration 5
  state.video = { duration: 5, currentTime: 0 };
  motion.step(16);
  assert.equal(motion.pending(), false, 'locked once duration readable');
  state.video.currentTime = 5;
  motion.step(32);
  assert.equal(Math.abs(left(root) - 400), 200, 'real-distance target after ready');
});

test('motion: pending > 3s without a ready video → onFallback (PNG re-plan)', async () => {
  const createPetMotion = await loadMotion();
  const { state, deps } = env();
  state.wantVideo = true;
  state.video = null;
  const motion = createPetMotion(deps);
  motion.plan({ speedPxSec: 40, dwellMs: 4000 });
  motion.step(0);
  motion.step(2000);
  assert.equal(state.fallbacks, 0, 'not yet timed out');
  motion.step(3500);
  assert.equal(state.fallbacks, 1, '3s watchdog fired onFallback');
  assert.equal(motion.active(), false, 'motion stopped; widget owns the re-plan');
});

test('motion: loop walk video is never used for position (time progress instead)', async () => {
  const createPetMotion = await loadMotion();
  const { root, state, deps } = env({ root: fakeRoot(400, 600) });
  // wantVideo false models a loop walk (rig only enables once walks)
  state.wantVideo = false;
  state.video = { duration: 5, currentTime: 0 };
  const motion = createPetMotion(deps);
  motion.plan({ speedPxSec: 40, dwellMs: 4000 });
  // even though a video exists, progress must come from elapsed time, not currentTime
  state.video.currentTime = 5; // would jump to end if (wrongly) read
  motion.step(0);
  assert.equal(left(root), 400, 't=0 → still at start despite currentTime=5');
  motion.step(2000);
  assert.equal(Math.abs(left(root) - 400), 80, 'half of dwell → half of 160px');
});

test('motion: stop invalidates; further steps do nothing', async () => {
  const createPetMotion = await loadMotion();
  const { root, deps } = env({ root: fakeRoot(400, 600) });
  const motion = createPetMotion(deps);
  motion.plan({ speedPxSec: 40, dwellMs: 4000 });
  motion.step(1000);
  const mid = left(root);
  motion.stop();
  motion.step(2000); motion.step(4000);
  assert.equal(left(root), mid, 'stopped walk does not advance');
  assert.equal(motion.active(), false);
});

test('motion: commit jumps straight to the target', async () => {
  const createPetMotion = await loadMotion();
  const { root, deps } = env({ root: fakeRoot(400, 600) });
  const motion = createPetMotion(deps);
  motion.plan({ speedPxSec: 40, dwellMs: 4000 });
  motion.commit();
  assert.equal(Math.abs(left(root) - 400), 160, 'committed to full distance');
  assert.equal(motion.active(), false);
});

test('motion: dragging mid-walk stops it', async () => {
  const createPetMotion = await loadMotion();
  const { root, state, deps } = env({ root: fakeRoot(400, 600) });
  const motion = createPetMotion(deps);
  motion.plan({ speedPxSec: 40, dwellMs: 4000 });
  motion.step(1000);
  state.dragging = true;
  motion.step(2000);
  assert.equal(motion.active(), false, 'drag cancels the walk');
});

test('motion: clamp keeps an anchored pet inside the viewport on resize', async () => {
  const createPetMotion = await loadMotion();
  const { root, state, deps } = env({ root: fakeRoot(1200, 700) });
  const motion = createPetMotion(deps);
  motion.plan({ speedPxSec: 40, dwellMs: 4000 });
  motion.commit(); // now left/top anchored
  state.W = 800; state.H = 500;
  root._rect.left = 1200; root._rect.top = 700;
  motion.clamp();
  assert.ok(left(root) <= 800 - 148 - 8, 'clamped horizontally');
  assert.ok(parseFloat(root.style.top) <= 500 - 148 - 8, 'clamped vertically');
});

test('motion: clamp leaves a right/bottom-anchored pet untouched', async () => {
  const createPetMotion = await loadMotion();
  const { root, deps } = env();
  const motion = createPetMotion(deps);
  motion.clamp(); // no style.left set yet
  assert.equal(root.style.left, undefined, 'unanchored pet not repositioned');
});

test('motion: facing follows travel direction', async () => {
  const createPetMotion = await loadMotion();
  const { root, deps } = env({ root: fakeRoot(8, 600) }); // hard left edge → must go right
  const motion = createPetMotion(deps);
  const plan = motion.plan({ speedPxSec: 40, dwellMs: 4000 });
  assert.equal(plan.facing, 1, 'left edge forces rightward → mirror');
  assert.equal(root.style.left, undefined, 'plan alone does not move the pet');
});
