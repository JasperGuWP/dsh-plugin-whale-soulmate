export { assertNoEnginePersonaWrite, assertNoPersonaPermissionGrant, assertNumericTime } from './redlines.mjs';
export {
  ensurePersonaFiles,
  loadInvariants,
  loadTraitsDoc,
  loadSelfMarkdown,
  listChangelog,
  listCandidates,
  applyUserTraitPatch,
  appendCandidate,
  getPersonaSnapshot,
  TRAIT_KEYS,
} from './persona-layer.mjs';
export { deriveStrategyParams, getSchedulingSnapshot } from './scheduling.mjs';
export { getStatusSnapshot, syncRelationshipFromState, appendLedger } from './status.mjs';
export {
  GUARD,
  applyContinuityGuard,
  blendTowardsPreset,
  isoWeekKey,
  weeklyUsageFrom,
} from './continuity-guard.mjs';
export { GATE_RULES, meetsObservationRule, runSubmissionGate, violatesInvariants } from './submission-gate.mjs';

import { getPersonaSnapshot, ensurePersonaFiles, listChangelog } from './persona-layer.mjs';
import { getSchedulingSnapshot } from './scheduling.mjs';
import { getStatusSnapshot } from './status.mjs';
import { GUARD, isoWeekKey, weeklyUsageFrom } from './continuity-guard.mjs';
import { composePresenceDigest, listTrustItems } from '../memory-engine.mjs';
import { loadConfig } from '../state.mjs';

/** Full quantified engine snapshot for GET /api/engine. */
export async function getEngineSnapshot(home, nowMs = Date.now(), options = {}) {
  await ensurePersonaFiles(home);
  const conf = await loadConfig(home).catch(() => null);
  const g = conf?.persona?.gender;
  const gender = g === 'male' || g === 'female' ? g : null;
  const [status, persona, changelog, trust, presence] = await Promise.all([
    // `options.promptText` is the prompt actually being sent; without it the budget can
    // only report static percentages, which is exactly the display-only problem this
    // replaces.
    getStatusSnapshot(home, nowMs, { promptText: options.promptText }),
    getPersonaSnapshot(home),
    listChangelog(home, 400),
    listTrustItems(home, { nowMs }).catch(() => ({ promises: [], conflicts: [] })),
    composePresenceDigest(home, { nowMs, gender }).catch(() => ({ text: '' })),
  ]);
  const scheduling = getSchedulingSnapshot(persona.effectiveTraits);
  // What the submission gate may still spend this week, per trait. Read-only:
  // the UI shows it so "self-evolution" is visible instead of implied.
  const used = weeklyUsageFrom(changelog, new Date(nowMs));
  const weeklyBudget = {
    week: isoWeekKey(new Date(nowMs)),
    singleStep: GUARD.singleStep,
    weeklyTotal: GUARD.weeklyTotal,
    used,
    left: Object.fromEntries(
      Object.keys(persona.traits ?? {}).map((k) => [k, Math.max(0, GUARD.weeklyTotal - Math.abs(used[k] || 0))])
    ),
  };
  return {
    ok: true,
    at: new Date(nowMs).toISOString(),
    status,
    scheduling,
    persona: { ...persona, weeklyBudget },
    // v3 (§11): the trust layer and the presence digest ride the 5s engine poll,
    // so the panel needs no new fetches.
    trust: { promises: trust.promises ?? [], conflicts: trust.conflicts ?? [] },
    presence: { text: presence?.text ?? '', chars: presence?.chars ?? 0, updatedAt: presence?.updatedAt ?? '' },
    redlines: {
      engineToPersona: 'blocked — candidates only',
      personaToPermissions: 'blocked',
      timeAsFeeling: 'blocked — numeric only',
    },
  };
}
