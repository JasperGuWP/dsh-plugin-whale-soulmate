// Status layer snapshot: what she "knows right now" (edge ① feed for scheduling).
import { readdir, readFile } from 'node:fs/promises';
import { appendJsonl, loadRelationship, loadConfig, saveRelationship } from '../state.mjs';
import { loadSoulmateState, computeBondStage } from '../persona.mjs';
import { describeBudget } from '../budget.mjs';
import { memoryCounts } from '../memory-engine.mjs';
import { assertNumericTime } from './redlines.mjs';

const BUDGET = Object.freeze({
  identity: 15,
  relationship: 10,
  memory: 45,
  // Remaining 30% reserved for turn instructions / tools.
  reserved: 30,
});

async function countJsonlLines(path) {
  try {
    const raw = await readFile(path, 'utf8');
    return raw.split('\n').filter((l) => l.trim()).length;
  } catch (err) {
    if (err?.code === 'ENOENT') return 0;
    throw err;
  }
}

async function countWikiPages(home) {
  try {
    const names = await readdir(home.wikiTopicsDir);
    return names.filter((n) => n.endsWith('.md')).length;
  } catch (err) {
    if (err?.code === 'ENOENT') return 0;
    throw err;
  }
}

/**
 * Keep relationship.json roughly in sync with live affinity / last interaction.
 * Does not invent warmth — maps affinity into 0–100 warmth/trust softly.
 */
export async function syncRelationshipFromState(home, state) {
  const affinity = Number(state?.affinity) || 0;
  const warmth = Math.max(0, Math.min(100, Math.round(affinity / 10)));
  const trust = Math.max(0, Math.min(100, Math.round(warmth * 0.9 + 5)));
  return saveRelationship(home, {
    warmth,
    trust,
    lastContactAt: state?.lastInteractionAt || '',
  });
}

export async function getStatusSnapshot(home, nowMs = Date.now(), options = {}) {
  const [config, state, relationship, factCount, wikiCount, ledgerCount, counts] = await Promise.all([
    loadConfig(home),
    loadSoulmateState(home, nowMs),
    loadRelationship(home),
    countJsonlLines(home.factsPath),
    countWikiPages(home),
    countJsonlLines(home.ledgerPath),
    memoryCounts(home, nowMs).catch(() => null),
  ]);

  let episodes = 0;
  try {
    const names = await readdir(home.episodesDir);
    episodes = names.filter((n) => n.endsWith('.md') || n.endsWith('.json')).length;
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }

  const rel = await syncRelationshipFromState(home, state);
  const time = assertNumericTime(nowMs, rel.lastContactAt || state.lastInteractionAt);
  const bond = computeBondStage(state.affinity);

  return {
    mood: state.mood,
    energy: state.energy,
    affinity: state.affinity,
    activity: state.activity,
    interactionCount: state.interactionCount,
    streakDays: state.streakDays,
    bondStage: bond,
    relationship: {
      warmth: rel.warmth,
      trust: rel.trust,
      unfulfilledPromises: Array.isArray(rel.unfulfilledPromises) ? rel.unfulfilledPromises : [],
      lastContactAt: rel.lastContactAt || state.lastInteractionAt || '',
    },
    time,
    memory: {
      facts: factCount,
      wiki: wikiCount,
      episodes,
      ledgerTurns: ledgerCount,
      // v3 (§11): line counts lie about invalidated rows; these do not.
      activeFacts: counts?.activeFacts ?? factCount,
      historicalFacts: counts?.historicalFacts ?? factCount,
      conflictsOpen: counts?.conflictsOpen ?? 0,
      undistilled: counts?.undistilled ?? 0,
      lastDistilledAt: counts?.lastDistilledAt ?? '',
    },
    contextBudget: {
      ...describeBudget(options.promptText ?? ''),
      budget: BUDGET,
    },
    displayName: config.persona?.name?.trim() || 'soulmate',
    callUser: config.persona?.callUser || '搭档',
  };
}

/** Append a turn ledger line (which memory ids were used). */
export async function appendLedger(home, entry) {
  await appendJsonl(home.ledgerPath, {
    at: new Date().toISOString(),
    ...entry,
  });
}
