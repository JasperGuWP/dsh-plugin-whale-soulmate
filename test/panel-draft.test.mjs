import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { petRoutes } from '../packages/soulmate-core/routes/pet-routes.mjs';

/** panel-draft.mjs is a bundler module (CJS body in an .mjs file) — run it with a tiny shim. */
async function loadDraftModule() {
  const source = await readFile(new URL('../browser/panel-draft.mjs', import.meta.url), 'utf8');
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module,
    exports: module.exports,
    require: (id) => {
      if (String(id).endsWith('surf-schedule.mjs')) {
        return { resolveSurfIntervalMinutes: () => 360, clampSurfMaxPick: (pick) => pick };
      }
      if (String(id).endsWith('util.mjs')) {
        return {
          DEFAULT_SPRITE_URL: '/default.png',
          clampNum: (n, lo, hi) => Math.min(hi, Math.max(lo, Number.isFinite(n) ? n : lo)),
        };
      }
      throw new Error(`unexpected require ${id}`);
    },
    console,
  }, { filename: 'panel-draft.mjs' });
  return module.exports;
}

test('draftFromSummary: keeps every pet field (window switch used to reset on reload)', async () => {
  const { draftFromSummary } = await loadDraftModule();
  const draft = draftFromSummary({
    config: {
      persona: { gender: 'male' },
      pet: {
        enabled: true,
        sizePx: 200,
        windowEnabled: true,
        windowElectronPath: 'C:/electron/electron.exe',
        physics: { gravity: 900, restitution: 0.5, groundFriction: 2, throwPower: 1.5 },
        ambientWalk: false,
        ambientWalkAfterSec: 30,
        ambientWalkChance: 0.2,
      },
    },
  });
  assert.equal(draft.pet.windowEnabled, true);
  assert.equal(draft.pet.windowElectronPath, 'C:/electron/electron.exe');
  assert.equal(JSON.stringify(draft.pet.physics), JSON.stringify({ gravity: 900, restitution: 0.5, groundFriction: 2, throwPower: 1.5 }));
  assert.equal(draft.pet.ambientWalk, false);
  assert.equal(draft.pet.ambientWalkAfterSec, 30);
  assert.equal(draft.pet.ambientWalkChance, 0.2);
});

test('draftFromSummary: pet defaults are window-ON (0.2.201), walk-on, default physics', async () => {
  const { draftFromSummary } = await loadDraftModule();
  const draft = draftFromSummary({ config: { persona: { gender: 'female' }, pet: {} } });
  assert.equal(draft.pet.windowEnabled, true);
  assert.equal(draft.pet.windowElectronPath, '');
  assert.equal(JSON.stringify(draft.pet.physics), JSON.stringify({ gravity: 1400, restitution: 0.78, groundFriction: 2.5, throwPower: 1 }));
  assert.equal(draft.pet.ambientWalk, true);
  assert.equal(draft.pet.ambientWalkAfterSec, 15);
  assert.equal(draft.pet.ambientWalkChance, 0.35);
  assert.equal(draft.pet.skin, 'hanfu');
});

test('pet-window route: reports runtime status and degrades to unavailable', async () => {
  const [route] = petRoutes({ petWindowStatus: () => ({ enabled: true, running: false, electronExists: false }) });
  const out = await route.handler({});
  assert.equal(out.status, 200);
  assert.deepEqual(JSON.parse(out.body), { ok: true, available: true, enabled: true, running: false, electronExists: false });

  const [none] = petRoutes({});
  const out2 = await none.handler({});
  assert.deepEqual(JSON.parse(out2.body), { ok: true, available: false });
});
test('draftFromSummary: absent pet/proactive/bili blocks never erase default-ON switches (0.2.201+ regression)', async () => {
  const { draftFromSummary } = await loadDraftModule();
  // Empty payload — the exact shape a fresh install / partial summary can produce.
  const draft = draftFromSummary({ config: {} });
  assert.equal(draft.pet.enabled, true, 'pet animation default ON survives an absent pet block');
  assert.equal(draft.pet.windowEnabled, true, 'window pet default ON survives an absent pet block');
  assert.equal(draft.pet.sizePx, 180, 'size default matches state.mjs (was stale 148)');
  assert.equal(draft.proactive.intentEnabled, true, 'intent default ON survives an absent proactive block');
  assert.equal(draft.extensions.biliAutoSurfEnabled, true);
  assert.equal(draft.extensions.biliAutoSurfDeepWatch, true);
  // Explicit false is still respected — the user's off choice must stick.
  const off = draftFromSummary({ config: { pet: { enabled: false, windowEnabled: false }, proactive: { intentEnabled: false }, extensions: { biliAutoSurfEnabled: false } } });
  assert.equal(off.pet.enabled, false);
  assert.equal(off.pet.windowEnabled, false);
  assert.equal(off.proactive.intentEnabled, false);
  assert.equal(off.extensions.biliAutoSurfEnabled, false);
});
