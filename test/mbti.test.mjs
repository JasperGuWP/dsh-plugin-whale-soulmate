import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveSoulmateHome, DEFAULT_CONFIG } from '../packages/soulmate-core/state.mjs';
import {
  MBTI_TYPES,
  MBTI_TRAIT_DEFAULTS,
  applyMbtiEdit,
  buildPersonaSystemPrompt,
  evolvePersona,
  getEffectiveTraits,
  mbtiToTraits,
  switchTraitScheme,
  traitsToNearestMbti,
  typeFromAxes,
} from '../packages/soulmate-core/persona.mjs';

async function withHome(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'soulmate-mbti-'));
  try {
    return await fn(resolveSoulmateHome(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('mbti: mapping table covers all 16 types with finite five traits', () => {
  assert.equal(MBTI_TYPES.length, 16);
  for (const type of MBTI_TYPES) {
    const def = MBTI_TRAIT_DEFAULTS[type];
    assert.ok(def, type);
    for (const key of ['tsundere', 'clinginess', 'sassiness', 'curiosity', 'brevity']) {
      assert.ok(Number.isFinite(def[key]), `${type}.${key}`);
      assert.ok(def[key] >= 0 && def[key] <= 100);
    }
    const derived = mbtiToTraits(type);
    assert.equal(Object.keys(derived).length, 5);
    const eff = getEffectiveTraits({ traits: derived, preset: 'blank-custom' });
    for (const key of Object.keys(derived)) {
      assert.ok(Number.isFinite(eff[key]) && eff[key] >= 0 && eff[key] <= 100, `${type} effective ${key}`);
    }
  }
});

test('mbti: ENFP maps clingy/curious; ISTJ maps brief/less clingy', () => {
  const enfp = mbtiToTraits('ENFP');
  const istj = mbtiToTraits('ISTJ');
  assert.ok(enfp.clinginess - istj.clinginess >= 50, 'cling gap');
  assert.ok(enfp.curiosity - istj.curiosity >= 40, 'curiosity gap');
  assert.ok(istj.brevity - enfp.brevity >= 50, 'brevity gap');
});

test('mbti: traitsToNearestMbti recovers gentle-echo-ish as INFP neighbourhood', () => {
  const gentle = { tsundere: 15, clinginess: 75, sassiness: 10, curiosity: 65, brevity: 50 };
  const nearest = traitsToNearestMbti(gentle);
  assert.equal(nearest.type, 'INFP');
  assert.equal(nearest.axes.EI, 78);
});

test('mbti: typeFromAxes follows 50-threshold', () => {
  assert.equal(typeFromAxes({ EI: 20, SN: 20, TF: 20, JP: 20 }), 'ESTJ');
  assert.equal(typeFromAxes({ EI: 80, SN: 80, TF: 80, JP: 80 }), 'INFP');
  assert.equal(typeFromAxes({ EI: 50, SN: 50, TF: 50, JP: 50 }), 'INFP');
});

test('mbti: scheme snapshot round-trip restores both sides', () => {
  const fiveTraits = { tsundere: 10, clinginess: 90, sassiness: 5, curiosity: 40, brevity: 60 };
  const toMbti = switchTraitScheme(
    { traitScheme: 'five', traits: fiveTraits, mbti: { type: 'INTJ', axes: null }, schemeSnapshots: { five: { traits: null }, mbti: null } },
    'mbti',
  );
  assert.equal(toMbti.traitScheme, 'mbti');
  assert.deepEqual(toMbti.schemeSnapshots.five.traits, fiveTraits);
  assert.ok(toMbti.mbti.type);
  assert.ok(Number.isFinite(toMbti.traits.clinginess));

  // Customise MBTI, then switch back — five snapshot must return.
  const edited = applyMbtiEdit(toMbti, { type: 'ENTP' });
  const mid = { ...toMbti, ...edited };
  const back = switchTraitScheme(mid, 'five');
  assert.equal(back.traitScheme, 'five');
  assert.deepEqual(back.traits, fiveTraits);
  assert.equal(back.schemeSnapshots.mbti.type, 'ENTP');

  const again = switchTraitScheme(back, 'mbti');
  assert.equal(again.traitScheme, 'mbti');
  assert.equal(again.mbti.type, 'ENTP');
});

test('mbti: evolvePersona switches scheme, rejects bad type, maps on edit', async () => {
  await withHome(async (home) => {
    const base = await evolvePersona(home, {
      mode: 'user_customize',
      traits: { tsundere: 12, clinginess: 88, sassiness: 8, curiosity: 55, brevity: 48 },
    });
    assert.equal(base.persona.traitScheme || 'five', 'five');

    const on = await evolvePersona(home, { mode: 'user_customize', traitScheme: 'mbti' });
    assert.equal(on.persona.traitScheme, 'mbti');
    assert.ok(MBTI_TYPES.includes(on.persona.mbti.type));
    assert.deepEqual(on.persona.schemeSnapshots.five.traits.tsundere, 12);
    const mapped = getEffectiveTraits(on.persona);
    assert.ok(Number.isFinite(mapped.clinginess));

    const typed = await evolvePersona(home, { mode: 'user_customize', mbti: { type: 'ENFP' } });
    assert.equal(typed.persona.mbti.type, 'ENFP');
    assert.ok(typed.persona.traits.clinginess >= 70);

    await assert.rejects(
      () => evolvePersona(home, { mode: 'user_customize', mbti: { type: 'XXXX' } }),
      /unknown MBTI type/,
    );
    await assert.rejects(
      () => evolvePersona(home, { mode: 'user_customize', traitScheme: '16pf' }),
      /unknown traitScheme/,
    );

    const off = await evolvePersona(home, { mode: 'user_customize', traitScheme: 'five' });
    assert.equal(off.persona.traitScheme, 'five');
    assert.equal(off.persona.traits.tsundere, 12);
    assert.equal(off.persona.schemeSnapshots.mbti.type, 'ENFP');
  });
});

test('mbti: traits-only customize under mbti scheme syncs nearest letter', async () => {
  await withHome(async (home) => {
    await evolvePersona(home, { mode: 'user_customize', traitScheme: 'mbti', mbti: { type: 'INTJ' } });
    const quiz = {
      tsundere: 20,
      clinginess: 25,
      sassiness: 45,
      curiosity: 70,
      brevity: 70,
    };
    const next = await evolvePersona(home, {
      mode: 'user_customize',
      traitScheme: 'mbti',
      preset: 'geek-partner',
      traits: quiz,
    });
    assert.equal(next.persona.mbti.type, 'ISTP');
    assert.equal(next.persona.traits.tsundere, 20);
    assert.equal(next.persona.traits.brevity, 70);
    assert.notEqual(next.persona.mbti.type, 'INTJ');
  });
});

test('mbti: prompt injects MBTI section only when scheme=mbti', () => {
  const five = buildPersonaSystemPrompt({
    persona: { ...DEFAULT_CONFIG.persona, traitScheme: 'five', name: '小海' },
  });
  assert.ok(!five.includes('## MBTI 人设'));
  assert.match(five, /## 五维性格/);

  const mbti = buildPersonaSystemPrompt({
    persona: {
      ...DEFAULT_CONFIG.persona,
      traitScheme: 'mbti',
      name: '小海',
      mbti: { type: 'INFP', axes: { EI: 78, SN: 78, TF: 78, JP: 78 } },
    },
  });
  assert.match(mbti, /## MBTI 人设（16型 · INFP）/);
  assert.match(mbti, /语气优先级高于上方预设口癖/);
  assert.match(mbti, /本型硬规则/);
  assert.match(mbti, /内部兼容映射/);
  assert.match(mbti, /勿向用户念维度名/);

  const enfp = buildPersonaSystemPrompt({
    persona: {
      ...DEFAULT_CONFIG.persona,
      traitScheme: 'mbti',
      preset: 'rice-whale',
      mbti: { type: 'ENFP', axes: { EI: 22, SN: 78, TF: 78, JP: 78 } },
    },
  });
  assert.match(enfp, /语气优先级高于上方预设口癖/);
  assert.match(enfp, /讨厌冷场/);
});

test('mbti: DEFAULT_CONFIG carries traitScheme + mbti + snapshots', () => {
  assert.equal(DEFAULT_CONFIG.persona.traitScheme, 'five');
  assert.equal(DEFAULT_CONFIG.persona.mbti.type, 'INFP');
  assert.ok(DEFAULT_CONFIG.persona.schemeSnapshots);
});
