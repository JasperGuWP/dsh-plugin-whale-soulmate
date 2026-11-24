/**
 * Token usage ledger + daily spend cap (v3 §12 / cost safety).
 *
 * Why this exists: the plugin never had any *real* token accounting. `budget.mjs` only
 * estimates how big a prompt is *before* sending it, and nothing ever read the model's
 * `usage` field. So the moment scheduled work started firing (proactive greetings, IM
 * replies) there was no way to answer "how much did she spend today?".
 *
 * Design decisions:
 *
 *  - **Append-only.** One JSON line per model call in `logs/usage.jsonl`, same shape as the
 *    other audit ledgers (`privacy-audit`, `proactive`, `persona-growth`). Cheap to append,
 *    cheap to tail, never rewrites history.
 *  - **Real numbers when the host gives them, estimates otherwise.** The host's
 *    `generateReply` may or may not return `usage`; when it does not, we fall back to
 *    `estimateTokens` and mark the row `estimated: true` so the UI can say so instead of
 *    pretending an estimate is a measurement.
 *  - **Cap applies to automatic spend only.** The user asking for something is never
 *    blocked; a background greeting at 3am is exactly what a cap is for. Callers pass
 *    `trigger: 'auto' | 'user'` and only `auto` is gated.
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { estimateTokens } from './budget.mjs';

export const USAGE_TRIGGERS = Object.freeze(['auto', 'user']);
/** The automatic work that must live inside the daily cap. */
export const AUTO_KINDS = Object.freeze([
  'proactive',
  'im',
  'dream',
  'distill',
  'dream-llm',
  'distill-llm',
  'intent-llm',
  'engage-llm',
  'im-proactive',
  'experience-llm',
  'reflection',
  'boot',
  'handoff',
]);

const DAY_MS = 86_400_000;

const str = (v) => (v == null ? '' : String(v));
const num = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

/**
 * Normalise whatever the host returned into `{ promptTokens, completionTokens, totalTokens }`.
 *
 * Hosts differ: some return `{ usage: { prompt_tokens, completion_tokens } }`, some
 * `{ usage: { inputTokens, outputTokens } }`, some only `total_tokens`. Accept all three and
 * never invent a number that was not there.
 *
 * @param {any} out the value returned by `generateReply`
 * @returns {{promptTokens:number, completionTokens:number, totalTokens:number, real:boolean}}
 */
export function normalizeUsage(out) {
  const u = out && typeof out === 'object' ? (out.usage ?? out.tokenUsage ?? null) : null;
  if (!u || typeof u !== 'object') {
    return { promptTokens: 0, completionTokens: 0, totalTokens: 0, real: false };
  }
  const promptTokens = num(u.prompt_tokens ?? u.promptTokens ?? u.inputTokens ?? u.input_tokens, 0);
  const completionTokens = num(u.completion_tokens ?? u.completionTokens ?? u.outputTokens ?? u.output_tokens, 0);
  const totalTokens = num(u.total_tokens ?? u.totalTokens, 0) || promptTokens + completionTokens;
  const real = totalTokens > 0;
  return {
    promptTokens: real ? promptTokens : 0,
    completionTokens: real ? completionTokens : 0,
    totalTokens: real ? totalTokens : 0,
    real,
  };
}

/**
 * Build one ledger row. Pure — the caller appends it.
 *
 * @param {object} input
 * @param {string} input.kind     proactive | im | dream | distill | chat | tool
 * @param {'auto'|'user'} input.trigger
 * @param {string} [input.prompt] the prompt text (used for the estimate fallback)
 * @param {string} [input.reply]  the model's text (estimated completion side)
 * @param {object} [input.usage]  whatever `normalizeUsage` produced
 * @param {number} [input.nowMs]
 */
export function buildUsageRow(input = {}) {
  const nowMs = Number.isFinite(Number(input.nowMs)) ? Number(input.nowMs) : Date.now();
  const usage = input.usage ?? null;
  const prompt = str(input.prompt);
  const reply = str(input.reply);
  let promptTokens = num(usage?.promptTokens, 0);
  let completionTokens = num(usage?.completionTokens, 0);
  let estimated = false;

  if (!(usage && usage.real)) {
    // No real numbers: estimate both sides so the cap still has something to work with,
    // but flag the row so the UI never calls an estimate a measurement.
    promptTokens = estimateTokens(prompt);
    completionTokens = estimateTokens(reply);
    estimated = true;
  }
  // A host may report only `total_tokens` (no split). Keep that number rather than
  // collapsing it to 0 + 0 — otherwise the cap would think a real call cost nothing.
  const reportedTotal = num(usage?.totalTokens, 0);
  const totalTokens = Math.max(reportedTotal, promptTokens + completionTokens);

  return {
    at: new Date(nowMs).toISOString(),
    dateKey: localDateKey(nowMs),
    kind: AUTO_KINDS.includes(str(input.kind)) ? str(input.kind) : 'chat',
    trigger: USAGE_TRIGGERS.includes(str(input.trigger)) ? str(input.trigger) : 'user',
    promptTokens,
    completionTokens,
    totalTokens,
    estimated,
    blocked: false,
    note: str(input.note).slice(0, 200),
  };
}

/** A blocked attempt is still a row: "she wanted to speak but the cap stopped her" is a fact. */
export function buildBlockedRow(input = {}) {
  const nowMs = Number.isFinite(Number(input.nowMs)) ? Number(input.nowMs) : Date.now();
  return {
    at: new Date(nowMs).toISOString(),
    dateKey: localDateKey(nowMs),
    kind: AUTO_KINDS.includes(str(input.kind)) ? str(input.kind) : 'proactive',
    trigger: 'auto',
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    estimated: false,
    blocked: true,
    note: str(input.note).slice(0, 200) || 'daily token cap reached',
  };
}

/** Local (not UTC) date key so "today" matches the user's calendar, not the server's. */
export function localDateKey(nowMs, tzOffsetMinutes = 480) {
  const shifted = new Date(Number(nowMs) + num(tzOffsetMinutes, 480) * 60_000);
  return shifted.toISOString().slice(0, 10);
}

/**
 * Sum a ledger for one local day, split by kind and by trigger.
 *
 * @param {object[]} rows parsed ledger rows
 * @param {{dateKey?:string, tzOffsetMinutes?:number, nowMs?:number}} [options]
 */
export function summarizeUsage(rows, options = {}) {
  const tz = num(options.tzOffsetMinutes, 480);
  const dateKey = str(options.dateKey) || localDateKey(num(options.nowMs, Date.now()), tz);
  const list = (Array.isArray(rows) ? rows : []).filter((r) => r && r.dateKey === dateKey);

  const byKind = {};
  let total = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let auto = 0;
  let user = 0;
  let blocked = 0;
  let estimatedCalls = 0;

  for (const row of list) {
    const kind = str(row.kind) || 'chat';
    const t = num(row.totalTokens, 0);
    const bucket = byKind[kind] ?? { kind, calls: 0, totalTokens: 0, blocked: 0, estimated: 0 };
    if (row.blocked) {
      bucket.blocked += 1;
      blocked += 1;
    } else {
      bucket.calls += 1;
      bucket.totalTokens += t;
      if (row.estimated) bucket.estimated += 1;
      total += t;
      promptTokens += num(row.promptTokens, 0);
      completionTokens += num(row.completionTokens, 0);
      if (row.trigger === 'auto') auto += t;
      else user += t;
      if (row.estimated) estimatedCalls += 1;
    }
    byKind[kind] = bucket;
  }

  return {
    dateKey,
    calls: list.filter((r) => !r.blocked).length,
    totalTokens: total,
    promptTokens,
    completionTokens,
    autoTokens: auto,
    userTokens: user,
    blocked,
    estimatedCalls,
    /** True when *any* number above came from the estimator rather than the host. */
    hasEstimates: estimatedCalls > 0,
    byKind: Object.values(byKind).sort((a, b) => b.totalTokens - a.totalTokens),
  };
}

/**
 * Should an automatic call be allowed right now?
 *
 * Only `auto` spend is capped. A user-initiated action always passes — refusing the person
 * in front of you to save tokens is the wrong trade. A cap of 0 or less means "no cap" so
 * existing installs keep working after an upgrade.
 *
 * @param {object} input
 * @param {object[]} input.rows    today's ledger rows (the caller may pre-filter)
 * @param {number} [input.cap]     daily token cap for automatic work
 * @param {string} [input.trigger]
 * @param {string} [input.kind]
 * @returns {{allow:boolean, reason:string, used:number, cap:number, remaining:number}}
 */
export function checkDailyCap(input = {}) {
  const cap = num(input.cap, 0);
  const trigger = USAGE_TRIGGERS.includes(str(input.trigger)) ? str(input.trigger) : 'user';
  const summary = summarizeUsage(input.rows ?? [], input);
  const used = summary.autoTokens;

  if (trigger !== 'auto') {
    return { allow: true, reason: 'user-initiated', used, cap, remaining: cap > 0 ? Math.max(0, cap - used) : Infinity };
  }
  if (!(cap > 0)) {
    return { allow: true, reason: 'no-cap', used, cap: 0, remaining: Infinity };
  }
  if (used >= cap) {
    return { allow: false, reason: 'daily-cap-reached', used, cap, remaining: 0 };
  }
  return { allow: true, reason: 'within-cap', used, cap, remaining: cap - used };
}

/**
 * Dedicated daily cap for one automatic kind (e.g. dream-llm / distill-llm).
 * Independent of the global auto-token pool; callers should gate on both.
 *
 * Cap semantics match checkDailyCap: `cap <= 0` means "no dedicated allowance"
 * for this feature (remaining 0, allow false for auto) — unlike the global cap
 * where 0 means unlimited. Spec: opening the switch with cap 0 must not spend.
 */
export function checkKindDailyCap(input = {}) {
  const kind = str(input.kind);
  const cap = Math.max(0, Math.floor(num(input.cap, 0)));
  const summary = summarizeUsage(input.rows ?? [], input);
  const bucket = (summary.byKind || []).find((b) => b.kind === kind);
  const used = num(bucket?.totalTokens, 0);
  const dateKey = summary.dateKey;

  if (!(cap > 0)) {
    return { allow: false, reason: 'kind-cap-zero', used, cap: 0, remaining: 0, dateKey, kind };
  }
  if (used >= cap) {
    return { allow: false, reason: 'kind-cap-reached', used, cap, remaining: 0, dateKey, kind };
  }
  return { allow: true, reason: 'within-kind-cap', used, cap, remaining: cap - used, dateKey, kind };
}

// ---------------------------------------------------------------------------
// I/O (thin, so the pure helpers above stay testable without a filesystem)
// ---------------------------------------------------------------------------

/** Append one row. Never throws: losing a ledger line must not break a conversation. */
export async function appendUsageRow(usagePath, row) {
  try {
    await mkdir(dirname(usagePath), { recursive: true });
    await appendFile(usagePath, `${JSON.stringify(row)}\n`, 'utf8');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}

/** Read the ledger. Torn lines are skipped rather than losing the whole file. */
export async function readUsageRows(usagePath) {
  try {
    const raw = await readFile(usagePath, 'utf8');
    const out = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (row && typeof row === 'object') out.push(row);
      } catch {
        // skip a torn line
      }
    }
    return out;
  } catch (err) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }
}

/**
 * Compact an old ledger so it does not grow forever.
 * Keeps the most recent `keepDays` of rows; returns how many were dropped.
 */
export function pruneUsageRows(rows, { nowMs = Date.now(), keepDays = 90, tzOffsetMinutes = 480 } = {}) {
  const cutoff = Number(nowMs) - Math.max(1, num(keepDays, 90)) * DAY_MS;
  const kept = (Array.isArray(rows) ? rows : []).filter((r) => {
    const t = Date.parse(str(r?.at));
    return !Number.isFinite(t) || t >= cutoff;
  });
  return { rows: kept, dropped: (Array.isArray(rows) ? rows.length : 0) - kept.length, keepDays };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, Number(ms) || 0)));

/**
 * Drop leading model-planning blurbs that sometimes get concatenated onto the
 * spoken companion line in the session event stream.
 * e.g. "保持沉静守护者人设，话少。\n我在。…" → "我在。…"
 */
export function companionSpokenText(text) {
  let t = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!t) return '';

  const isPlanLine = (line) => {
    const s = String(line || '').trim();
    if (!s) return false;
    if (/不需要工具|简短回应|用户就是|晚间闲聊时段|系统[:：]/.test(s)) return true;
    // "保持沉静守护者人设，话少。" / "人设：…" / "沉静守护者人设"
    if (/人设/.test(s) && s.length <= 40) return true;
    if (/^保持.{0,20}(人设|话少)/.test(s)) return true;
    // Trajectory / thinking / search leaks (should not appear in toast body).
    if (/^(思考|网页搜索|上下文注入|搜索网页)\b/.test(s)) return true;
    if (/^思考\s*[·•]/.test(s) || /^网页搜索\s*[·•]/.test(s)) return true;
    if (/User wants more|Compose a digest|Search for more/i.test(s)) return true;
    return false;
  };

  // Drop leading planning lines (same block or blank-separated).
  const lines = t.split('\n');
  let i = 0;
  while (i < lines.length && (isPlanLine(lines[i]) || !String(lines[i] || '').trim())) i += 1;
  if (i > 0 && i < lines.length) t = lines.slice(i).join('\n').trim();

  // Same-line: "保持…人设，话少。我在。…"
  t = t.replace(/^保持[^。\n]{0,30}人设[^。\n]{0,12}[。．]\s*/u, '').trim();
  t = t.replace(/^[^。\n]{0,24}人设[，,][^。\n]{0,12}[。．]\s*/u, '').trim();

  const parts = t.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  if (parts.length > 1 && isPlanLine(parts[0])) {
    t = parts.slice(1).join('\n\n').trim();
  }
  return t;
}

/**
 * True when `text` is safe to put on the Windows toast (companion spoken line).
 * Rejects wake user-bubbles, plugin instruction dumps, and meta/test English prompts
 * that sometimes show up in the session event stream before the real reply.
 */
export function isToastWorthyReply(text, opts = {}) {
  const spoken = companionSpokenText(text);
  const t = spoken.replace(/\s+/g, ' ').trim();
  if (!t) return false;
  const rejects = Array.isArray(opts.rejectTexts) ? opts.rejectTexts : [];
  for (const raw of rejects) {
    const rr = String(raw || '').replace(/\s+/g, ' ').trim();
    if (!rr) continue;
    if (t === rr || t.includes(rr) || rr.includes(t)) return false;
  }
  if (/【Soulmate 插件/.test(t)) return false;
  if (/勿复述/.test(t) && /插件/.test(t)) return false;
  // Meta / test prompts that leak into the session event stream as fake "replies".
  if (/Same wake|GUI URL|Keep it very short|note port|new port \d+|respond briefly|in character/i.test(t)) return false;
  if (/Keep it to one|Actually counting|let me count|turn\d+\s*wake|msg\d+\b/i.test(t)) return false;
  if (/^(Note the |Keep it |Respond briefly|Again\.)/i.test(t)) return false;
  if (/不需要工具调用|简短回应，别长篇|用户就是闲聊/.test(t)) return false;
  // Still looks like a persona stage-direction, not spoken dialogue.
  if (/^保持.{0,20}人设/.test(t) || (/人设/.test(t) && t.length <= 24)) return false;
  const cjk = (t.match(/[\u4e00-\u9fff]/g) || []).length;
  const latin = (t.match(/[A-Za-z]/g) || []).length;
  // Wake/meta English essays: latin-heavy with little CJK.
  if (latin >= 12 && latin > cjk && /wake|port \d+|Keep it|GUI URL|in character/i.test(t)) return false;
  if (latin >= 12 && latin > cjk && cjk < 2) return false;
  // All DSH chats (not only 专属窗): Chinese preferred; other languages need real length
  // so tiny English fragments / wake echoes stay out.
  if (cjk >= 2) return true;
  if (opts.allowAnyLanguage !== false && t.length >= 40) return true;
  return false;
}

/**
 * Spoken assistant text only.
 * DSH ContentBlockMap includes reasoning / tool-call / image / file — never toast those.
 * (That is what leaked「思考 · …」「网页搜索 · …」into the Windows notification.)
 */
function plainText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) {
    const typ = str(content?.type || 'text');
    if (typ && typ !== 'text') return '';
    return str(content?.text ?? '');
  }
  const parts = [];
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block);
      continue;
    }
    if (!block || typeof block !== 'object') continue;
    const typ = str(block.type || 'text');
    // Skip reasoning, tool-call, tool-addition, tool-removal, image, file, etc.
    if (typ && typ !== 'text') continue;
    if (typeof block.text === 'string') parts.push(block.text);
    else if (typeof block.content === 'string') parts.push(block.content);
  }
  return parts.join('\n');
}

/**
 * Scan a Session events page for the newest assistant/message (and its provider usage).
 * Host shape: `{ type:'assistant/message', data:{ message, usage?: TokenUsage } }`.
 *
 * @returns {{messageId:string, text:string, rawUsage:object|null, usage:ReturnType<typeof normalizeUsage>, assistantCount:number}|null}
 */
export function extractLatestAssistantUsage(pageOrRecords, opts = {}) {
  const records = Array.isArray(pageOrRecords)
    ? pageOrRecords
    : Array.isArray(pageOrRecords?.records)
      ? pageOrRecords.records
      : [];
  const rejectTexts = Array.isArray(opts.rejectTexts) ? opts.rejectTexts : [];
  let best = null;
  let bestWorthy = null;
  let assistantCount = 0;
  for (const rec of records) {
    const ev = rec?.type === 'event' ? rec.event : rec?.event ?? rec;
    if (!ev || typeof ev !== 'object') continue;
    if (str(ev.type) !== 'assistant/message') continue;
    assistantCount += 1;
    const data = ev.data && typeof ev.data === 'object' ? ev.data : ev;
    const message = data.message && typeof data.message === 'object' ? data.message : data;
    const messageId = str(message?.id || data.id || rec?.seq || '');
    const text = plainText(message?.content ?? data?.content).trim();
    const rawUsage = data.usage && typeof data.usage === 'object' ? data.usage : null;
    const usage = normalizeUsage(rawUsage ? { usage: rawUsage } : null);
    best = { messageId, text, rawUsage, usage, assistantCount };
    if (isToastWorthyReply(text, { rejectTexts })) {
      bestWorthy = { messageId, text, rawUsage, usage, assistantCount };
    }
  }
  if (!best) return { messageId: '', text: '', rawUsage: null, usage: normalizeUsage(null), assistantCount: 0 };
  // Prefer the latest toast-worthy (Chinese) line over a newer English meta echo.
  return { ...(bestWorthy || best), assistantCount };
}

/**
 * Sum provider usage across assistant/message events in one session page.
 * Mirrors the host「轨迹 / 统计」turn table so the plugin Token tab can show chat-home spend.
 */
export function sumSessionAssistantUsage(pageOrRecords) {
  const records = Array.isArray(pageOrRecords)
    ? pageOrRecords
    : Array.isArray(pageOrRecords?.records)
      ? pageOrRecords.records
      : [];
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  let turns = 0;
  let withUsage = 0;
  for (const rec of records) {
    const ev = rec?.type === 'event' ? rec.event : rec?.event ?? rec;
    if (!ev || typeof ev !== 'object') continue;
    if (str(ev.type) !== 'assistant/message') continue;
    turns += 1;
    const data = ev.data && typeof ev.data === 'object' ? ev.data : ev;
    const rawUsage = data.usage && typeof data.usage === 'object' ? data.usage : null;
    const usage = normalizeUsage(rawUsage ? { usage: rawUsage } : null);
    if (!usage.real) continue;
    withUsage += 1;
    promptTokens += usage.promptTokens;
    completionTokens += usage.completionTokens;
    totalTokens += usage.totalTokens;
  }
  return {
    promptTokens,
    completionTokens,
    totalTokens,
    turns,
    withUsage,
    ok: turns > 0,
  };
}

/**
 * After `sessionController.prompt` accepts, wait for the turn to finish and read provider usage.
 *
 * Prefer `resolveAgent(...).whenIdle()` (real DSH), then poll `events` for a new
 * `assistant/message` carrying `usage: { inputTokens, outputTokens, ... }`.
 * Without whenIdle, only a short poll window runs so unit tests stay fast.
 *
 * @param {object} controller
 * @param {{sessionId:string, beforeMessageId?:string, beforeAssistantCount?:number, timeoutMs?:number, pollMs?:number, rejectTexts?:string[]}} opts
 */
export async function waitForSessionUsage(controller, opts = {}) {
  const sessionId = str(opts.sessionId).trim();
  if (!sessionId) return { ok: false, reason: 'no-session' };
  if (!controller || typeof controller.events !== 'function') {
    return { ok: false, reason: 'no-events-api' };
  }

  const beforeMessageId = str(opts.beforeMessageId);
  const beforeAssistantCount = Math.max(0, Math.floor(num(opts.beforeAssistantCount, 0)));
  const timeoutMs = Math.max(200, Math.floor(num(opts.timeoutMs, 60_000)));
  const pollMs = Math.max(50, Math.floor(num(opts.pollMs, 400)));
  const rejectTexts = Array.isArray(opts.rejectTexts) ? opts.rejectTexts : [];
  const worthy = (hit) => !!(hit && isToastWorthyReply(hit.text, { rejectTexts }));

  let idleWaited = false;
  if (typeof controller.resolveAgent === 'function') {
    try {
      const resolved = await controller.resolveAgent(sessionId);
      const agent = resolved?.agent ?? resolved;
      if (typeof agent?.whenIdle === 'function') {
        idleWaited = true;
        await Promise.race([Promise.resolve(agent.whenIdle()), sleep(timeoutMs)]);
      }
    } catch {
      // Activation can fail on archived/corrupt sessions — fall through to poll.
    }
  }

  // With whenIdle we already waited for the turn; keep polling a bit so a toast-worthy
  // reply can replace a premature meta/user echo in the event stream.
  // Without it (tests / stripped hosts), do not block for a full minute.
  const pollBudget = idleWaited ? Math.min(20_000, timeoutMs) : Math.min(900, timeoutMs);
  const deadline = Date.now() + pollBudget;
  let last = null;
  let lastWorthy = null;

  while (Date.now() <= deadline) {
    try {
      const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
        ? AbortSignal.timeout(15_000)
        : new AbortController().signal;
      const page = await controller.events({
        address: { kind: 'session', sessionId },
        maxMessages: 40,
      }, signal);
      const hit = extractLatestAssistantUsage(page, { rejectTexts });
      last = hit;
      const newer = hit.assistantCount > beforeAssistantCount
        || (hit.messageId && hit.messageId !== beforeMessageId);
      if (newer && worthy(hit)) {
        lastWorthy = hit;
        if (hit.usage.real) {
          return { ok: true, ...hit, idleWaited };
        }
        // Prefer a real spoken line even without usage — keep polling briefly for usage.
        if (Date.now() + pollMs > deadline) {
          return { ok: true, ...hit, idleWaited, missingUsage: true };
        }
      } else if (newer && !worthy(hit)) {
        // Meta/English echo arrived first — keep waiting for the real Chinese reply.
      }
    } catch (err) {
      return { ok: false, reason: str(err?.message || err?.code || err), idleWaited };
    }
    await sleep(pollMs);
  }

  if (lastWorthy) {
    return { ok: true, ...lastWorthy, idleWaited, timedOut: true };
  }
  if (last && (last.assistantCount > beforeAssistantCount || (last.messageId && last.messageId !== beforeMessageId))) {
    // Newer message exists but was rejected as toast-unworthy (meta / wake echo).
    return { ok: true, ...last, text: '', idleWaited, timedOut: true, rejectedText: true };
  }
  return { ok: false, reason: 'timeout', idleWaited, ...(last || {}) };
}