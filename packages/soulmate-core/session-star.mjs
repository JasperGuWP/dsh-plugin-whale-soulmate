// session-star pure helpers: workspace detect, watch list, summary, fingerprint, debounce.

import path from 'node:path';
import { isWakeBubbleText, stripWakeBubbleMark } from './chat-home.mjs';

const str = (v) => (v == null ? '' : String(v));

const isWin = process.platform === 'win32';

/** Normalize path for cross-platform compare (case-insensitive on Windows). */
function normPath(p) {
  const n = path.normalize(str(p).replace(/\//g, path.sep));
  return isWin ? n.toLowerCase() : n;
}

function pathsEqual(a, b) {
  const na = normPath(a);
  const nb = normPath(b);
  return Boolean(na && nb && na === nb);
}

function pathUnderDir(child, dir) {
  const c = normPath(child);
  const d = normPath(dir);
  if (!c || !d) return false;
  if (c === d) return true;
  const sep = isWin ? '\\' : path.sep;
  const prefix = d.endsWith(sep) ? d : d + sep;
  return c.startsWith(prefix);
}

function pathIncludesPluginSessions(wsPath) {
  const w = normPath(wsPath);
  return w.includes(normPath('plugin-sessions'));
}

/**
 * Whether a workspace belongs to the dedicated chat-home tree.
 */
export function isChatHomeWorkspace(workspace, options = {}) {
  const wsPath = str(workspace?.path);
  const title = str(workspace?.title);
  const pluginSessionsDir = str(options.pluginSessionsDir);
  const personaName = str(options.personaName).trim();

  if (pluginSessionsDir && (pathsEqual(wsPath, pluginSessionsDir) || pathUnderDir(wsPath, pluginSessionsDir))) {
    return true;
  }

  if (personaName && title === `${personaName}消息`) return true;
  if (title === '插件消息') return true;

  if (/消息$/.test(title) && pathIncludesPluginSessions(wsPath)) return true;

  return false;
}

/** Add sessionId to knownSessionIds (immutable return). */
export function registerKnownSession(chatHome, sessionId) {
  const id = str(sessionId).trim();
  if (!id) return chatHome;
  const home = chatHome && typeof chatHome === 'object' ? chatHome : {};
  const known = Array.isArray(home.knownSessionIds) ? [...home.knownSessionIds] : [];
  if (!known.includes(id)) known.push(id);
  return { ...home, knownSessionIds: known };
}

/** active ∪ archive ∪ known, deduped, order preserved. */
export function sessionIdsToWatch(chatHome) {
  const home = chatHome && typeof chatHome === 'object' ? chatHome : {};
  const out = [];
  const add = (id) => {
    const s = str(id).trim();
    if (s && !out.includes(s)) out.push(s);
  };
  add(home.activeSessionId);
  for (const id of home.archiveSessionIds || []) add(id);
  for (const id of home.knownSessionIds || []) add(id);
  return out;
}

/** Compact summary from snippets; skips wake bubbles; keeps tail within maxChars. */
export function composeSessionStarSummary(snippets = [], options = {}) {
  const callUser = str(options.callUser).trim() || '你';
  const maxChars = Math.max(1, Math.floor(Number(options.maxChars) || 6000));
  const lines = [];
  for (const s of Array.isArray(snippets) ? snippets : []) {
    let text = str(s.text);
    if (isWakeBubbleText(text)) continue;
    text = stripWakeBubbleMark(text).replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const role = s.role === 'assistant' ? '我' : callUser;
    lines.push(`- ${role}：${text.slice(0, 180)}`);
  }
  let body = lines.join('\n');
  if (body.length > maxChars) {
    body = body.slice(-maxChars);
  }
  return body;
}

/** Stable fingerprint from turn count and last user/assistant snippet text. */
export function fingerprintMeasure(measure = {}) {
  const turns = Math.max(0, Math.floor(Number(measure.turns) || 0));
  const snippets = Array.isArray(measure.snippets) ? measure.snippets : [];
  let lastUser = '';
  let lastAssistant = '';
  for (const s of snippets) {
    const t = str(s.text);
    if (s.role === 'user') lastUser = t;
    else if (s.role === 'assistant') lastAssistant = t;
  }
  return `${turns}|u:${lastUser}|a:${lastAssistant}`;
}

/**
 * Debounce async work by key; later schedule wins for the same key.
 * @returns {{ schedule(key, fn), flush(), pendingCount(), cancel() }}
 */
export function createDebouncedRunner(options = {}) {
  const waitMs = Math.max(0, Math.floor(Number(options.waitMs) || 2500));
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  /** @type {Map<string, { timer: ReturnType<typeof setTimeout>, fn: () => unknown, at: number }>} */
  const pending = new Map();
  let disposed = false;

  const runFn = (fn) => {
    try {
      const result = fn();
      if (result != null && typeof result.then === 'function') {
        result.catch(() => {});
      }
    } catch {
      /* swallow — debounced side effects must not crash the host */
    }
  };

  const schedule = (key, fn) => {
    if (disposed) return;
    const k = str(key);
    if (!k || typeof fn !== 'function') return;
    const prev = pending.get(k);
    if (prev?.timer != null) clearTimeout(prev.timer);
    const at = now();
    const timer = setTimeout(() => {
      const entry = pending.get(k);
      if (!entry || entry.at !== at) return;
      pending.delete(k);
      runFn(entry.fn);
    }, waitMs);
    timer.unref?.();
    pending.set(k, { timer, fn, at });
  };

  const flush = () => {
    for (const [k, entry] of [...pending.entries()]) {
      if (entry.timer != null) clearTimeout(entry.timer);
      pending.delete(k);
      runFn(entry.fn);
    }
  };

  const pendingCount = () => pending.size;

  /** Plugin teardown: drop pending work instead of writing memory after dispose. */
  const cancel = () => {
    disposed = true;
    for (const entry of pending.values()) {
      if (entry.timer != null) clearTimeout(entry.timer);
    }
    pending.clear();
  };

  return { schedule, flush, pendingCount, cancel };
}

/**
 * Build a session-star summary from measure snippets and upsert once.
 * Pure of host IO except the injected `upsert` (and optional `home` passthrough).
 *
 * @param {object} args
 * @param {string} args.sessionId
 * @param {{ snippets?: Array<{role?:string,text?:string}> }} [args.measure]
 * @param {string} [args.title]
 * @param {string} [args.callUser]
 * @param {number} [args.maxChars]
 * @param {string} [args.workspaceId]
 * @param {number} [args.nowMs]
 * @param {(input: object) => Promise|object} args.upsert
 * @returns {Promise<{ok:boolean, reason?:string, [k:string]: unknown}>}
 */
export async function captureSessionStarOnce(args = {}) {
  const sessionId = str(args.sessionId).trim();
  if (!sessionId) return { ok: false, reason: 'no-session' };
  if (typeof args.upsert !== 'function') return { ok: false, reason: 'no-upsert' };

  const content = composeSessionStarSummary(args.measure?.snippets, {
    callUser: args.callUser,
    maxChars: args.maxChars,
  });
  if (!content.trim()) return { ok: false, reason: 'empty-summary' };

  const title = str(args.title).trim() || sessionId;
  const input = { sessionId, title, content };
  const workspaceId = str(args.workspaceId).trim();
  if (workspaceId) input.workspaceId = workspaceId;
  if (args.nowMs != null && Number.isFinite(Number(args.nowMs))) {
    input.nowMs = Number(args.nowMs);
  }

  return args.upsert(input);
}
