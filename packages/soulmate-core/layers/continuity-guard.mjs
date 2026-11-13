// Continuity guard (design §6).
//
// Two failure modes make a companion feel like a stranger:
//
//   1. A sudden jump — the model (or a preset switch) rewrites traits by tens of
//      points in one move. The design caps that: ±8 for a single evolution step,
//      ±15 cumulatively inside one ISO week.
//   2. A preset switch that overwrites everything at once, so the voice changes
//      between two consecutive replies.
//
// The guard never blocks a write — it clamps the *delta* and reports what it did,
// so the changelog can record "asked for +30, applied +8". Anything a human asks
// for explicitly (the sliders) bypasses it: the user owns the persona.

const DAY_MS = 86_400_000;

/** Design §6 thresholds. */
export const GUARD = Object.freeze({
  singleStep: 8,
  weeklyTotal: 15,
});

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const num = (v, fallback = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/** ISO week key (`2026-W45`) so "this week" is unambiguous across time zones. */
export function isoWeekKey(date = new Date()) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7; // Monday = 1 … Sunday = 7
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / DAY_MS + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/**
 * How much of each trait was already spent this week by *the model*.
 * User moves do not count: the user is not on a budget.
 */
export function weeklyUsageFrom(changelog = [], now = new Date()) {
  const week = isoWeekKey(now);
  const used = {};
  for (const row of changelog) {
    if (!row || row.source === 'user') continue;
    if (isoWeekKey(new Date(row.at ?? 0)) !== week) continue;
    const after = row.applied ?? row.after;
    const before = row.before;
    if (!after || !before) continue;
    for (const [key, value] of Object.entries(after)) {
      const prev = num(before[key], value);
      used[key] = (used[key] ?? 0) + Math.abs(num(value) - prev);
    }
  }
  return used;
}

/**
 * Clamp one proposed patch against the design budget.
 *
 * @param {object} args
 * @param {Record<string, number>} args.current     traits as they are now
 * @param {Record<string, number>} args.proposed    what the caller wants them to be
 * @param {Record<string, number>} [args.weeklyUsed] absolute movement already spent this week
 * @param {boolean} [args.isUser]                    true → no budget at all
 * @param {number} [args.singleStep]                 override (tests / config)
 * @param {number} [args.weeklyTotal]                override
 * @returns {{ok: true, traits: Record<string,number>, clamped: boolean, report: object[]}}
 */
export function applyContinuityGuard({
  current = {},
  proposed = {},
  weeklyUsed = {},
  isUser = false,
  singleStep = GUARD.singleStep,
  weeklyTotal = GUARD.weeklyTotal,
} = {}) {
  const traits = { ...current };
  const report = [];
  let clamped = false;

  for (const [key, raw] of Object.entries(proposed)) {
    const target = num(raw, NaN);
    if (!Number.isFinite(target)) continue;
    const from = num(current[key], 50);
    const want = clamp(target, 0, 100) - from;
    if (want === 0) {
      traits[key] = clamp(target, 0, 100);
      continue;
    }
    if (isUser) {
      traits[key] = clamp(target, 0, 100);
      continue;
    }
    // Remaining budget in the direction of the move.
    const used = Math.abs(num(weeklyUsed[key], 0));
    const left = Math.max(0, weeklyTotal - used);
    const allowed = Math.min(Math.abs(want), singleStep, left);
    if (allowed === 0) {
      report.push({ key, from, want: target, to: from, reason: 'weekly budget exhausted' });
      clamped = true;
      continue;
    }
    const signed = Math.sign(want) * allowed;
    const to = clamp(from + signed, 0, 100);
    traits[key] = Math.round(to);
    if (Math.abs(signed) < Math.abs(want)) {
      clamped = true;
      report.push({
        key,
        from,
        want: target,
        to: traits[key],
        // Name whichever limit actually bound the move, not just whichever is smaller.
        reason: singleStep <= left ? 'single-step cap' : 'weekly budget',
      });
    }
  }

  return { ok: true, traits, clamped, report };
}

/**
 * Preset switches are the loudest way to become a stranger, so they get their own
 * damping: instead of jumping to the new preset's numbers, move at most
 * `singleStep` toward them. Repeating the switch converges, which is what the user
 * expects — but never in one reply.
 */
export function blendTowardsPreset({ current = {}, presetTraits = {}, ratio = 0.5 } = {}) {
  const out = { ...current };
  const moved = {};
  for (const [key, raw] of Object.entries(presetTraits)) {
    const target = num(raw, NaN);
    if (!Number.isFinite(target)) continue;
    const from = num(current[key], 50);
    const diff = target - from;
    if (diff === 0) continue;
    // A quarter of the distance per switch, and never more than one step.
    const step = Math.min(Math.abs(diff) * ratio, GUARD.singleStep);
    out[key] = Math.round(clamp(from + Math.sign(diff) * Math.max(1, step), 0, 100));
    moved[key] = out[key] - from;
  }
  return { traits: out, moved };
}