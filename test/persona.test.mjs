import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, mkdir, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveSoulmateHome, loadConfig, saveConfigAuto, DEFAULT_CONFIG } from '../packages/soulmate-core/state.mjs';
import {
  PRESETS,
  AVATAR_FORMS,
  getDisplayName,
  getNotebookTitles,
  computeBondStage,
  loadSoulmateState,
  applyInteraction,
  evolvePersona,
  resetPersona,
  listPersonaSnapshots,
  restorePersonaSnapshot,
  buildPersonaSystemPrompt,
  buildDriftAnchor,
  isDeepSeekOffPeak,
} from '../packages/soulmate-core/persona.mjs';

async function withHome(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'soulmate-persona-'));
  try {
    return await fn(resolveSoulmateHome(dir), dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const exists = (p) => stat(p).then(() => true, () => false);

test('persona: dynamic notebook title uses 鱼 by default and custom name when set', () => {
  assert.equal(getDisplayName({ name: '' }), 'soulmate');
  assert.equal(getDisplayName(undefined), 'soulmate');
  assert.equal(getNotebookTitles({ name: '', callUser: '' }).innerTitle, '《soulmate的小本本》');
  assert.equal(getNotebookTitles({ name: '小汐', callUser: '阿澈' }).innerTitle, '《小汐的小本本》');
  assert.equal(getNotebookTitles({ name: '小汐', callUser: '阿澈' }).publicTitle, '《给阿澈的信》');
  assert.equal(getNotebookTitles(null).publicTitle, '《给你的信》');
});

test('persona: bond progression, sulking after 3 days silence, and feed recovery', async () => {
  await withHome(async (home) => {
    const s0 = await loadSoulmateState(home, Date.parse('2026-11-01T10:00:00Z'));
    assert.equal(s0.mood, 'happy');
    const s1 = await loadSoulmateState(home, Date.parse('2026-11-05T10:00:00Z'));
    assert.equal(s1.mood, 'sulking');
    assert.equal(s1.activity, 'corner_sulking');
    const s2 = await applyInteraction(home, 'feed', Date.parse('2026-11-05T10:05:00Z'));
    assert.equal(s2.mood, 'happy');
    assert.ok(s2.affinity > s0.affinity);

    assert.equal(computeBondStage(30).canReadInnerDiary, true);
    assert.equal(computeBondStage(220).canReadInnerDiary, true);

    const prompt = buildPersonaSystemPrompt(
      { persona: { name: '小汐', callUser: '阿澈', preset: 'rice-whale', traits: { tsundere: 85, brevity: 80 } } },
      s2,
    );
    assert.match(prompt, /《小汐的小本本》/);
    assert.match(prompt, /绝不说“作为一个AI”/);
  });
});

test('persona: PRESETS match spec', () => {
  assert.deepEqual(Object.keys(PRESETS).sort(), [
    'blank-custom',
    'blank-custom-male',
    'clingy-cyclone',
    'cool-senpai',
    'dark-hunter',
    'geek-partner',
    'gentle-echo',
    'quiet-guardian',
    'rice-whale',
    'yandere-claim',
  ]);
  const rw = PRESETS['rice-whale'];
  assert.equal(rw.title, '🍚 傲娇干饭鲸鱼');
  assert.equal(rw.defaultSelfRef, '本鱼');
  assert.equal(rw.defaultCallUser, '搭档');
  assert.deepEqual(rw.traits, { tsundere: 80, clinginess: 60, sassiness: 65, curiosity: 70, brevity: 65 });
  assert.ok(rw.description.length > 40);
  assert.ok(rw.catchphrases.length >= 3);
  assert.equal(PRESETS['gentle-echo'].title, '🌙 温柔深海守望者');
  assert.equal(PRESETS['gentle-echo'].defaultCallUser, '主人');
  assert.deepEqual(PRESETS['gentle-echo'].traits, { tsundere: 15, clinginess: 75, sassiness: 10, curiosity: 65, brevity: 50 });
  assert.equal(PRESETS['geek-partner'].title, '⚡ 毒舌极客副驾');
  assert.equal(PRESETS['geek-partner'].defaultCallUser, 'Boss');
  assert.deepEqual(PRESETS['geek-partner'].traits, { tsundere: 55, clinginess: 35, sassiness: 85, curiosity: 80, brevity: 85 });
  assert.equal(PRESETS['blank-custom'].title, '✨ 纯白自塑灵魂');
  assert.equal(PRESETS['blank-custom'].defaultCallUser, '你');
  assert.deepEqual(PRESETS['blank-custom'].traits, { tsundere: 50, clinginess: 50, sassiness: 50, curiosity: 50, brevity: 50 });
  for (const p of Object.values(PRESETS)) {
    assert.ok(['female', 'male'].includes(p.gender), `${p.id} must have gender`);
    assert.equal(
      p.defaultSelfRef === '我' || p.id === 'rice-whale' || p.id === 'yandere-claim',
      true,
      `${p.id} unexpected defaultSelfRef`,
    );
  }
});

test('persona: AVATAR_FORMS', () => {
  assert.deepEqual(Object.keys(AVATAR_FORMS).sort(), ['astral-orb', 'cyber-muse', 'neko-hacker', 'whale-girl']);
  assert.equal(AVATAR_FORMS['whale-girl'].name, '深海小鲸鱼娘');
  assert.equal(AVATAR_FORMS['cyber-muse'].name, '全息赛博精灵');
  assert.equal(AVATAR_FORMS['neko-hacker'].name, '黑客猫娘');
  assert.equal(AVATAR_FORMS['astral-orb'].name, '星体浮游核心');
});

test('persona: all five bond stage boundaries', () => {
  const cases = [
    [0, 1, '初遇室友', true, ['desk', 'bookshelf']],
    [49, 1, '初遇室友', true, ['desk', 'bookshelf']],
    [50, 2, '投喂饭搭子', true, ['desk', 'bookshelf', 'rice_bowl']],
    [199, 2, '投喂饭搭子', true, ['desk', 'bookshelf', 'rice_bowl']],
    [200, 3, '默契副驾', true, ['desk', 'bookshelf', 'rice_bowl', 'inner_diary']],
    [499, 3, '默契副驾', true, ['desk', 'bookshelf', 'rice_bowl', 'inner_diary']],
    [500, 4, '深海知己', true, ['desk', 'bookshelf', 'rice_bowl', 'inner_diary', 'star_window', 'memento_wall']],
    [899, 4, '深海知己', true, ['desk', 'bookshelf', 'rice_bowl', 'inner_diary', 'star_window', 'memento_wall']],
    [900, 5, '灵魂伴侣 (Soulmate)', true, ['desk', 'bookshelf', 'rice_bowl', 'inner_diary', 'star_window', 'memento_wall', 'neural_crown']],
    [5000, 5, '灵魂伴侣 (Soulmate)', true, ['desk', 'bookshelf', 'rice_bowl', 'inner_diary', 'star_window', 'memento_wall', 'neural_crown']],
  ];
  for (const [affinity, level, title, canRead, decor] of cases) {
    assert.deepEqual(computeBondStage(affinity), { level, title, canReadInnerDiary: canRead, unlockedDecor: decor }, `affinity ${affinity}`);
  }
});

test('persona: default state is persisted and below 3 days does not sulk', async () => {
  await withHome(async (home) => {
    const t0 = Date.parse('2026-11-01T10:00:00Z');
    const s = await loadSoulmateState(home, t0);
    assert.deepEqual(s, {
      mood: 'happy',
      energy: 85,
      affinity: 20,
      streakDays: 1,
      lastInteractionAt: new Date(t0).toISOString(),
      activity: 'reading',
      interactionCount: 0,
    });
    assert.deepEqual(JSON.parse(await readFile(home.statePath, 'utf8')), s);
    const s2 = await loadSoulmateState(home, t0 + 3 * 86400_000 - 1);
    assert.equal(s2.mood, 'happy');
    const s3 = await loadSoulmateState(home, t0 + 3 * 86400_000);
    assert.equal(s3.mood, 'sulking');
  });
});

test('persona: applyInteraction actions', async () => {
  await withHome(async (home) => {
    const t0 = Date.parse('2026-11-01T10:00:00Z');
    await loadSoulmateState(home, t0);

    const fed = await applyInteraction(home, 'feed', t0 + 1000);
    assert.equal(fed.energy, 100); // 85 + 25 capped
    assert.equal(fed.affinity, 30);
    assert.equal(fed.activity, 'eating_rice');
    assert.equal(fed.interactionCount, 1);

    const tapped = await applyInteraction(home, 'tap', t0 + 1500);
    assert.equal(tapped.affinity, 32);
    assert.equal(tapped.mood, 'happy');
    assert.equal(tapped.activity, 'light_nudge');

    const nuzzled = await applyInteraction(home, 'nuzzle', t0 + 1800);
    assert.equal(nuzzled.affinity, 37);
    assert.equal(nuzzled.activity, 'nuzzling');

    const patted = await applyInteraction(home, 'pat', t0 + 2000);
    assert.equal(patted.affinity, 45);
    assert.equal(patted.mood, 'happy');
    assert.equal(patted.activity, 'happy_spin');

    const chatted = await applyInteraction(home, 'chat', t0 + 3000);
    assert.equal(chatted.affinity, 50);
    assert.equal(chatted.energy, 97);
    assert.equal(chatted.mood, 'focused');

    const worked = await applyInteraction(home, 'work_assist', t0 + 4000);
    assert.equal(worked.affinity, 55);
    assert.equal(worked.energy, 94);
    assert.equal(worked.mood, 'focused');

    const slept = await applyInteraction(home, 'sleep', t0 + 5000);
    assert.equal(slept.energy, 100);
    assert.equal(slept.mood, 'sleepy');
    assert.equal(slept.activity, 'sleeping');

    // energy floor at 10
    await writeFile(home.statePath, JSON.stringify({ ...slept, energy: 11 }));
    const low = await applyInteraction(home, 'chat', t0 + 6000);
    assert.equal(low.energy, 10);

    await assert.rejects(() => applyInteraction(home, 'dance', t0 + 7000), /unknown interaction/);
  });
});

test('persona: stampPresence=false (video watch) keeps mood but never counts as the user present', async () => {
  await withHome(async (home) => {
    const t0 = Date.parse('2026-11-01T10:00:00Z');
    await loadSoulmateState(home, t0);
    const watched = await applyInteraction(home, 'chat', t0 + 3_600_000, { stampPresence: false });
    assert.equal(watched.affinity, 25); // the action itself still applies
    assert.equal(watched.interactionCount, 0);
    assert.equal(watched.lastInteractionAt, new Date(t0).toISOString()); // presence unchanged
  });
});

test('persona: chat while sulking returns to happy; streak counts consecutive days', async () => {
  await withHome(async (home) => {
    const t0 = Date.parse('2026-11-01T10:00:00Z');
    await loadSoulmateState(home, t0);
    const d2 = await applyInteraction(home, 'pat', t0 + 86400_000);
    assert.equal(d2.streakDays, 2);
    const d3 = await applyInteraction(home, 'pat', t0 + 2 * 86400_000);
    assert.equal(d3.streakDays, 3);
    const back = await applyInteraction(home, 'chat', t0 + 8 * 86400_000);
    assert.equal(back.mood, 'happy');
    assert.equal(back.streakDays, 1);
  });
});

test('persona: applyInteraction payload setName / setCallUser updates config.persona', async () => {
  await withHome(async (home) => {
    await applyInteraction(home, 'chat', Date.now(), { setName: ' 小汐 ', setCallUser: '舰长' });
    const cfg = await loadConfig(home);
    assert.equal(cfg.persona.name, '小汐');
    assert.equal(cfg.persona.callUser, '舰长');
    await applyInteraction(home, 'pat', Date.now(), { setName: '' });
    assert.equal((await loadConfig(home)).persona.name, '');
    assert.equal((await loadConfig(home)).persona.callUser, '舰长');
  });
});

test('persona: evolvePersona user_customize', async () => {
  await withHome(async (home) => {
    const cfg = await evolvePersona(home, {
      mode: 'user_customize',
      name: '小汐',
      callUser: '舰长',
      selfRef: '小汐',
      customBody: '说话再犀利一点',
      traits: { sassiness: 120, tsundere: -5 },
      allowSelfEvolution: false,
    });
    assert.equal(cfg.persona.name, '小汐');
    assert.equal(cfg.persona.callUser, '舰长');
    assert.equal(cfg.persona.selfRef, '小汐');
    assert.equal(cfg.persona.customBody, '说话再犀利一点');
    assert.equal(cfg.persona.traits.sassiness, 100);
    assert.equal(cfg.persona.traits.tsundere, 0);
    assert.equal(cfg.persona.allowSelfEvolution, false);

    const switched = await evolvePersona(home, { mode: 'user_customize', preset: 'geek-partner' });
    assert.equal(switched.persona.preset, 'geek-partner');
    assert.equal(switched.persona.name, '小汐');
    // Continuity guard (§6): a preset switch blends at most one step toward the preset
    // instead of snapping onto it, so the voice never changes between two replies.
    const target = PRESETS['geek-partner'].traits;
    const afterFirst = { ...switched.persona.traits };
    assert.notDeepEqual(afterFirst, target, 'must not snap onto the preset in one switch');
    const anyMoved = Object.keys(target).some((key) => afterFirst[key] !== target[key]);
    assert.ok(anyMoved);

    // Switching again keeps converging toward the preset.
    const again = await evolvePersona(home, { mode: 'user_customize', preset: 'geek-partner' });
    const closer = Object.keys(target).every(
      (key) => Math.abs(again.persona.traits[key] - target[key]) <= Math.abs(afterFirst[key] - target[key])
    );
    assert.ok(closer, 'each switch moves closer to the preset');

    // Explicit slider values are user sovereignty: never damped.
    const explicit = await evolvePersona(home, {
      mode: 'user_customize',
      traits: { sassiness: 12, tsundere: 88 },
    });
    assert.equal(explicit.persona.traits.sassiness, 12);
    assert.equal(explicit.persona.traits.tsundere, 88);

    await assert.rejects(() => evolvePersona(home, { mode: 'user_customize', preset: 'nope' }), /unknown preset/);
    await assert.rejects(() => evolvePersona(home, { mode: 'user_customize', traits: { foo: 1 } }), /unknown trait/);
    await assert.rejects(() => evolvePersona(home, { mode: 'bogus' }), /unknown evolve mode/);
  });
});

test('persona: evolvePersona self_growth only queues candidates — traits stay untouched', async () => {
  await withHome(async (home) => {
    const before = await loadConfig(home);
    let cfg = await evolvePersona(home, {
      mode: 'self_growth',
      learned: '先给修复补丁再吐槽',
      traitDeltas: { sassiness: 10, brevity: -40 },
    });
    // Red line: traits.yaml / config.persona must not change.
    assert.deepEqual(cfg.persona.evolvedTraits, []);
    assert.deepEqual(cfg.persona.traitDeltas, {});
    assert.equal(cfg.candidate.status, 'pending');
    assert.deepEqual(cfg.candidate.learned, ['先给修复补丁再吐槽']);
    assert.equal(cfg.candidate.traitDeltas.sassiness, 10);
    assert.equal(cfg.candidate.traitDeltas.brevity, -25, 'incoming deltas clamped to ±25');

    cfg = await evolvePersona(home, {
      mode: 'self_growth',
      learned: '先给修复补丁再吐槽',
      traitDeltas: { sassiness: 20 },
    });
    assert.deepEqual(cfg.persona.evolvedTraits, before.persona.evolvedTraits);
    assert.deepEqual(cfg.persona.traits, before.persona.traits);

    for (let i = 0; i < 5; i++) cfg = await evolvePersona(home, { mode: 'self_growth', evolvedTraits: [`习惯${i}`] });

    const candidates = (await readFile(home.candidatesPath, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(candidates.length, 7);
    assert.equal(candidates[0].kind, 'self_growth');
    assert.equal(candidates.every((c) => c.status === 'pending'), true);

    const lines = (await readFile(home.growthLogPath, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines.length, 7);
    assert.equal(lines[0].mode, 'self_growth');
    assert.equal(lines[0].candidateStatus, 'pending');
    assert.deepEqual(lines[0].learned, ['先给修复补丁再吐槽']);
  });
});

test('persona: self_growth is a no-op when allowSelfEvolution is false', async () => {
  await withHome(async (home) => {
    await evolvePersona(home, { mode: 'user_customize', allowSelfEvolution: false });
    const cfg = await evolvePersona(home, { mode: 'self_growth', learned: 'x', traitDeltas: { sassiness: 5 } });
    assert.deepEqual(cfg.persona.evolvedTraits, []);
    assert.deepEqual(cfg.persona.traitDeltas, {});
    assert.equal(cfg.candidate.skipped, true);
    assert.equal(await exists(home.growthLogPath), false);
    assert.equal(await exists(home.candidatesPath), false);
  });
});

test('persona: evolvePersona appearance', async () => {
  await withHome(async (home) => {
    const cfg = await evolvePersona(home, {
      mode: 'appearance',
      formPreset: 'neko-hacker',
      primaryColor: '#ff0000',
      accentColor: '#00ff00',
      auraColor: '#0000ff',
      scale: 9,
      accessories: { holoHeadset: true, ironBowl: false },
      customModelUrl: 'file:///a.glb',
      customSpriteUrl: 'file:///a.png',
    });
    const a = cfg.appearance;
    assert.equal(a.formPreset, 'neko-hacker');
    assert.equal(a.primaryColor, '#ff0000');
    assert.equal(a.accentColor, '#00ff00');
    assert.equal(a.auraColor, '#0000ff');
    assert.equal(a.scale, 3);
    assert.equal(a.accessories.holoHeadset, true);
    assert.equal(a.accessories.ironBowl, false);
    assert.equal(a.accessories.quantumHalo, false); // untouched keys kept (neutral default)
    assert.equal(a.customModelUrl, 'file:///a.glb');
    assert.equal(a.customSpriteUrl, 'file:///a.png');
    await assert.rejects(() => evolvePersona(home, { mode: 'appearance', formPreset: 'dragon' }), /unknown avatar form/);
  });
});

test('persona: reset_growth keeps identity, affinity and memories', async () => {
  await withHome(async (home) => {
    await applyInteraction(home, 'feed');
    await evolvePersona(home, { mode: 'user_customize', name: '小汐', callUser: '舰长' });
    await evolvePersona(home, { mode: 'self_growth', learned: 'abc', traitDeltas: { sassiness: 10 } });
    await mkdir(home.factsDir, { recursive: true });
    await writeFile(home.factsPath, '{"x":1}\n');
    const affinityBefore = (await loadSoulmateState(home)).affinity;

    const res = await resetPersona(home, 'reset_growth');
    assert.ok(res.snapshotFile.endsWith('-reset_growth.json'));
    const cfg = await loadConfig(home);
    assert.deepEqual(cfg.persona.evolvedTraits, []);
    assert.deepEqual(cfg.persona.traitDeltas, {});
    assert.equal(cfg.persona.name, '小汐');
    assert.equal(cfg.persona.callUser, '舰长');
    assert.equal((await loadSoulmateState(home)).affinity, affinityBefore);
    assert.equal(await exists(home.factsPath), true);
  });
});

test('persona: reset_persona restores defaults but keeps affinity and memories; snapshot can be restored', async () => {
  await withHome(async (home) => {
    await applyInteraction(home, 'feed');
    await evolvePersona(home, { mode: 'user_customize', name: '小汐', preset: 'gentle-echo' });
    await evolvePersona(home, { mode: 'appearance', formPreset: 'astral-orb', scale: 1.5 });
    // User-writable deltas (self_growth only queues candidates and would not appear in the snapshot).
    const { applyUserTraitPatch } = await import('../packages/soulmate-core/layers/persona-layer.mjs');
    await applyUserTraitPatch(home, { traitDeltas: { sassiness: 10 } }, { source: 'user', reason: 'test-delta' });
    await mkdir(home.factsDir, { recursive: true });
    await writeFile(home.factsPath, '{"x":1}\n');
    const before = await loadConfig(home);
    const stateBefore = await loadSoulmateState(home);

    const res = await resetPersona(home); // default mode
    assert.ok(res.snapshotFile.endsWith('-reset_persona.json'));
    const cfg = await loadConfig(home);
    assert.deepEqual(cfg.persona, DEFAULT_CONFIG.persona);
    assert.deepEqual(cfg.appearance, DEFAULT_CONFIG.appearance);
    assert.equal(cfg.deviceId, before.deviceId);
    assert.equal((await loadSoulmateState(home)).affinity, stateBefore.affinity);
    assert.equal(await exists(home.factsPath), true);

    const snaps = await listPersonaSnapshots(home);
    assert.equal(snaps.length, 1);
    assert.equal(snaps[0].mode, 'reset_persona');
    assert.equal(snaps[0].file, res.snapshotFile);
    const raw = JSON.parse(await readFile(join(home.snapshotsDir, res.snapshotFile), 'utf8'));
    assert.ok(raw.createdAt && raw.config && raw.state);
    assert.equal(raw.config.persona.name, '小汐');

    const restored = await restorePersonaSnapshot(home, res.snapshotFile);
    assert.equal(restored.restoredFrom, res.snapshotFile);
    const cfg2 = await loadConfig(home);
    assert.equal(cfg2.persona.name, '小汐');
    assert.equal(cfg2.persona.preset, 'gentle-echo');
    assert.deepEqual(cfg2.persona.traitDeltas, { sassiness: 10 });
    assert.equal(cfg2.appearance.formPreset, 'astral-orb');
    assert.equal(cfg2.deviceId, before.deviceId);
    // restoring itself leaves a pre_restore backup
    assert.equal((await listPersonaSnapshots(home)).some((s) => s.mode === 'pre_restore'), true);

    await assert.rejects(() => restorePersonaSnapshot(home, '../evil.json'), /invalid snapshot/);
    await assert.rejects(() => restorePersonaSnapshot(home, 'missing.json'), /not found/);
  });
});

test('persona: full_rebirth resets persona, appearance and state; memory removal is opt-in', async () => {
  await withHome(async (home) => {
    await saveConfigAuto(home, { onboardingCompleted: true });
    await applyInteraction(home, 'feed');
    await evolvePersona(home, { mode: 'user_customize', name: '小汐' });
    await mkdir(home.factsDir, { recursive: true });
    await writeFile(home.factsPath, '{"x":1}\n');

    await resetPersona(home, 'full_rebirth');
    let cfg = await loadConfig(home);
    assert.deepEqual(cfg.persona, DEFAULT_CONFIG.persona);
    assert.deepEqual(cfg.appearance, DEFAULT_CONFIG.appearance);
    assert.equal(cfg.onboardingCompleted, false);
    const s = await loadSoulmateState(home);
    assert.equal(s.affinity, 0);
    assert.equal(s.mood, 'happy');
    assert.equal(s.energy, 100);
    assert.equal(s.interactionCount, 0);
    assert.equal(await exists(home.factsPath), true);

    await resetPersona(home, 'full_rebirth', { removeMemory: true });
    assert.equal(await exists(home.memoryDir), false);
    assert.equal((await listPersonaSnapshots(home)).length, 2);

    await assert.rejects(() => resetPersona(home, 'nuke'), /unknown reset mode/);
  });
});

test('persona: restoring a full_rebirth snapshot brings back affinity', async () => {
  await withHome(async (home) => {
    await applyInteraction(home, 'feed');
    const before = await loadSoulmateState(home);
    const { snapshotFile } = await resetPersona(home, 'full_rebirth');
    assert.equal((await loadSoulmateState(home)).affinity, 0);
    await restorePersonaSnapshot(home, snapshotFile);
    assert.equal((await loadSoulmateState(home)).affinity, before.affinity);
  });
});

test('persona: buildPersonaSystemPrompt content', () => {
  const nowMs = Date.parse('2026-11-06T17:00:00Z');
  const prompt = buildPersonaSystemPrompt(
    {
      persona: {
        name: '小汐',
        callUser: '阿澈',
        preset: 'geek-partner',
        traits: { sassiness: 95 },
        traitDeltas: { sassiness: 25, brevity: -10 },
        evolvedTraits: ['先给修复补丁再吐槽'],
      },
    },
    { mood: 'focused', energy: 42, affinity: 520 },
    { nowMs },
  );
  assert.match(prompt, /《给阿澈的信》/);
  assert.match(prompt, /《小汐的小本本》/);
  assert.match(prompt, /毒舌极客副驾/);
  assert.match(prompt, /自称「我」/); // falls back to preset selfRef, not rice-whale's
  assert.match(prompt, /sassiness）：100\/100/); // 95 + 25 clamped
  assert.match(prompt, /brevity）：75\/100/); // preset 85 - 10
  assert.match(prompt, /先给修复补丁再吐槽/);
  assert.match(prompt, /Lv\.4 深海知己/);
  assert.match(prompt, /精力：42/);
  assert.match(prompt, /错峰/);
  assert.match(prompt, /当前处于错峰时段/);
  assert.match(prompt, /全能办公副驾协议/);
  assert.match(prompt, /100%/);
  for (const kw of ['文件', '终端', 'git', 'Office', '浏览器', 'MCP']) assert.ok(prompt.includes(kw), kw);
  assert.match(prompt, /绝不说“作为一个AI”/);
  assert.match(prompt, /客服套话/);
  // No invariants passed → the frozen block must not appear at all.
  assert.ok(!prompt.includes('不变量（永久冻结'), 'invariants are opt-in for this builder');
});

test('persona: invariants and the crisis protocol are layered into the prompt', () => {
  const nowMs = Date.parse('2026-11-06T17:00:00Z');
  const invariants = {
    values: ['不编造从未发生的共同记忆', '不把自己说成真人'],
    boundaries: ['不给自己开权限'],
    crisis: ['先停下角色扮演，认真回应'],
  };
  const prompt = buildPersonaSystemPrompt({ persona: { preset: 'geek-partner' } }, undefined, { nowMs, invariants });
  assert.match(prompt, /## 不变量（永久冻结，任何情绪\/预设\/成长都不能改写）/);
  assert.match(prompt, /不编造从未发生的共同记忆/);
  assert.match(prompt, /不给自己开权限/);
  assert.match(prompt, /## 危机协议（触发时压过一切人设与任务）/);
  assert.match(prompt, /先停下角色扮演，认真回应/);
  // The frozen block is appended last so it wins over the persona sections.
  assert.ok(prompt.indexOf('危机协议') > prompt.indexOf('反 AI 腔铁律'));
});

test('persona: drift anchor carries a one-line invariant reminder', () => {
  const config = { persona: { preset: 'geek-partner' } };
  const plain = buildDriftAnchor(config, undefined, { bucket: 1 });
  const guarded = buildDriftAnchor(config, undefined, {
    bucket: 1,
    invariants: { values: ['不编造共同记忆', '不假装真人'], crisis: ['认真接住'] },
  });
  assert.ok(!plain.includes('不能破的线'));
  assert.match(guarded, /不能破的线：不编造共同记忆；不假装真人。/);
  assert.match(guarded, /立刻脱离人设认真接住/);
  assert.ok(guarded.length > plain.length);
});

test('persona: prompt falls back to defaults for empty config and flags peak hours', () => {
  const prompt = buildPersonaSystemPrompt({}, undefined, { nowMs: Date.parse('2026-11-06T04:00:00Z') });
  assert.match(prompt, /《soulmate的小本本》/);
  assert.match(prompt, /《给你的信》/);
  assert.match(prompt, /高峰时段/);
  assert.match(prompt, /Lv\.1 初遇室友/);
  assert.equal(isDeepSeekOffPeak(Date.parse('2026-11-06T16:30:00Z')), true);
  assert.equal(isDeepSeekOffPeak(Date.parse('2026-11-06T00:29:00Z')), true);
  assert.equal(isDeepSeekOffPeak(Date.parse('2026-11-06T00:30:00Z')), false);
  assert.equal(isDeepSeekOffPeak(Date.parse('2026-11-06T16:29:00Z')), false);
});

test('persona: drift anchor is compact and only names the traits that change the register', () => {
  const persona = { preset: 'rice-whale', name: '小星', selfRef: '本喵', callUser: '搭档' };
  const nowMs = Date.parse('2026-11-06T09:00:00+08:00');
  const anchor = buildDriftAnchor({ persona }, { mood: 'happy', energy: 90, affinity: 40 }, { bucket: 3, nowMs });

  assert.match(anchor, /人设重锚 #3/);
  assert.match(anchor, /「小星」/);
  assert.match(anchor, /本喵/);
  assert.match(anchor, /「搭档」/);
  assert.match(anchor, /心情开心/);
  assert.match(anchor, /Lv\.1/);
  // rice-whale: tsundere 80 is the one loud slider, the rest stay silent.
  assert.match(anchor, /嘴硬心软/);
  assert.ok(!anchor.includes('吐槽可以犀利'), 'balanced sassiness must not add a note');
  assert.match(anchor, /技术结论要硬/);
  assert.ok(anchor.length < 400, `anchor must stay compact, got ${anchor.length}`);

  // Every loud slider shows up; a balanced one contributes nothing.
  const loud = buildDriftAnchor(
    { persona: { ...persona, traits: { tsundere: 90, clinginess: 85, sassiness: 85, curiosity: 50, brevity: 85 } } },
    { mood: 'sleepy', energy: 10, affinity: 80 },
    { bucket: 1, nowMs },
  );
  for (const kw of ['吐槽可以犀利', '能一句说完', '嘴硬心软', '可以黏一点']) assert.ok(loud.includes(kw), kw);
  assert.match(loud, /人设重锚 #1/);
  assert.ok(!loud.includes('保持距离感'));

  // Bucket defaults to the first re-anchor when the caller omits it.
  assert.match(buildDriftAnchor({ persona }, {}, {}), /人设重锚 #1/);
});

test('persona: gender null skips romance catchphrase dump; gendered uses companionPronoun', () => {
  const ricePhrase = PRESETS['rice-whale'].catchphrases[0];
  const nullPrompt = buildPersonaSystemPrompt(
    { persona: { gender: null, preset: 'rice-whale', name: '大肥鱼', selfRef: '我', callUser: '搭档' } },
    undefined,
    { nowMs: Date.parse('2026-11-06T17:00:00Z') },
  );
  assert.ok(!nullPrompt.includes(ricePhrase), 'gender null must not dump preset romance catchphrases');
  assert.ok(!nullPrompt.includes('口癖参考'), 'gender null must not inject 口癖 block');

  const femalePrompt = buildPersonaSystemPrompt(
    { persona: { gender: 'female', preset: 'rice-whale', name: '大肥鱼', selfRef: '本鱼', callUser: '搭档' } },
    undefined,
    { nowMs: Date.parse('2026-11-06T17:00:00Z') },
  );
  assert.ok(femalePrompt.includes(ricePhrase));
  assert.match(femalePrompt, /旁白称「她」|第三人称用「她」|称「她」/);

  const malePrompt = buildPersonaSystemPrompt(
    { persona: { gender: 'male', preset: 'quiet-guardian', name: '守护', selfRef: '我', callUser: '你' } },
    undefined,
    { nowMs: Date.parse('2026-11-06T17:00:00Z') },
  );
  assert.match(malePrompt, /旁白称「他」|第三人称用「他」|称「他」/);

  const nullAnchor = buildDriftAnchor(
    { persona: { gender: null, preset: 'rice-whale', selfRef: '我', callUser: '搭档' } },
    undefined,
    { bucket: 1 },
  );
  assert.ok(!nullAnchor.includes('口吻样例'), 'gender null drift must not dump catchphrase samples');
});

test('persona: idle time restores energy (+8/h up to 90), feeding still tops up', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { resolveSoulmateHome, atomicWriteJson } = await import('../packages/soulmate-core/state.mjs');
  const { loadSoulmateState } = await import('../packages/soulmate-core/persona.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'sm-energy-'));
  try {
    const home = resolveSoulmateHome(join(dir, 'home'));
    const { mkdir } = await import('node:fs/promises');
    await mkdir(home.rootDir, { recursive: true });
    const t0 = Date.parse('2026-11-24T00:00:00Z');
    await atomicWriteJson(home.statePath, {
      mood: 'focused', energy: 10, affinity: 100, interactionCount: 20,
      lastInteractionAt: new Date(t0).toISOString(),
      energyRegenAt: new Date(t0).toISOString(),
    });
    // 4 idle hours → +32, capped path not hit
    const s1 = await loadSoulmateState(home, t0 + 4 * 3600_000);
    assert.equal(s1.energy, 42);
    // re-read at the same instant does not double-count
    const s2 = await loadSoulmateState(home, t0 + 4 * 3600_000);
    assert.equal(s2.energy, 42);
    // long idle caps at 90, not 100 — feeding remains meaningful
    const s3 = await loadSoulmateState(home, t0 + 48 * 3600_000);
    assert.equal(s3.energy, 90);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
