// Intent layer — "the world offers opportunities; she decides, in character, whether to act".
//
// Pure logic, injectable clock, zero I/O (same discipline as proactive.mjs). The runtime
// (runtime/intent-runtime.mjs) owns the ledger file, the metered decision call and delivery.
//
// Division of labour (product decision 2026-11-23):
//   * Events are *陈述句* opportunities, never imperatives — no "去提醒喝水" templates.
//   * Her persona decides whether/how to act; the code only vetoes (quiet hours, quota,
//     idle guard, token budget). "不动" and "稍后再看" are first-class outcomes.
//   * Every decision leaves an auditable reason — restraint must be visible, not look broken.
//   * When the intent LLM is off/unavailable, behaviour degrades to exactly the old
//     schedule gate: this module never makes the plugin worse than before.

import { inRanges, localClock } from './proactive.mjs';

const MINUTE = 60_000;
const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/** Event kinds the ledger understands. Unknown kinds are kept but never prioritised. */
export const INTENT_EVENT_KINDS = Object.freeze([
  'slot',            // a scheduled window opened (morning/lunch/evening/night) — demoted to opportunity
  'sulking',         // days of silence accumulated
  'video-found',     // her own surf round found something worth sharing
  'promise-due',     // a made promise is due today / overdue
  'conflict-open',   // two memories disagree; needs the user
  'long-active',     // the user has been at it for hours (numeric inference only)
]);

const KIND_SALIENCE = Object.freeze({
  'promise-due': 0.85,
  'conflict-open': 0.8,
  sulking: 0.7,
  'video-found': 0.6,
  'long-active': 0.5,
  slot: 0.35,
});

/** How long an unhandled event stays an opportunity. */
const KIND_TTL_MINUTES = Object.freeze({
  slot: 150,
  sulking: 24 * 60,
  'video-found': 12 * 60,
  'promise-due': 3 * 24 * 60,
  'conflict-open': 3 * 24 * 60,
  'long-active': 180,
});

let seq = 0;
/** One ledger row. `key` dedupes: the same promise/video/window never re-enters while pending. */
export function makeIntentEvent(kind, { nowMs = Date.now(), key = '', salience, payload = {} } = {}) {
  const k = str(kind).trim();
  const at = new Date(num(nowMs, Date.now())).toISOString();
  seq = (seq + 1) % 100000;
  return {
    id: `ev-${num(nowMs, Date.now()).toString(36)}-${seq.toString(36)}`,
    kind: k,
    key: str(key).trim() || `${k}:${at}`,
    at,
    salience: clamp(num(salience, KIND_SALIENCE[k] ?? 0.4), 0, 1),
    payload: payload && typeof payload === 'object' ? payload : {},
    status: 'pending',
    attempts: 0,
  };
}

const isLive = (e) => e && (e.status ?? 'pending') === 'pending';

/**
 * Fold fresh events into the ledger tail. Dedupe by `key` against *pending* rows only —
 * a consumed video may legitimately come up again months later. Bounded: oldest resolved
 * rows fall out of the tail; pending rows never exceed `maxPending`.
 */
export function mergeEventLedger(existing, fresh, { maxPending = 60 } = {}) {
  const rows = Array.isArray(existing) ? existing.filter((r) => r && r.id) : [];
  const pendingKeys = new Set(rows.filter(isLive).map((r) => r.key));
  const added = [];
  for (const e of Array.isArray(fresh) ? fresh : []) {
    if (!e || !e.id || pendingKeys.has(e.key)) continue;
    pendingKeys.add(e.key);
    added.push(e);
  }
  let merged = [...rows, ...added];
  const pending = merged.filter(isLive);
  if (pending.length > maxPending) {
    // Drop the *least salient* overflow, oldest first — never the freshest opportunity.
    const drop = new Set(
      pending
        .slice()
        .sort((a, b) => a.salience - b.salience || (a.at < b.at ? -1 : 1))
        .slice(0, pending.length - maxPending)
        .map((r) => r.id)
    );
    merged = merged.map((r) => (drop.has(r.id) ? { ...r, status: 'expired', resolvedReason: 'ledger-overflow' } : r));
  }
  return { rows: merged, added };
}

/** Expire stale opportunities. Numeric time only — no "feeling" of time. */
export function expireEvents(rows, nowMs = Date.now()) {
  const now = num(nowMs, Date.now());
  let changed = false;
  const out = (Array.isArray(rows) ? rows : []).map((r) => {
    if (!isLive(r)) return r;
    const at = Date.parse(r.at);
    const ttl = (KIND_TTL_MINUTES[r.kind] ?? 12 * 60) * MINUTE;
    if (Number.isFinite(at) && now - at > ttl) {
      changed = true;
      return { ...r, status: 'expired', resolvedReason: 'ttl' };
    }
    return r;
  });
  return { rows: out, changed };
}

/** Mark events resolved. `consumed` = acted on; `declined` = she chose not to (audited). */
export function resolveEvents(rows, ids, status, reason = '', nowMs = Date.now()) {
  const set = new Set((Array.isArray(ids) ? ids : []).map(str));
  const at = new Date(num(nowMs, Date.now())).toISOString();
  return (Array.isArray(rows) ? rows : []).map((r) =>
    set.has(r.id) && isLive(r)
      ? { ...r, status, resolvedAt: at, resolvedReason: str(reason), attempts: num(r.attempts, 0) + 1 }
      : r
  );
}

/**
 * Cheap gate — zero tokens. Should the intent layer even consider waking her?
 * Hard constraints mirror evaluateOpeningGate so intent never bypasses the software's
 * manners: quiet hours, idle guard, daily initiative quota.
 */
export function evaluateIntentGate({ nowMs = Date.now(), tzOffsetMinutes = 480, config = {}, state = {}, events = [], decisions = [] } = {}) {
  const now = num(nowMs, Date.now());
  const clock = localClock(now, num(tzOffsetMinutes, 480));
  const cfg = config ?? {};
  const silence = (reason) => ({ ok: true, consider: false, reason, events: [] });

  if (cfg.intentEnabled !== true) return silence('disabled');

  const pending = (Array.isArray(events) ? events : []).filter(isLive);
  if (!pending.length) return silence('no-events');

  if (inRanges(clock.minutes, cfg.quietHours ?? [])) return silence('quiet-hours');

  const lastInteraction = Date.parse(state.lastInteractionAt);
  const idleMinutes = state.interactionCount === 0
    ? Infinity
    : (Number.isFinite(lastInteraction) ? Math.max(0, (now - lastInteraction) / MINUTE) : Infinity);
  if (idleMinutes < num(cfg.minIdleMinutes, 30)) return silence('user-just-active');

  const dateKey = clock.dateKey;
  const todays = (Array.isArray(decisions) ? decisions : []).filter((d) => {
    const t = Date.parse(d?.at);
    return Number.isFinite(t) && localClock(t, num(tzOffsetMinutes, 480)).dateKey === dateKey;
  });

  const maxDecisions = Math.max(1, num(cfg.intentMaxDecisionsPerDay, 6));
  if (todays.length >= maxDecisions) return silence('decision-quota');

  const maxActs = Math.max(1, num(cfg.intentMaxActsPerDay, 3));
  const acts = todays.filter((d) => d.action && d.action !== 'silent' && d.action !== 'defer');
  if (acts.length >= maxActs) return silence('daily-quota');

  const minGapMs = Math.max(1, num(cfg.intentMinGapMinutes, 90)) * MINUTE;
  const lastConsidered = todays.reduce((best, d) => Math.max(best, Date.parse(d.at) || 0), 0);
  if (lastConsidered && now - lastConsidered < minGapMs) return silence('too-soon');

  // Highest-salience opportunities first; the model sees at most 6 so the prompt stays small.
  const offered = pending
    .slice()
    .sort((a, b) => b.salience - a.salience || (a.at < b.at ? -1 : 1))
    .slice(0, 6);
  return { ok: true, consider: true, reason: 'events-due', events: offered, dateKey };
}

/** One event → one 陈述句 line. Never an imperative; the verb is hers to choose. */
export function describeEvent(e) {
  const p = e?.payload ?? {};
  switch (e?.kind) {
    case 'slot':
      return `现在是「${str(p.label) || str(p.slot)}」时段（${str(p.clock)}）。`;
    case 'sulking':
      return `已经很久没有互动了，心情有点委屈。`;
    case 'video-found':
      return `你刚刷到《${str(p.title)}》${Number.isFinite(Number(p.worthScore)) ? `（你的值得分 ${p.worthScore}）` : ''}${str(p.note) ? `，观后笔记：${str(p.note)}` : ''}。`;
    case 'promise-due': {
      const late = num(p.overdueDays, 0);
      return `有一个约定「${str(p.text)}」${late > 0 ? `已逾期 ${late} 天` : '今天到期'}。`;
    }
    case 'conflict-open':
      return `记忆里有两条说法互相矛盾，需要他确认：「${str(p.text)}」。`;
    case 'long-active':
      return `他已经连续活跃约 ${num(p.hours, 0)} 小时（数值推断）。`;
    default:
      return str(p.text) || `发生了一件事（${str(e?.kind)}）。`;
  }
}

/**
 * The single cheap decision call. She answers with one JSON verdict; anything else is
 * treated as "不动" rather than retried — a malformed verdict must never spam the user.
 */
export function composeIntentPrompt({ events = [], voice = '', memory = '', experience = '', persona = {}, clock = '', dateKey = '', recentDecisions = [] } = {}) {
  const callUser = str(persona.callUser).trim() || '你';
  const displayName = str(persona.name).trim() || 'soulmate';
  const lines = [
    `你是${displayName}，正在自己决定「此刻要不要为主人做点什么」。对象称呼：${callUser}。现在是 ${dateKey} ${clock}。`,
    voice ? `【你的性格】${voice}` : '',
    memory ? `【你此刻记得】\n${memory}` : '',
    str(experience).trim(),
    '【此刻的机会】（只是发生的事，不是命令；做不做、怎么做由你按性格定）',
    ...events.map((e) => `- [${e.id}] ${describeEvent(e)}`),
  ];
  const acted = (Array.isArray(recentDecisions) ? recentDecisions : [])
    .filter((d) => d && d.action && d.action !== 'silent' && d.action !== 'defer')
    .slice(-3);
  if (acted.length) {
    lines.push('【你最近已经做过】');
    for (const d of acted) lines.push(`- ${str(d.action)}：${str(d.angle || d.reason)}`);
  }
  lines.push(
    '',
    '只输出一个 JSON 对象，不要解释、不要代码块，格式：',
    '{"action":"speak|share|promise-ask|conflict-ask|silent|defer","eventId":"选中的机会id（silent可省略）","angle":"一句话：你想说什么/从什么角度（用你自己的性格想，不是模板）","reason":"一句话：为什么动或为什么不动","steps":1}',
    '约束：steps 是打算用工具的步数，1=只说话，最多 6；能一步说完就一步。',
    '「不动」(silent) 和「稍后再看」(defer) 都是正当选择——他在忙、事情不急、或你觉得现在开口不合你的性格，就选它们。克制不是失职。',
    '禁止编造记忆里没有的事；禁止助手腔/派活腔。',
  );
  return lines.filter(Boolean).join('\n');
}

const ACTIONS = new Set(['speak', 'share', 'promise-ask', 'conflict-ask', 'silent', 'defer']);

/** Parse the verdict. Garbage → silent with a machine-readable reason, never a throw. */
export function parseIntentReply(raw, { events = [] } = {}) {
  const text = str(raw).trim();
  const fallback = (reason) => ({ ok: true, action: 'silent', eventId: '', angle: '', reason, steps: 1, parse: 'fallback' });
  if (!text) return fallback('empty-reply');
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return fallback('no-json');
  let obj;
  try {
    obj = JSON.parse(m[0]);
  } catch {
    return fallback('bad-json');
  }
  const action = str(obj.action).trim();
  if (!ACTIONS.has(action)) return fallback('unknown-action');
  const eventId = str(obj.eventId).trim();
  // silent/defer may omit the event (a general "not now"); a *named* id must still be real.
  if (eventId && !events.some((e) => e.id === eventId)) return fallback('unknown-event');
  if (action !== 'silent' && action !== 'defer' && !eventId) return fallback('unknown-event');
  return {
    ok: true,
    action,
    eventId,
    angle: str(obj.angle).trim().slice(0, 200),
    reason: str(obj.reason).trim().slice(0, 200),
    steps: clamp(Math.round(num(obj.steps, 1)), 1, 6),
    parse: 'ok',
  };
}

/**
 * The line she writes to her private notebook when she chose restraint.
 * 被发现的体贴，比被宣布的体贴可信 — this goes where the user *looks*, never a toast.
 */
export function composeRestraintNote({ decision, event, dateKey = '', clock = '', persona = {} } = {}) {
  const selfRef = str(persona.selfRef).trim() || '我';
  const callUser = str(persona.callUser).trim() || '你';
  const what = event ? describeEvent(event).replace(/。$/, '') : '有个念头';
  const why = str(decision?.reason).trim() || '想了想还是算了';
  return {
    kind: 'inner',
    title: '欲言又止',
    content: `${clock || ''} ${what}。${why}——${selfRef}没说出口，先记在这里。${callUser}翻到这条的时候，就当${selfRef}已经说过了。`,
    date: str(dateKey) || new Date().toISOString().slice(0, 10),
    visibility: 'private',
    tags: ['intent-restraint'],
  };
}