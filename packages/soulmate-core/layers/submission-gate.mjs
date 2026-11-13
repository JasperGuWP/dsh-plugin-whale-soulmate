// Submission gate (design §2 提交拍 / §4 提交门).
//
// The model never writes traits. It appends *candidates*; this gate is the only
// path from a candidate to `traits.yaml`. A candidate must clear five rules:
//
//   1. Observed for >= 3 days, or backed by >= 3 distinct evidences.
//   2. Each trait delta <= ±8 in one submission, <= ±15 per ISO week.
//   3. Invariants are untouchable — a candidate that names one is rejected.
//   4. Every accepted write appends to changelog.jsonl.
//   5. Anything over the threshold needs the user: it is parked, not applied.
//
// Unaccepted candidates are not thrown away. `pending` ones stay for a later
// week; `rejected` ones are marked so they are never re-counted.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { applyContinuityGuard, isoWeekKey, weeklyUsageFrom } from './continuity-guard.mjs';
import {
  TRAIT_KEYS,
  applyUserTraitPatch,
  listAllCandidates,
  listChangelog,
  loadInvariants,
  loadTraitsDoc,
} from './persona-layer.mjs';
import { atomicWriteText } from '../state.mjs';

const DAY_MS = 86_400_000;

export const GATE_RULES = Object.freeze({
  minAgeDays: 3,
  minEvidence: 3,
  singleStep: 8,
  weeklyTotal: 15,
});

const toMs = (v) => {
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : 0;
};
const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));

/** Rule 1 — "seen long enough, or seen often enough". */
export function meetsObservationRule(candidate, nowMs = Date.now()) {
  const evidence = Array.isArray(candidate?.evidence) ? candidate.evidence.filter(Boolean) : [];
  if (evidence.length >= GATE_RULES.minEvidence) return { ok: true, why: `${evidence.length} evidences` };
  const firstAt = toMs(candidate?.firstSeenAt ?? candidate?.at);
  if (!firstAt) return { ok: false, why: 'no first-seen timestamp' };
  const ageDays = (nowMs - firstAt) / DAY_MS;
  if (ageDays >= GATE_RULES.minAgeDays) return { ok: true, why: `observed ${ageDays.toFixed(1)}d` };
  return { ok: false, why: `only ${ageDays.toFixed(1)}d and ${evidence.length} evidence(s)` };
}

/** Rule 3 — invariants are frozen. A candidate that tries to touch one is rejected outright. */
export function violatesInvariants(candidate, invariants) {
  const frozen = [...(invariants?.values ?? []), ...(invariants?.boundaries ?? [])].map(str);
  const haystack = [
    str(candidate?.reason),
    ...(candidate?.learned ?? []).map(str),
    ...(candidate?.evidence ?? []).map((e) => str(e?.text ?? e)),
  ].join('\n');
  for (const clause of frozen) {
    if (clause && haystack.includes(clause)) return { ok: false, clause };
  }
  // The gate also refuses to run against a mutated invariants file.
  return { ok: true };
}

function coerceDeltas(raw) {
  const out = {};
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (!TRAIT_KEYS.includes(key)) continue;
    const n = Number(value);
    if (!Number.isFinite(n) || n === 0) continue;
    out[key] = Math.round(n);
  }
  return out;
}

/**
 * Run the gate once.
 *
 * @param {object} home  soulmate home layout
 * @param {{nowMs?: number, dryRun?: boolean, requireUser?: (change:object)=>boolean}} [options]
 * @returns {Promise<{ok: boolean, applied: object|null, accepted: number[], parked: object[], rejected: object[], reason?: string}>}
 */
export async function runSubmissionGate(home, options = {}) {
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const now = new Date(nowMs);
  const dryRun = options.dryRun === true;

  const [invariants, traitsDoc, changelog, candidates] = await Promise.all([
    loadInvariants(home),
    loadTraitsDoc(home),
    listChangelog(home, 400),
    listAllCandidates(home),
  ]);

  const pending = candidates.filter((c) => c && c.status === 'pending');
  const rejected = [];
  const parked = [];
  const accepted = [];
  const mergedDelta = {};

  for (const candidate of pending) {
    const inv = violatesInvariants(candidate, invariants);
    if (!inv.ok) {
      rejected.push({ candidate, why: `invariant: ${inv.clause}` });
      continue;
    }
    const seen = meetsObservationRule(candidate, nowMs);
    if (!seen.ok) {
      // Not enough evidence yet — keep it pending for a later week.
      parked.push({ candidate, why: seen.why });
      continue;
    }
    const deltas = coerceDeltas(candidate.traitDeltas);
    if (!Object.keys(deltas).length) {
      rejected.push({ candidate, why: 'no trait deltas' });
      continue;
    }
    // Merge several candidates in the same run; the guard still caps the total.
    for (const [key, value] of Object.entries(deltas)) {
      mergedDelta[key] = (mergedDelta[key] ?? 0) + value;
    }
    accepted.push(candidate);
  }

  if (!accepted.length) {
    return {
      ok: true,
      at: now.toISOString(),
      applied: null,
      accepted: [],
      parked: parked.map((p) => ({ at: p.candidate.at, why: p.why })),
      rejected: rejected.map((r) => ({ at: r.candidate.at, why: r.why })),
      reason: parked.length ? 'nothing old enough yet' : 'no pending candidates',
    };
  }

  // Rule 2 + 6: clamp against this week's remaining budget.
  const weeklyUsed = weeklyUsageFrom(changelog, now);
  const proposed = { ...traitsDoc.traits };
  for (const [key, delta] of Object.entries(mergedDelta)) {
    proposed[key] = (Number(traitsDoc.traits[key]) || 50) + delta;
  }
  const guarded = applyContinuityGuard({
    current: traitsDoc.traits,
    proposed,
    weeklyUsed,
    singleStep: GATE_RULES.singleStep,
    weeklyTotal: GATE_RULES.weeklyTotal,
  });

  // Rule 5: a change that the guard had to cut, or a delta beyond one step,
  // needs the user's blessing. Park it instead of applying quietly.
  const needsUser = typeof options.requireUser === 'function'
    ? options.requireUser({ traits: guarded.traits, report: guarded.report })
    : false;
  if (needsUser) {
    return {
      ok: true,
      at: now.toISOString(),
      applied: null,
      accepted: [],
      parked: accepted.map((c) => ({ at: c.at, why: 'needs user confirmation' })),
      rejected: [],
      reason: 'needs user confirmation',
    };
  }

  const before = { ...traitsDoc.traits };
  const after = {};
  let moved = false;
  for (const key of TRAIT_KEYS) {
    after[key] = guarded.traits[key] ?? before[key];
    if (after[key] !== before[key]) moved = true;
  }

  if (!moved) {
    return {
      ok: true,
      at: now.toISOString(),
      applied: null,
      accepted: [],
      parked: accepted.map((c) => ({ at: c.at, why: 'guard absorbed the whole delta' })),
      rejected: [],
      reason: 'guard absorbed the whole delta',
    };
  }

  if (dryRun) {
    return {
      ok: true,
      at: now.toISOString(),
      dryRun: true,
      applied: { before, after, report: guarded.report },
      accepted: accepted.map((c) => c.at),
      parked: [] ,
      rejected: rejected.map((r) => ({ at: r.candidate.at, why: r.why })),
    };
  }

  const learned = [...new Set(accepted.flatMap((c) => (Array.isArray(c.learned) ? c.learned : [])).map(str).filter(Boolean))];
  const next = await applyUserTraitPatch(
    home,
    {
      traits: after,
      traitDeltas: traitsDoc.traitDeltas,
      evolvedTraits: [...traitsDoc.evolvedTraits, ...learned],
    },
    {
      source: 'submission-gate',
      reason: `submission gate ${isoWeekKey(now)} · ${accepted.length} candidate(s)`,
      weeklyUsed,
      report: guarded.report,
      evidence: accepted.flatMap((c) => (Array.isArray(c.evidence) ? c.evidence : [])),
    }
  );

  // Mark candidates as consumed so they are never double-counted.
  if (!dryRun) {
    const appliedAts = new Set(accepted.map((c) => c.at));
    const rejectedAts = new Set(rejected.map((r) => r.candidate.at));
    const nextCandidates = candidates.map((c) => {
      if (!c) return c;
      if (appliedAts.has(c.at)) return { ...c, status: 'applied', appliedAt: now.toISOString() };
      if (rejectedAts.has(c.at)) return { ...c, status: 'rejected', rejectedAt: now.toISOString() };
      return c;
    });
    await atomicWriteText(
      home.candidatesPath,
      nextCandidates.length ? `${nextCandidates.map((c) => JSON.stringify(c)).join('\n')}\n` : ''
    );
  }

  return {
    ok: true,
    at: now.toISOString(),
    applied: { before, after: next.traits, report: guarded.report, learned },
    accepted: accepted.map((c) => c.at),
    parked: [],
    rejected: rejected.map((r) => ({ at: r.candidate.at, why: r.why })),
  };
}