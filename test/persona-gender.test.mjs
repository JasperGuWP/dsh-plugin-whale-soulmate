import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../index.js';
import {
  PRESETS, PRESETS_FEMALE, PRESETS_MALE, presetsForGender,
  blankPresetId, normalizeGender, companionPronoun,
  appearanceForGender, evolvePersona,
} from '../packages/soulmate-core/persona.mjs';
import {
  DEFAULT_CONFIG, DEFAULT_INVARIANTS, resolveSoulmateHome, loadConfig, dumpSimpleYaml, saveConfigAuto,
} from '../packages/soulmate-core/state.mjs';
import { ensurePersonaFiles, loadInvariants } from '../packages/soulmate-core/layers/persona-layer.mjs';

async function withHome(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'soulmate-gender-'));
  try {
    return await fn(resolveSoulmateHome(dir), dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Minimal Cordis mock for onboard / evolve / state routes (same shape as plugin-integration). */
function createMockCtx(dir) {
  const routes = new Map();
  const disposers = [];
  const mockCtx = {
    tools: { register() { return () => {}; } },
    systemPrompt: {
      section() { return () => {}; },
      context() { return () => {}; },
    },
    effect(fn) {
      const dispose = fn();
      if (typeof dispose === 'function') disposers.push(dispose);
    },
    provide() {},
    set(serviceName, val) { mockCtx[serviceName] = val; },
    get(serviceName) {
      if (serviceName === 'dshHomePath') return (...segs) => join(dir, ...segs);
      if (serviceName === 'webServer') return mockCtx._webServer();
      return mockCtx[serviceName];
    },
    inject(deps, callback) {
      const webCtx = { ...mockCtx, webServer: mockCtx._webServer(), get: mockCtx.get };
      const inner = callback(webCtx);
      return typeof inner === 'function' ? inner : () => {};
    },
    _webServer() {
      return {
        registerRoute(method, path, handler) {
          routes.set(`${method} ${path}`, handler);
          return () => routes.delete(`${method} ${path}`);
        },
      };
    },
  };
  const dispose = () => { while (disposers.length) disposers.pop()(); };
  return { mockCtx, routes, dispose };
}

const body = (out) => JSON.parse(out.body);
const GET = (routes, path) => routes.get(`GET ${path}`)({ method: 'GET', url: path });
const POST = (routes, path, payload) =>
  routes.get(`POST ${path}`)({ method: 'POST', url: path, body: payload });

test('presets: female has yandere + blank; male has five including blank-custom-male', () => {
  assert.ok(PRESETS_FEMALE['yandere-claim']);
  assert.equal(PRESETS_FEMALE['yandere-claim'].name, '偏执占有你');
  assert.ok(PRESETS_MALE['quiet-guardian']);
  assert.ok(PRESETS_MALE['cool-senpai']);
  assert.ok(PRESETS_MALE['clingy-cyclone']);
  assert.ok(PRESETS_MALE['dark-hunter']);
  assert.ok(PRESETS_MALE['blank-custom-male']);
  assert.equal(Object.keys(PRESETS_FEMALE).length, 5);
  assert.equal(Object.keys(PRESETS_MALE).length, 5);
  assert.equal(Object.keys(PRESETS).length, 10);
});

test('presetsForGender filters; blank ids; pronouns', () => {
  assert.equal(presetsForGender('male').every((p) => p.gender === 'male'), true);
  assert.equal(blankPresetId('male'), 'blank-custom-male');
  assert.equal(normalizeGender(undefined), null);
  assert.equal(companionPronoun('female').third, '她');
  assert.equal(companionPronoun('male').third, '他');
  assert.match(companionPronoun(null).presenceTitle, /我此刻记得/);
});

test('defaults: gender null, neutral form, protagonist invariant present', () => {
  assert.equal(DEFAULT_CONFIG.persona.gender, null);
  assert.equal(DEFAULT_CONFIG.appearance.formPreset, 'astral-orb');
  assert.equal(DEFAULT_CONFIG.appearance.accessories.ironBowl, false);
  assert.equal(DEFAULT_CONFIG.appearance.accessories.quantumHalo, false);
  assert.ok(DEFAULT_INVARIANTS.values.some((v) => /主人翁第一人称/.test(v)));
  assert.ok(DEFAULT_INVARIANTS.boundaries.some((b) => /换性格|演一下/.test(b)));
});

test('loadConfig: onboarding done without gender → backfill female once', async () => {
  await withHome(async (home) => {
    await writeFile(
      home.configPath,
      JSON.stringify({
        onboardingCompleted: true,
        persona: { name: '大肥鱼', preset: 'rice-whale' },
      }, null, 2),
      'utf8',
    );
    const cfg = await loadConfig(home);
    assert.equal(cfg.persona.gender, 'female');
    const disk = JSON.parse(await readFile(home.configPath, 'utf8'));
    assert.equal(disk.persona.gender, 'female');
    const again = await loadConfig(home);
    assert.equal(again.persona.gender, 'female');
  });
});

test('loadConfig: fresh install keeps gender null', async () => {
  await withHome(async (home) => {
    const cfg = await loadConfig(home);
    assert.equal(cfg.onboardingCompleted, false);
    assert.equal(cfg.persona.gender, null);
  });
});

test('ensurePersonaFiles: append protagonist invariants without clobbering user yaml', async () => {
  await withHome(async (home) => {
    const legacy = {
      values: ['用户自定义价值'],
      boundaries: ['用户自定义边界'],
      crisis: DEFAULT_INVARIANTS.crisis,
    };
    await mkdir(join(home.rootDir, 'persona'), { recursive: true });
    await writeFile(home.invariantsPath, dumpSimpleYaml(legacy), 'utf8');
    await ensurePersonaFiles(home);
    const inv = await loadInvariants(home);
    assert.ok(inv.values.includes('用户自定义价值'));
    assert.ok(inv.boundaries.includes('用户自定义边界'));
    assert.ok(inv.values.some((v) => /主人翁第一人称/.test(v)));
    assert.ok(inv.boundaries.some((b) => /演一下/.test(b)));
    const raw = await readFile(home.invariantsPath, 'utf8');
    assert.match(raw, /用户自定义价值/);
    assert.match(raw, /主人翁第一人称/);
  });
});

test('appearanceForGender: female whale-girl + sprite; male male-sprite; keep custom upload', () => {
  const female = appearanceForGender('female', { customSpriteUrl: '/dsh-soulmate/api/sprite' });
  assert.equal(female.formPreset, 'whale-girl');
  assert.equal(female.customSpriteUrl, '/dsh-soulmate/api/sprite');

  const male = appearanceForGender('male', { customSpriteUrl: '/dsh-soulmate/api/sprite' });
  assert.match(male.customSpriteUrl, /\/dsh-soulmate\/api\/sprite-male/);
  assert.ok(male.formPreset);

  const kept = appearanceForGender('male', { customSpriteUrl: 'https://cdn.example/my.png', formPreset: 'neko-hacker' });
  assert.equal(kept.customSpriteUrl, undefined, 'must not overwrite user-uploaded sprite');
  assert.ok(kept.formPreset);
});

test('evolvePersona: gender switch without matching preset falls back to blank-custom-male', async () => {
  await withHome(async (home) => {
    await saveConfigAuto(home, {
      onboardingCompleted: true,
      persona: {
        gender: 'female',
        preset: 'rice-whale',
        selfRef: '本鱼',
        callUser: '搭档',
        name: '大肥鱼',
      },
      appearance: {
        formPreset: 'whale-girl',
        customSpriteUrl: '/dsh-soulmate/api/sprite',
      },
    });
    const next = await evolvePersona(home, { mode: 'user_customize', gender: 'male' });
    assert.equal(next.persona.gender, 'male');
    assert.equal(next.persona.preset, 'blank-custom-male');
    assert.match(next.appearance.customSpriteUrl, /sprite-male/);
  });
});

test('evolvePersona: explicit gender+preset mismatch throws', async () => {
  await withHome(async (home) => {
    await assert.rejects(
      () => evolvePersona(home, { mode: 'user_customize', gender: 'female', preset: 'quiet-guardian' }),
      /preset does not match gender/,
    );
  });
});

test('onboard: male+quiet-guardian ok; female+quiet-guardian fails; snapshot presets carry gender', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'soulmate-gender-api-'));
  try {
    const { mockCtx, routes, dispose } = createMockCtx(dir);
    apply(mockCtx, {});

    const state = body(await GET(routes, '/dsh-soulmate/api/state'));
    assert.equal(state.presets.length, 10);
    assert.ok(state.presets.every((p) => p.gender === 'female' || p.gender === 'male'));

    const bad = await POST(routes, '/dsh-soulmate/api/onboard', {
      gender: 'female',
      preset: 'quiet-guardian',
    });
    assert.equal(bad.status, 400);
    const badBody = body(bad);
    assert.equal(badBody.ok, false);
    assert.match(badBody.error, /preset does not match gender|gender/i);

    const ok = body(await POST(routes, '/dsh-soulmate/api/onboard', {
      gender: 'male',
      preset: 'quiet-guardian',
      callUser: '搭档',
    }));
    assert.equal(ok.ok, true);
    assert.equal(ok.config.persona.gender, 'male');
    assert.equal(ok.config.persona.preset, 'quiet-guardian');
    assert.equal(ok.config.onboardingCompleted, true);
    assert.match(ok.config.appearance.customSpriteUrl, /sprite-male/);

    dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('persona-evolve API: switch gender from female preset → blank-custom-male', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'soulmate-gender-ev-'));
  try {
    const { mockCtx, routes, dispose } = createMockCtx(dir);
    apply(mockCtx, {});

    const onboarded = body(await POST(routes, '/dsh-soulmate/api/onboard', {
      gender: 'female',
      preset: 'gentle-echo',
      name: '小汐',
    }));
    assert.equal(onboarded.ok, true);
    assert.equal(onboarded.config.persona.gender, 'female');

    const ev = body(await POST(routes, '/dsh-soulmate/api/persona-evolve', {
      mode: 'user_customize',
      gender: 'male',
    }));
    assert.equal(ev.ok, true);
    assert.equal(ev.config.persona.gender, 'male');
    assert.equal(ev.config.persona.preset, 'blank-custom-male');

    dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
