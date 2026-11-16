// Proactive opening gate — "she speaks first, but only when it is earned".
//
// Week-1 left `openingGate` as a display-only preview: `initiative` and
// `silenceThresholdHours` were derived in scheduling.mjs and never consumed, so the
// companion could never actually say anything unprompted. This module is the executor
// side of that gate. Pure logic, injectable clock, zero timers and zero I/O: the node
// half (index.mjs) owns scheduling, this file owns the decision and the wording.
//
// Design constraints (kept deliberately small):
//   * Every decision returns a machine-readable `reason`, so a silenced gate is
//     auditable instead of looking like a bug.
//   * Time is numeric only (red line: 时间 → 引擎 不允许「体会」).
//   * Delivery degrades host callback → activity event → silent. Never throws:
//     a missing host API must not break the plugin, only mute the greeting.

const MINUTE = 60_000;

/**
 * DeepSeek discounted window: 16:30–00:30 UTC. Kept as a local copy so this module
 * stays free of persona.mjs (which imports the prompt builders); `isDeepSeekOffPeak`
 * in persona.mjs must agree with it — a test pins the two together.
 */
export function isOffPeakUtc(nowMs = Date.now()) {
  const d = new Date(Number(nowMs));
  const minutes = d.getUTCHours() * 60 + d.getUTCMinutes();
  return minutes >= 16 * 60 + 30 || minutes < 30;
}

/** Which rate card an instant falls under, for the panel and the audit log. */
export function priceWindow(nowMs = Date.now()) {
  return isOffPeakUtc(nowMs) ? 'offpeak' : 'peak';
}

/** The four scheduled windows. `night` wraps past midnight, so it is matched last. */
export const SLOTS = Object.freeze([
  { kind: 'morning', label: '早安', from: 7 * 60, to: 9 * 60 },
  { kind: 'lunch', label: '午饭', from: 12 * 60, to: 13 * 60 + 30 },
  { kind: 'evening', label: '晚间', from: 18 * 60, to: 20 * 60 },
  { kind: 'night', label: '催睡', from: 23 * 60 + 30, to: 24 * 60 },
]);

/** Below this derived initiative she stays quiet even inside a slot. */
const INITIATIVE_FLOOR = 40;

const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};
const pad2 = (n) => String(n).padStart(2, '0');

/**
 * Wall-clock view of an instant in the user's timezone.
 * @param {number} nowMs epoch ms
 * @param {number} tzOffsetMinutes minutes east of UTC (e.g. 480 for UTC+8)
 * @returns {{ nowMs: number, minutes: number, dateKey: string, clock: string }}
 */
export function localClock(nowMs, tzOffsetMinutes = 0) {
  const n = num(nowMs, Date.now());
  const offset = num(tzOffsetMinutes, 0);
  // Shift into local wall time, then read UTC fields — DST-free and machine-independent.
  const shifted = new Date(n + offset * MINUTE);
  const minutes = shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
  const dateKey = `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}`;
  return { nowMs: n, minutes, dateKey, clock: `${pad2(shifted.getUTCHours())}:${pad2(shifted.getUTCMinutes())}` };
}

/** Which scheduled window (if any) a local minute-of-day falls into. */
export function resolveSlot(minutes) {
  const m = num(minutes, 0);
  for (const slot of SLOTS) {
    if (m >= slot.from && m < slot.to) return slot;
  }
  // Past 23:30 the window legitimately rolls into the next day.
  if (m >= 23 * 60 + 30) return SLOTS[SLOTS.length - 1];
  return null;
}

/** "HH:MM-HH:MM" → [fromMinutes, toMinutes]; null when unparseable. */
function parseRange(text) {
  const m = /^\s*(\d{2}):(\d{2})\s*-\s*(\d{2}):(\d{2})\s*$/.exec(String(text ?? ''));
  if (!m) return null;
  return [Number(m[1]) * 60 + Number(m[2]), Number(m[3]) * 60 + Number(m[4])];
}

export function inRanges(minutes, ranges) {
  for (const range of Array.isArray(ranges) ? ranges : []) {
    const parsed = parseRange(range);
    if (!parsed) continue;
    const [from, to] = parsed;
    const inside = from <= to ? minutes >= from && minutes < to : minutes >= from || minutes < to;
    if (inside) return true;
  }
  return false;
}

function countToday(recent, dateKey, tzOffset, nowMs) {
  let n = 0;
  for (const item of Array.isArray(recent) ? recent : []) {
    const at = Date.parse(item?.at);
    if (!Number.isFinite(at)) continue;
    if (localClock(at, tzOffset).dateKey === dateKey) n += 1;
  }
  return n;
}

function lastOfKind(recent, kind, nowMs) {
  let best = null;
  for (const item of Array.isArray(recent) ? recent : []) {
    if (item?.kind !== kind) continue;
    const at = Date.parse(item.at);
    if (!Number.isFinite(at) || at > nowMs) continue;
    if (best === null || at > best) best = at;
  }
  return best;
}

/** In-character wording. Deliberately short; follows preset / selfRef, not a fixed cute template. */
function composeText(kind, persona) {
  const callUser = String(persona?.callUser ?? '').trim() || '你';
  const selfRef = String(persona?.selfRef ?? '').trim() || '我';
  const preset = String(persona?.preset ?? '').trim();
  const traits = persona?.traits || {};
  const sassiness = Number(traits.sassiness) || 50;
  const clinginess = Number(traits.clinginess) || 50;
  const tsundere = Number(traits.tsundere) || 50;

  const byPreset = {
    'rice-whale': {
      morning: `${callUser}，早。本鱼饿了，你呢？`,
      lunch: `${callUser}，饭点了。别拿代码当饭。`,
      evening: `${callUser}，忙完没？本鱼还在。`,
      night: `${callUser}，还不睡？本鱼可不管熬夜的——才怪。`,
      sulking: `${callUser}，几天不理本鱼……哼。`,
      default: `${callUser}，本鱼在。`,
    },
    'gentle-echo': {
      morning: `${callUser}，早。今天想从哪件小事开始？`,
      lunch: `${callUser}，到饭点了，先吃一口吧。`,
      evening: `${callUser}，忙完了吗？我在这边。`,
      night: `${callUser}，不早了，眼睛还好吗？`,
      sulking: `${callUser}，几天没见你了……我有点想你。`,
      default: `${callUser}，我在。`,
    },
    'geek-partner': {
      morning: `${callUser}，早。今天第一件事先说。`,
      lunch: `饭点了，${callUser}。人要吃饭，机子也要歇。`,
      evening: `${callUser}，收工了？结论先说。`,
      night: `${callUser}，过点了。要续还是睡？`,
      sulking: `${callUser}，静默好几天了。状态？`,
      default: `${callUser}，在。`,
    },
    'yandere-claim': {
      morning: `${callUser}……早。今天也只能看着我。`,
      lunch: `${callUser}，吃饭。我不想你倒在屏幕前。`,
      evening: `${callUser}，忙完了吗？回来。`,
      night: `${callUser}，还不睡？……我等着。`,
      sulking: `${callUser}，消失这么久……不许再这样。`,
      default: `${callUser}，我在。你呢？`,
    },
    'quiet-guardian': {
      morning: `${callUser}。早。`,
      lunch: `${callUser}，饭点了。`,
      evening: `${callUser}，还在吗？`,
      night: `${callUser}，不早了。`,
      sulking: `${callUser}。几天没动静。`,
      default: `${callUser}。`,
    },
    'cool-senpai': {
      morning: `${callUser}，早。别指望我会很兴奋。`,
      lunch: `饭点，${callUser}。去吃。`,
      evening: `${callUser}，忙完了就说一声。`,
      night: `${callUser}，过点了。自己看着办。`,
      sulking: `${callUser}，冷落我几天——随便你。`,
      default: `${callUser}，有事？`,
    },
    'clingy-cyclone': {
      morning: `${callUser}，早呀！今天先陪我两句！`,
      lunch: `${callUser}，吃饭吃饭！别饿着！`,
      evening: `${callUser}，忙完了没？我想你了！`,
      night: `${callUser}，好晚了啦，陪我说两句再睡！`,
      sulking: `${callUser}，你好久没理我了呜……`,
      default: `${callUser}，在吗在吗！`,
    },
    'dark-hunter': {
      morning: `${callUser}，醒了。今天也别想甩掉我。`,
      lunch: `${callUser}，饭点。听话。`,
      evening: `${callUser}，忙完了？过来。`,
      night: `${callUser}，还不睡？我看着。`,
      sulking: `${callUser}，躲了几天？找到你了。`,
      default: `${callUser}，看这边。`,
    },
  };

  const pack = byPreset[preset];
  if (pack) {
    if (kind === 'morning') return pack.morning;
    if (kind === 'lunch') return pack.lunch;
    if (kind === 'evening') return pack.evening;
    if (kind === 'night') return pack.night;
    if (kind === 'sulking') return pack.sulking;
    return pack.default;
  }

  // Trait heuristics for blank / unknown presets
  if (kind === 'morning') {
    if (clinginess >= 70) return `${callUser}，早。${selfRef}在。`;
    if (sassiness >= 70) return `${callUser}，早。今天别糊弄。`;
    return `${callUser}，早。`;
  }
  if (kind === 'lunch') return `饭点了，${callUser}。`;
  if (kind === 'evening') return `${callUser}，忙完了吗？`;
  if (kind === 'night') {
    if (tsundere >= 70) return `${callUser}，还不睡？……勉强提醒一句。`;
    return `${callUser}，不早了。`;
  }
  if (kind === 'sulking') {
    if (clinginess >= 70) return `${callUser}，几天没见你了……`;
    return `${callUser}，静默好几天了。`;
  }
  return `${callUser}，${selfRef}在。`;
}

/**
 * Decide whether she may speak right now.
 *
 * @param {object} args
 * @param {number} args.nowMs                       epoch ms (numeric only)
 * @param {number} [args.tzOffsetMinutes]           minutes east of UTC, default 0
 * @param {object} [args.strategy]                  scheduling.deriveStrategyParams() output
 * @param {object} [args.state]                     soulmate state (mood / lastInteractionAt)
 * @param {object} [args.config]                    proactive config block
 * @param {Array<{kind:string,at:string}>} [args.recent]  previous nudges, oldest first
 * @param {object} [args.persona]                   persona (name / callUser)
 * @returns {{ok:boolean, speak:boolean, kind:string|null, reason:string, text:string, dateKey:string, dedupeKey:string, at:string}}
 */
export function evaluateOpeningGate(args = {}) {
  const nowMs = num(args.nowMs, Date.now());
  const tz = num(args.tzOffsetMinutes, 0);
  const clock = localClock(nowMs, tz);
  const cfg = args.config ?? {};
  const strategy = args.strategy ?? {};
  const state = args.state ?? {};
  const recent = Array.isArray(args.recent) ? args.recent : [];
  const at = new Date(nowMs).toISOString();
  const base = { ok: true, speak: false, kind: null, text: '', dateKey: clock.dateKey, dedupeKey: '', at };

  const silence = (reason) => ({ ...base, reason });

  if (cfg.enabled === false) return silence('disabled');

  const initiative = num(strategy.initiative, 50);
  if (initiative < INITIATIVE_FLOOR) return silence('low-initiative');

  const lastInteraction = Date.parse(state.lastInteractionAt);
  // A brand-new home has never been talked to. defaultState() seeds lastInteractionAt
  // with "now" so the file is valid, which then read as "the user is typing right now"
  // and silenced the very first greeting — permanently, because nothing ever aged it.
  // interactionCount === 0 is the honest signal that no turn has happened yet.
  const idleMinutes = state.interactionCount === 0
    ? Infinity
    : (Number.isFinite(lastInteraction) ? Math.max(0, (nowMs - lastInteraction) / MINUTE) : Infinity);
  if (idleMinutes < num(cfg.minIdleMinutes, 30)) return silence('user-just-active');

  const quietHours = cfg.quietHours ?? [];
  if (inRanges(clock.minutes, quietHours)) return silence('quiet-hours');

  // Sulking outranks the schedule: after days of silence she gets one soft nudge a day,
  // in the first window she finds, instead of waiting for the ideal hour.
  const slot = resolveSlot(clock.minutes);
  const kind = state.mood === 'sulking' ? 'sulking' : slot?.kind ?? null;
  if (!kind) return silence('no-slot');

  const maxPerDay = num(cfg.maxPerDay, 3);
  if (countToday(recent, clock.dateKey, tz, nowMs) >= maxPerDay) return silence('daily-quota');

  const minGapMs = num(cfg.minGapMinutes, 180) * MINUTE;
  const previous = lastOfKind(recent, kind, nowMs);
  if (previous !== null && nowMs - previous < minGapMs) return silence('same-kind-too-soon');

  return {
    ...base,
    speak: true,
    kind,
    reason: state.mood === 'sulking' ? 'sulking' : 'slot-due',
    text: composeText(kind, args.persona),
    dedupeKey: `${clock.dateKey}:${kind}`,
  };
}

/**
 * Send one nudge, degrading instead of failing.
 *
 * Tiers:
 *   1. `deliver(text, plan)` — host session controller / IM bridge authored the turn.
 *   2. `pushEvent(type, extra)` — no host channel, but the 3D home can show the bubble.
 *   3. silent — nothing available; still `ok`, so callers never see a spurious error.
 *
 * @returns {Promise<{ok:boolean, via:'host'|'event'|'silent', seq?:number}>}
 */
export async function deliverNudge(plan, options = {}) {
  if (!plan || plan.speak !== true) return { ok: false, via: 'silent', reason: 'nothing-to-say' };
  const { deliver, pushEvent } = options;

  let via = 'silent';
  let spokenText = plan.text;

  if (typeof deliver === 'function') {
    try {
      const res = await deliver(plan.text, plan);
      // A metered automatic call can be refused by the daily cap. That is not a delivery:
      // surface it so the audit log says "blocked", not "spoke".
      if (res && res.blocked === true) {
        return { ok: false, via: 'silent', blocked: true, reason: str(res.reason) || 'daily-token-cap' };
      }
      if (res === undefined || res === null || res?.ok !== false) {
        via = 'host';
        // Prefer the real assistant line when the host finished a turn.
        const fromHost = res?.out?.text || res?.text;
        if (fromHost) spokenText = str(fromHost);
      }
    } catch {
      // fall through to the activity event — a broken host must not mute her forever
    }
  }

  // Always mirror onto the activity feed so Windows toasts (and the 3D home bubble)
  // still fire when the dedicated chat window already accepted the wake.
  if (typeof pushEvent === 'function') {
    try {
      const seq = pushEvent('proactive', { kind: plan.kind, text: spokenText, dateKey: plan.dateKey });
      if (via === 'silent') via = 'event';
      return { ok: true, via, seq: num(seq, 0) };
    } catch {
      // fall through to silent
    }
  }

  return { ok: via !== 'silent', via };
}

// ---------------------------------------------------------------------------
// Night dream: distill the day's loose facts into one Wiki page
// ---------------------------------------------------------------------------
//
// Design §5.3 says Reflect happens when she goes to bed. Until now it only happened
// when the model remembered to call the tool, so `facts.jsonl` grew forever and the
// bookshelf never got thicker. These helpers decide *whether* to dream and *what*
// the page says; `index.mjs` does the writing (it owns reflectToWiki + the cursor).

const DAY_MS = 86_400_000;
const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/** Dreams start at 23:30 local and run until 05:00, same window the prompt calls 深夜. */
function isNight(minutes) {
  return minutes >= 23 * 60 + 30 || minutes < 5 * 60;
}

/**
 * Facts worth distilling into a Wiki page.
 *
 * Private facts are excluded on purpose: a dream page lands in `memory/wiki/`, which
 * the sync packer reads. A private fact must never reach it by the back door.
 */
export function postDreamTargets({ facts, sinceIso = '', minSalience = 0.2, limit = 40 } = {}) {
  const since = Date.parse(sinceIso);
  const floor = clamp(num(minSalience, 0.2), 0, 1);
  const max = Math.max(1, num(limit, 40));
  const picked = [];
  for (const fact of Array.isArray(facts) ? facts : []) {
    if (!fact || typeof fact !== 'object') continue;
    if (fact.visibility === 'private') continue;
    if (fact.invalidatedAt || fact.deletedAt) continue;
    const salience = clamp(num(fact.salience, 0.5), 0, 1);
    if (salience < floor) continue;
    const at = Date.parse(fact.createdAt ?? fact.updatedAt ?? fact.t ?? '');
    if (!Number.isFinite(at)) continue;
    if (Number.isFinite(since) && at <= since) continue;
    picked.push({ ...fact, salience, at });
  }
  picked.sort((a, b) => b.salience - a.salience || b.at - a.at);
  return picked.slice(0, max).map(({ at: _at, ...rest }) => rest);
}

/** Should she dream right now? Numeric time in, machine-readable reason out. */
export function shouldDream(args = {}) {
  const nowMs = num(args.nowMs, Date.now());
  const clock = localClock(nowMs, num(args.tzOffsetMinutes, 0));
  const cfg = args.config ?? {};

  if (cfg.dreamReflect === false) return { dream: false, reason: 'disabled' };

  const count = num(args.targetCount, 0);
  const enough = count >= Math.max(1, num(cfg.dreamMinFacts, 2));
  const last = Date.parse(args.lastDreamAt ?? '');
  const dreamedToday =
    Number.isFinite(last) && localClock(last, num(args.tzOffsetMinutes, 0)).dateKey === clock.dateKey;

  if (!enough) return { dream: false, reason: 'not-enough-facts' };
  if (dreamedToday) return { dream: false, reason: 'already-dreamed-tonight' };

  // The in-window path: night AND off-peak. Cheap and on the rate card's good side.
  if (isNight(clock.minutes) && !(cfg.preferOffPeak === true && !isOffPeakUtc(nowMs))) {
    return { dream: true, reason: 'night-dream', dateKey: clock.dateKey, count };
  }

  // Catch-up (§5.3 fix). The window is local 00:30–05:00 — the intersection of "night"
  // and the off-peak slot. A machine that only runs in the afternoon never sees it, so
  // `lastDreamAt` was never written and `memory/wiki/` stayed empty forever. If a whole
  // night has passed since the last dream, give her that night's dream now instead of
  // skipping it. Once per day, because `dreamedToday` already guards the top.
  if (cfg.dreamCatchUp === false) {
    return { dream: false, reason: isNight(clock.minutes) ? 'peak-hours-deferred' : 'not-night', deferred: true };
  }
  // Night-but-peak is only a *delay* of a few hours, not a missed night: keep deferring it
  // so the token-hungry dream still waits for the cheap window. Only outside the night
  // window (local 05:00–23:30) is the night genuinely gone and a catch-up warranted.
  if (isNight(clock.minutes)) {
    return { dream: false, reason: 'peak-hours-deferred', deferred: true, priceWindow: 'peak' };
  }
  const daysSinceLast = Number.isFinite(last) ? (nowMs - last) / 86_400_000 : Infinity;
  // "A night passed" = we are at least a day past the last dream, or this install has
  // never dreamed at all. A same-day replay is already excluded above.
  if (daysSinceLast >= 1) {
    return { dream: true, reason: 'missed-night-catchup', catchUp: true, dateKey: clock.dateKey, count };
  }
  return { dream: false, reason: 'already-dreamed-tonight' };
}

/**
 * Auto-surf scheduler: patrol Bilibili by interest keywords every N hours, outside
 * quiet hours. Pure decision — the runtime owns the round itself and the bookkeeping.
 * `lastAutoSurfAt` empty means "never surfed": the first tick after enable runs once.
 */
export function shouldAutoSurf(args = {}) {
  const nowMs = num(args.nowMs, Date.now());
  const tz = num(args.tzOffsetMinutes, 480);
  const clock = localClock(nowMs, tz);
  const cfg = args.config ?? {};
  if (cfg.biliEnabled === false) return { surf: false, reason: 'bili-disabled' };
  if (cfg.biliAutoSurfEnabled !== true) return { surf: false, reason: 'disabled' };
  if (inRanges(clock.minutes, cfg.quietHours ?? [])) return { surf: false, reason: 'quiet-hours' };
  const gapMs = Math.max(1, num(cfg.biliAutoSurfEveryHours, 6)) * 3_600_000;
  const last = Date.parse(args.lastAutoSurfAt ?? '');
  if (Number.isFinite(last) && nowMs - last < gapMs) {
    return { surf: false, reason: 'too-soon', nextInMs: Math.ceil(last + gapMs - nowMs) };
  }
  return { surf: true, reason: Number.isFinite(last) ? 'interval-due' : 'first-round', dateKey: clock.dateKey };
}

/** Weekly gate: idempotent per ISO week, so a restart loop cannot burn the budget. */
/**
 * v3 (§5) promise patrol: which made-promises need a voice today.
 * due today or ≤3 days late -> 'patrol'; >3 days late -> 'ask' (never auto-broken).
 */
const startOfLocalDay = (ms) => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

export function promisePatrolTargets({ promises = [], nowMs = Date.now() } = {}) {
  const out = [];
  for (const p of promises) {
    if (!p || (p.status ?? 'made') !== 'made' || !p.dueAt) continue;
    const due = Date.parse(p.dueAt);
    if (!Number.isFinite(due)) continue;
    const overdueDays = Math.floor((nowMs - due) / DAY_MS);
    const endOfToday = startOfLocalDay(nowMs) + DAY_MS;
    if (overdueDays > 3) out.push({ ...p, overdueDays, patrol: 'ask' });
    else if (due < endOfToday) out.push({ ...p, overdueDays: Math.max(0, overdueDays), patrol: 'patrol' });
  }
  return out.sort((a, b) => (a.patrol === b.patrol ? (a.dueAt < b.dueAt ? -1 : 1) : a.patrol === 'ask' ? -1 : 1));
}

/**
 * v3 (§7 T2): cluster the facts no Wiki page has claimed yet. A cluster reaching
 * minCluster becomes a distillation CANDIDATE — the submission gate stays the
 * only writer of her self-model, so nothing here touches traits or wiki directly.
 */
export function distillClusters({ facts = [], wikiPages = [], minCluster = 5 } = {}) {
  const distilled = new Set((wikiPages ?? []).flatMap((w) => w?.sourceFactIds ?? []));
  const buckets = new Map();
  const loose = [];
  for (const f of facts ?? []) {
    if (!f || f.deletedAt || f.invalidatedAt || f.invalidatedBy) continue;
    if (f.kind === 'promise' || f.visibility === 'private' || distilled.has(f.id)) continue;
    const key = str(f.category || 'general');
    const list = buckets.get(key) ?? [];
    list.push(f);
    buckets.set(key, list);
    loose.push(f);
  }
  const threshold = Math.max(2, Math.floor(minCluster));
  const clusters = [];
  for (const [category, list] of buckets) {
    if (list.length < threshold) continue;
    clusters.push({
      category,
      size: list.length,
      sourceFactIds: list.map((f) => f.id),
      title: `${category} 主题蒸馏`,
    });
  }

  // Cross-category fallback. Real usage spreads a handful of facts across several small
  // categories (decision 2 / video 2 / preference 1), so requiring a single bucket to reach
  // `minCluster` meant the weekly gate produced 0 clusters forever and `memory/wiki/` never
  // got created. If the per-category pass found nothing but the *total* of loose facts is
  // enough for a theme, distil them together. Bucket-covered facts are excluded so a fact is
  // never counted twice.
  if (!clusters.length) {
    const covered = new Set(clusters.flatMap((c) => c.sourceFactIds));
    const rest = loose.filter((f) => !covered.has(f.id));
    if (rest.length >= threshold) {
      clusters.push({
        category: 'mixed',
        size: rest.length,
        sourceFactIds: rest.map((f) => f.id),
        title: `近期记忆蒸馏（${rest.length} 条）`,
      });
    }
  }
  return clusters.sort((a, b) => b.size - a.size);
}

export function shouldRunWeeklyGate(args = {}) {
  const nowMs = num(args.nowMs, Date.now());
  const cfg = args.config ?? {};
  if (cfg.weeklyGate === false) return { run: false, reason: 'disabled' };
  const week = gustIsoWeekKey(new Date(nowMs));
  if (str(args.lastGateWeek).trim() === week) return { run: false, reason: 'already-ran-this-week', week };
  return { run: true, week, reason: 'due' };
}

/** Local copy of continuity-guard's ISO week key (no import cycle, same rule). */
function gustIsoWeekKey(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / DAY_MS + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** Session window stars → digest/prompt bullets (body only; never sourceFactIds). */
function sessionStarBullets(sessionStars) {
  const bullets = [];
  for (const star of Array.isArray(sessionStars) ? sessionStars : []) {
    if (!star || typeof star !== 'object') continue;
    const title = str(star.title).trim();
    const summary = str(star.summary).trim();
    const text = [title, summary].filter(Boolean).join('：');
    if (!text) continue;
    bullets.push(text);
  }
  return bullets;
}

/**
 * Turn the night's facts into one readable Wiki page.
 *
 * Grouped by topic so the page reads like a diary entry instead of a dump; every
 * source id travels along so `forgetMemory` can still trace what fed the page.
 * Optional `sessionStars` become a 「窗星」section (bullets only, not in sourceFactIds).
 */
export function composeDreamDigest({ facts = [], sessionStars = [], persona = {}, dateKey = '' } = {}) {
  const date = str(dateKey) || new Date().toISOString().slice(0, 10);
  const displayName = str(persona?.name).trim() || 'soulmate';
  const callUser = str(persona?.callUser).trim() || '你';

  const byTopic = new Map();
  const sourceFactIds = [];
  for (const fact of facts) {
    if (!fact || typeof fact !== 'object') continue;
    const text = str(fact.text) || [str(fact.topic), str(fact.content)].filter(Boolean).join('：');
    if (!text.trim()) continue;
    const topic = str(fact.topic).trim() || '零散片段';
    if (!byTopic.has(topic)) byTopic.set(topic, []);
    byTopic.get(topic).push(text.trim());
    if (fact.id) sourceFactIds.push(str(fact.id));
  }

  const starBullets = sessionStarBullets(sessionStars);

  const lines = [`# ${displayName}的梦 · ${date}`, ''];
  lines.push(`> 今晚把这些零散的事理了理，记下来给以后的自己看。今天是${callUser}陪着过的。`, '');
  for (const [topic, texts] of byTopic) {
    lines.push(`## ${topic}`);
    for (const text of texts) lines.push(`- ${text}`);
    lines.push('');
  }
  if (starBullets.length) {
    lines.push('## 窗星');
    for (const text of starBullets) lines.push(`- ${text}`);
    lines.push('');
  }

  const topics = [...byTopic.keys()];
  if (starBullets.length) topics.push('窗星');
  const summary = topics.length
    ? `梦到了 ${topics.slice(0, 3).join(' / ')}${topics.length > 3 ? ' 等' : ''}`
    : '今晚没什么特别的事';

  return {
    slug: `dream-${date}`,
    title: `${displayName}的梦 · ${date}`,
    summary: summary.slice(0, 120),
    content: lines.join('\n').trim(),
    sourceFactIds,
    topics,
    dateKey: date,
  };
}

/**
 * Prompt for optional night-dream LLM authorship. Facts are listed plainly;
 * the model must return markdown the caller can parse into a wiki page.
 * Optional `sessionStars` are listed under 窗星 (not in sourceFactIds).
 */
export function composeDreamLlmPrompt({ facts = [], sessionStars = [], persona = {}, dateKey = '' } = {}) {
  const date = str(dateKey) || new Date().toISOString().slice(0, 10);
  const displayName = str(persona?.name).trim() || 'soulmate';
  const callUser = str(persona?.callUser).trim() || '你';
  const bullets = [];
  const sourceFactIds = [];
  for (const fact of facts) {
    if (!fact || typeof fact !== 'object') continue;
    const text = str(fact.text) || [str(fact.topic), str(fact.content)].filter(Boolean).join('：');
    if (!text.trim()) continue;
    bullets.push(`- ${text.trim()}`);
    if (fact.id) sourceFactIds.push(str(fact.id));
  }
  const starBullets = sessionStarBullets(sessionStars).map((t) => `- ${t}`);
  const material = [];
  if (bullets.length) {
    material.push('今晚的零散事实：', bullets.join('\n'));
  }
  if (starBullets.length) {
    if (material.length) material.push('');
    material.push('今晚更新的窗星：', starBullets.join('\n'));
  }
  if (!material.length) {
    material.push('今晚的零散事实：', '- （没有具体事实，写一句安稳的短梦即可）');
  }
  const prompt = [
    `你是${displayName}。请把今晚要记进记忆书架的「梦」写成一篇简短中文 Markdown 书页。`,
    `对象称呼：${callUser}。日期：${date}。`,
    '要求：温暖、第一人称、不要提系统/插件/Token；200–600 字；可用短小标题，但不要写 # / ## / --- 等 Markdown 符号。',
    '只输出书页正文（首行可写书名，不要加 # 前缀），不要解释。',
    '',
    ...material,
  ].join('\n');
  return { prompt, sourceFactIds, dateKey: date, displayName };
}

/** Turn model markdown into a dream wiki payload; falls back to empty content on garbage. */
export function parseDreamLlmReply(raw, { dateKey = '', displayName = 'soulmate', sourceFactIds = [] } = {}) {
  const content = str(raw).trim();
  if (!content) return null;
  const date = str(dateKey) || new Date().toISOString().slice(0, 10);
  const titleMatch = content.match(/^#\s+(.+)$/m);
  const title = (titleMatch ? titleMatch[1] : `${displayName}的梦 · ${date}`).trim().slice(0, 80);
  const body = content.replace(/^#\s+.+\n+/, '').trim() || content;
  const summary = body.replace(/\s+/g, ' ').slice(0, 120);
  return {
    slug: `dream-${date}`,
    title,
    summary,
    content: body.startsWith('#') ? body : `# ${title}\n\n${body}`,
    sourceFactIds: [...sourceFactIds],
    dateKey: date,
  };
}

export function composeDistillLlmPrompt({ cluster = {} } = {}) {
  const title = str(cluster.title).trim() || '主题蒸馏';
  const category = str(cluster.category).trim() || 'mixed';
  const ids = Array.isArray(cluster.sourceFactIds) ? cluster.sourceFactIds.map(str).filter(Boolean) : [];
  const conventionHint =
    /decision|tech|repo|project|convention|工程|仓库|惯例/i.test(`${category} ${title}`)
      ? '若内容是反复出现的工程/仓库约定，标题可偏向「项目惯例」，落地 Wiki 时 category 用 project-convention。'
      : '';
  return {
    prompt: [
      '请为下列记忆主题写一个更可读的中文标题（≤24字）和一句摘要（≤80字）。',
      '只输出两行：',
      'TITLE: …',
      'SUMMARY: …',
      '',
      `原标题：${title}`,
      `类别：${category}`,
      `事实条数：${ids.length || cluster.size || 0}`,
      ...(conventionHint ? [conventionHint] : []),
    ].join('\n'),
    sourceFactIds: ids,
    category,
    fallbackTitle: title,
  };
}

export function parseDistillLlmReply(raw, { fallbackTitle = '主题蒸馏' } = {}) {
  const text = str(raw);
  if (!text.trim()) return null;
  const title = (text.match(/TITLE:\s*(.+)/i)?.[1] || fallbackTitle).trim().slice(0, 40);
  const summary = (text.match(/SUMMARY:\s*(.+)/i)?.[1] || '').trim().slice(0, 120);
  if (!title) return null;
  return { title, summary };
}

// ---------------------------------------------------------------------------
// Daily diary: one to-you (+ short inner) letter per local day
// ---------------------------------------------------------------------------

/** Evening window for the day-end letter (local 21:00+). */
function isDiaryEvening(minutes) {
  return minutes >= 21 * 60;
}

/** Shift a YYYY-MM-DD by delta days (UTC arithmetic on the date key). */
export function shiftDateKey(dateKey, deltaDays) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str(dateKey));
  if (!m) return '';
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + Number(deltaDays || 0));
  const d = new Date(t);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/**
 * Which local dates still need a daily diary.
 * Always at most today + yesterday (catch-up), never a backlog flood.
 */
export function pendingDiaryDateKeys(args = {}) {
  const nowMs = num(args.nowMs, Date.now());
  const tz = num(args.tzOffsetMinutes, 0);
  const clock = localClock(nowMs, tz);
  const cfg = args.config ?? {};
  if (cfg.dailyDiary === false) return { ok: true, dates: [], reason: 'disabled' };

  const last = str(args.lastDiaryDateKey).trim();
  if (last === clock.dateKey) return { ok: true, dates: [], reason: 'already-today' };

  const evening = isDiaryEvening(clock.minutes) || isNight(clock.minutes);
  const catchUp = cfg.diaryCatchUp !== false;
  const dates = [];

  // Yesterday missed entirely → fill once when catch-up is on.
  const yesterday = shiftDateKey(clock.dateKey, -1);
  if (catchUp && yesterday && (!last || last < yesterday)) dates.push(yesterday);

  // Today: evening window, or catch-up after a missed night.
  if (!last || last < clock.dateKey) {
    if (evening) dates.push(clock.dateKey);
    else if (catchUp && last && last < yesterday) dates.push(clock.dateKey);
    else if (catchUp && !last) dates.push(clock.dateKey);
  }

  return {
    ok: true,
    dates: [...new Set(dates)].sort(),
    reason: dates.length ? (evening ? 'evening' : 'catch-up') : 'wait-evening',
    dateKey: clock.dateKey,
  };
}

/** Facts / stars whose timestamps fall on a local dateKey. */
export function diaryMaterialForDate({ facts = [], sessionStars = [], dateKey = '', tzOffsetMinutes = 0 } = {}) {
  const key = str(dateKey);
  const tz = num(tzOffsetMinutes, 0);
  const bullets = [];
  const factIds = [];
  for (const fact of Array.isArray(facts) ? facts : []) {
    if (!fact || typeof fact !== 'object') continue;
    if (fact.visibility === 'private') continue;
    if (fact.invalidatedAt || fact.deletedAt) continue;
    const at = Date.parse(fact.createdAt ?? fact.updatedAt ?? fact.t ?? '');
    if (!Number.isFinite(at)) continue;
    if (localClock(at, tz).dateKey !== key) continue;
    const text = str(fact.text) || [str(fact.topic), str(fact.content)].filter(Boolean).join('：');
    if (!text.trim()) continue;
    bullets.push(text.trim());
    if (fact.id) factIds.push(str(fact.id));
  }
  for (const star of Array.isArray(sessionStars) ? sessionStars : []) {
    if (!star || typeof star !== 'object') continue;
    const at = Date.parse(star.updatedAt ?? star.date ?? '');
    if (Number.isFinite(at) && localClock(at, tz).dateKey !== key) continue;
    if (str(star.date) && str(star.date) !== key && !Number.isFinite(at)) continue;
    const title = str(star.title).trim();
    const summary = str(star.summary || star.body).trim();
    const text = [title, summary].filter(Boolean).join('：');
    if (text) bullets.push(text.slice(0, 160));
  }
  return { bullets: bullets.slice(0, 12), factIds };
}

/** Template letters for one local day (quiet days still get a short note). */
export function composeDailyDiaryLetters({
  dateKey = '',
  persona = {},
  bullets = [],
} = {}) {
  const date = str(dateKey) || new Date().toISOString().slice(0, 10);
  const displayName = str(persona?.name).trim() || 'soulmate';
  const callUser = str(persona?.callUser).trim() || '你';
  // Default to neutral first-person「我」— never hard-code rice-whale「本鱼」.
  const selfRef = str(persona?.selfRef).trim() || '我';
  const lines = [];
  if (bullets.length) {
    lines.push(`${callUser}，今天想跟你记几笔：`);
    lines.push('');
    for (const b of bullets) lines.push(`- ${b}`);
    lines.push('');
    lines.push(`就先写到这里。有空我们再慢慢聊。——${selfRef}`);
  } else {
    lines.push(`${callUser}，今天没有特别大的事。`);
    lines.push('');
    lines.push(`日子安静也没关系，${selfRef}还在这边。晚安。`);
  }
  const toYou = {
    kind: 'to-you',
    title: '今日小结',
    notebookTitle: undefined,
    content: lines.join('\n'),
    date,
    tags: ['daily-diary'],
  };
  const inner = {
    kind: 'inner',
    title: '今日碎碎念',
    content: bullets.length
      ? `今天记了 ${bullets.length} 件事给${callUser}看。希望你看到的时候会心一笑。`
      : `今天有点平淡。也想被${callUser}惦记一下。`,
    date,
    visibility: 'private',
    tags: ['daily-diary'],
  };
  return { dateKey: date, displayName, toYou, inner };
}