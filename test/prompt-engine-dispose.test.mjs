import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPromptEngine } from '../packages/soulmate-core/runtime/prompt-engine.mjs';
import { resolveSoulmateHome } from '../packages/soulmate-core/state.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('prompt engine: dispose kills the detached think-watch', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'soulmate-pe-'));
  try {
    const home = resolveSoulmateHome(dir);
    const make = () => createPromptEngine({ home, warn: () => {}, sessionController: () => null, pushEvent: () => {} });

    // control: a live watch releases the thinking latch after the quiet window
    const live = make();
    live.setSessionId('s-live');
    live.touchPetActivity();
    assert.equal(live.petThinking, true);

    const dead = make();
    dead.setSessionId('s-dead');
    dead.touchPetActivity();
    dead.dispose();
    dead.touchPetActivity(); // scheduling after teardown must be a no-op

    await sleep(2200);
    assert.equal(live.petTurnPhase, 'done', 'control: the quiet window released the latch');
    assert.equal(dead.petTurnPhase, 'thinking', 'disposed watch must not flip pet state after teardown');
    assert.equal(dead.petThinking, true);
    live.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});