// Persona layer: invariants (frozen), traits (user-writable), self.md, changelog, candidates.
// Engine/tool writes to traits are rejected — they may only append candidates (Week-1).
import { access, readFile } from 'node:fs/promises';
import {
  DEFAULT_CONFIG,
  DEFAULT_INVARIANTS,
  DEFAULT_SELF_MD,
  PROTAGONIST_INVARIANT_BOUNDARY,
  PROTAGONIST_INVARIANT_VALUE,
  appendJsonl,
  atomicWriteText,
  atomicWriteYaml,
  deepMerge,
  loadConfig,
  loadYamlFile,
  readJsonlTail,
  saveConfigAuto,
} from '../state.mjs';
import { assertNoEnginePersonaWrite, assertNoPersonaPermissionGrant } from './redlines.mjs';

const TRAIT_KEYS = ['tsundere', 'clinginess', 'sassiness', 'curiosity', 'brevity'];

const fileExists = async (path) => access(path).then(() => true, () => false);

const hasProtagonistValue = (values) =>
  Array.isArray(values) && values.some((v) => /主人翁第一人称/.test(String(v)));

const hasProtagonistBoundary = (boundaries) =>
  Array.isArray(boundaries) && boundaries.some((b) => /演一下|换性格/.test(String(b)));

/** Append frozen protagonist clauses to an existing invariants.yaml (never full replace). */
async function ensureProtagonistInvariants(home) {
  if (!(await fileExists(home.invariantsPath))) return;
  const disk = await loadYamlFile(home.invariantsPath, 'invariants.yaml');
  if (!disk) return;
  const values = Array.isArray(disk.values) ? [...disk.values] : [];
  const boundaries = Array.isArray(disk.boundaries) ? [...disk.boundaries] : [];
  let changed = false;
  if (!hasProtagonistValue(values)) {
    values.push(PROTAGONIST_INVARIANT_VALUE);
    changed = true;
  }
  if (!hasProtagonistBoundary(boundaries)) {
    boundaries.push(PROTAGONIST_INVARIANT_BOUNDARY);
    changed = true;
  }
  if (!changed) return;
  await atomicWriteYaml(home.invariantsPath, { ...disk, values, boundaries });
}

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

function clampTraits(traits) {
  const out = {};
  for (const key of TRAIT_KEYS) {
    const n = Number(traits?.[key]);
    out[key] = Number.isFinite(n) ? clamp(Math.round(n), 0, 100) : DEFAULT_CONFIG.persona.traits[key];
  }
  return out;
}

function clampDeltas(deltas) {
  const out = {};
  for (const [key, value] of Object.entries(deltas ?? {})) {
    if (!TRAIT_KEYS.includes(key)) continue;
    const n = Number(value);
    if (!Number.isFinite(n)) continue;
    out[key] = clamp(Math.round(n), -25, 25);
  }
  return out;
}

/**
 * One-shot migration: config.persona → persona/traits.yaml (+ invariants/self if missing).
 * Idempotent — skips when traits.yaml already exists.
 */
export async function ensurePersonaFiles(home) {
  const config = await loadConfig(home);
  const hasTraits = await fileExists(home.traitsPath);

  if (!(await fileExists(home.invariantsPath))) {
    await atomicWriteYaml(home.invariantsPath, structuredClone(DEFAULT_INVARIANTS));
  }
  if (!(await fileExists(home.selfPath))) {
    await atomicWriteText(home.selfPath, DEFAULT_SELF_MD);
  }

  if (!hasTraits) {
    const traitsDoc = {
      traits: clampTraits(config.persona?.traits),
      traitDeltas: clampDeltas(config.persona?.traitDeltas),
      evolvedTraits: Array.isArray(config.persona?.evolvedTraits)
        ? config.persona.evolvedTraits.map(String).filter(Boolean).slice(-20)
        : [],
      migratedFromConfigAt: new Date().toISOString(),
    };
    await atomicWriteYaml(home.traitsPath, traitsDoc);
  }

  await ensureProtagonistInvariants(home);

  return { migrated: !hasTraits };
}

export async function loadInvariants(home) {
  await ensurePersonaFiles(home);
  const disk = await loadYamlFile(home.invariantsPath, 'invariants.yaml');
  return deepMerge(DEFAULT_INVARIANTS, disk ?? {});
}

/** Invariants are frozen after first write — overwrite attempts are rejected. */
export async function replaceInvariantsForbidden() {
  throw new Error('[soulmate] invariants.yaml 不可覆盖（不变量永久冻结）');
}

export async function loadTraitsDoc(home) {
  await ensurePersonaFiles(home);
  const disk = await loadYamlFile(home.traitsPath, 'traits.yaml');
  return {
    traits: clampTraits(disk?.traits),
    traitDeltas: clampDeltas(disk?.traitDeltas),
    evolvedTraits: Array.isArray(disk?.evolvedTraits) ? disk.evolvedTraits.map(String).filter(Boolean) : [],
  };
}

export async function loadSelfMarkdown(home) {
  await ensurePersonaFiles(home);
  try {
    return await readFile(home.selfPath, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return DEFAULT_SELF_MD;
    throw err;
  }
}

export async function listChangelog(home, limit = 20) {
  return readJsonlTail(home.changelogPath, limit);
}

export async function listCandidates(home, limit = 50) {
  return readJsonlTail(home.candidatesPath, limit);
}

/** Every candidate (the submission gate needs them all, not just the tail). */
export async function listAllCandidates(home) {
  return readJsonlTail(home.candidatesPath, 0);
}

/**
 * Sole user-facing write path for traits (edge ⑨ / UI sliders).
 * Also mirrors into config.persona for backward-compatible APIs.
 */
export async function applyUserTraitPatch(home, patch = {}, meta = {}) {
  assertNoPersonaPermissionGrant(patch);
  assertNoEnginePersonaWrite(meta.source ?? 'user');
  if (meta.source === 'engine' || meta.source === 'tool' || meta.source === 'model') {
    assertNoEnginePersonaWrite(meta.source);
  }

  const before = await loadTraitsDoc(home);
  const next = {
    traits: patch.traits !== undefined ? clampTraits(patch.traits) : before.traits,
    traitDeltas: patch.traitDeltas !== undefined ? clampDeltas(patch.traitDeltas) : before.traitDeltas,
    evolvedTraits:
      patch.evolvedTraits !== undefined
        ? (Array.isArray(patch.evolvedTraits) ? patch.evolvedTraits : before.evolvedTraits).map(String).filter(Boolean).slice(-20)
        : before.evolvedTraits,
  };

  await atomicWriteYaml(home.traitsPath, {
    ...next,
    updatedAt: new Date().toISOString(),
  });

  await appendJsonl(home.changelogPath, {
    at: new Date().toISOString(),
    source: meta.source ?? 'user',
    reason: typeof meta.reason === 'string' ? meta.reason : 'user_customize',
    before: { traits: before.traits, traitDeltas: before.traitDeltas },
    after: { traits: next.traits, traitDeltas: next.traitDeltas },
  });

  // Keep config.persona projected so existing tools/prompt builders keep working.
  await saveConfigAuto(home, {
    persona: {
      traits: next.traits,
      traitDeltas: next.traitDeltas,
      evolvedTraits: next.evolvedTraits,
    },
  });

  return next;
}

/**
 * Week-1: model/self_growth may ONLY append candidate evidence — never traits.yaml.
 */
export async function appendCandidate(home, candidate = {}) {
  const entry = {
    at: new Date().toISOString(),
    kind: typeof candidate.kind === 'string' ? candidate.kind : 'self_growth',
    learned: Array.isArray(candidate.learned) ? candidate.learned.map(String).filter(Boolean) : [],
    traitDeltas: clampDeltas(candidate.traitDeltas),
    reason: typeof candidate.reason === 'string' ? candidate.reason : '',
    evidence: Array.isArray(candidate.evidence) ? candidate.evidence : [],
    status: 'pending', // Week-2/3 submission gate
  };
  await appendJsonl(home.candidatesPath, entry);
  return entry;
}

/** Project persona layer into the engine snapshot. */
export async function getPersonaSnapshot(home) {
  const [invariants, traitsDoc, selfMd, changelog, candidates] = await Promise.all([
    loadInvariants(home),
    loadTraitsDoc(home),
    loadSelfMarkdown(home),
    listChangelog(home, 5),
    listCandidates(home, 20),
  ]);
  const effective = {};
  for (const key of TRAIT_KEYS) {
    effective[key] = clamp(
      Math.round((traitsDoc.traits[key] ?? 50) + (traitsDoc.traitDeltas[key] ?? 0)),
      0,
      100
    );
  }
  return {
    invariants,
    traits: traitsDoc.traits,
    traitDeltas: traitsDoc.traitDeltas,
    evolvedTraits: traitsDoc.evolvedTraits,
    effectiveTraits: effective,
    selfMarkdown: selfMd,
    selfSummary: selfMd.split('\n').filter((l) => l.trim() && !l.startsWith('#')).slice(0, 4).join(' · ') || '（叙事自我尚未填写）',
    changelog: changelog.slice().reverse(),
    candidatesPending: candidates.filter((c) => c.status === 'pending').length,
    candidatesRecent: candidates.slice(-5).reverse(),
    traitKeys: TRAIT_KEYS,
  };
}

export { TRAIT_KEYS };
