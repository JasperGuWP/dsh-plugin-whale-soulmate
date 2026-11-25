// Soulmate memory engine: Hindsight (facts / experiences) x LLM Wiki (mental models).
// Layout (under home.memoryDir):
//   wiki/<slug>.md + wiki/INDEX.md      L1 mental models, [[wiki links]]
//   facts/facts.jsonl                   L2 syncable facts (half-life, recallCount, supersede)
//   episodes/YYYY-MM-DD-<kind>.md       L3 daily experiences / diaries
//   private/private-facts.jsonl         physically isolated, NEVER synced
//   private/local-notes.md              human-readable mirror of private facts
//   tombstones.jsonl                    soft-delete markers for LWW sync
// Pure Node ESM, zero external dependencies.
import { appendFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { appendPrivacyAudit, inspectAndScrub } from './privacy-firewall.mjs';
import { fitMemoryDigest } from './budget.mjs';
import { jsonSafe } from './small-utils.mjs';
import {
  CONFIDENCE_BANDS,
  MEMORY_KINDS,
  confidenceBand,
  halfLifeFor,
  inferDecayClass,
  isPresenceClass,
  normalizeFact,
  relationshipOf,
  resolveHalfLifeDays,
  trimRank,
  recallScore,
  recencyOf,
  salienceFromImportance,
} from './memory-contract.mjs';

const DAY_MS = 86_400_000;
const EPISODE_KINDS = ['to-you', 'inner'];
const EPISODE_FILE_RE = /^(\d{4}-\d{2}-\d{2})-(to-you|inner)\.md$/;
const SESSION_EPISODE_FILE_RE = /^session__(.+)\.md$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/** Filesystem-safe fragment for session episode filenames (raw id stays in meta). */
export function safeSessionId(sessionId) {
  return str(sessionId)
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .slice(0, 120);
}

// ---------------------------------------------------------------------------
// small utilities
// ---------------------------------------------------------------------------
const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const toMs = (v) => {
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : 0;
};
const resolveNow = (n) => (typeof n === 'number' && Number.isFinite(n) ? n : Date.now());
const round = (n, d = 4) => {
  const f = 10 ** d;
  return Math.round(n * f) / f;
};
const newFactId = () => `f_${randomBytes(6).toString('hex')}`;

function todayYYYYMMDD(ms = Date.now()) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Filesystem-safe wiki slug. Keeps letters (incl. CJK), digits, `_` and `-`. */
export function sanitizeSlug(input) {
  let s = str(input)
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
  if (s === 'index') s = 'index-page'; // INDEX.md is reserved (case-insensitive FS)
  return s;
}

/** Extract unique `[[slug]]` references (sanitized, in order of appearance). */
export function extractWikiLinks(content) {
  const out = [];
  for (const m of str(content).matchAll(/\[\[([^[\]\n|]+?)(?:\|[^[\]\n]*)?\]\]/g)) {
    const slug = sanitizeSlug(m[1]);
    if (slug && !out.includes(slug)) out.push(slug);
  }
  return out;
}

async function readText(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

async function atomicWrite(path, text) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, text, 'utf8');
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

async function readJsonl(path) {
  const raw = await readText(path);
  if (!raw) return [];
  const rows = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row && typeof row === 'object') rows.push(row);
    } catch {
      // skip a torn line rather than losing the whole store
    }
  }
  return rows;
}

const writeJsonl = (path, rows) =>
  atomicWrite(path, rows.length ? `${rows.map((r) => JSON.stringify(r)).join('\n')}\n` : '');

// Serialize every mutation per memory directory (read-modify-write safety).
const locks = new Map();
function withLock(home, fn) {
  const key = home.memoryDir;
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  locks.set(key, next);
  const cleanup = () => {
    if (locks.get(key) === next) locks.delete(key);
  };
  next.then(cleanup, cleanup);
  return next;
}

// ---------------------------------------------------------------------------
// paths + front-matter documents
// ---------------------------------------------------------------------------
const privateFactsPath = (home) => join(home.privateDir, 'private-facts.jsonl');
const tombstonesPath = (home) => join(home.memoryDir, 'tombstones.jsonl');
const wikiPagePath = (home, slug) => join(home.wikiDir, `${slug}.md`);
const episodePath = (home, date, kind, isPrivate) =>
  join(isPrivate ? home.privateDir : home.episodesDir, `${date}-${kind}.md`);
const sessionEpisodePath = (home, sessionId) =>
  join(home.episodesDir, `session__${safeSessionId(sessionId)}.md`);

function serializeDoc(meta, body) {
  const head = Object.entries(meta)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join('\n');
  return `---\n${head}\n---\n\n${str(body).replace(/\s+$/, '')}\n`;
}

function parseDoc(text) {
  const t = str(text).replace(/\r\n/g, '\n');
  if (!t.startsWith('---\n')) return { meta: {}, body: t.replace(/^\n+/, '') };
  const end = t.indexOf('\n---', 3);
  if (end < 0) return { meta: {}, body: t };
  const meta = {};
  for (const line of t.slice(4, end).split('\n')) {
    const m = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (!m) continue;
    try {
      meta[m[1]] = JSON.parse(m[2]);
    } catch {
      meta[m[1]] = m[2];
    }
  }
  let after = t.slice(end + 4);
  if (after.startsWith('\n')) after = after.slice(1);
  return { meta, body: after.replace(/^\n+/, '') };
}

// ---------------------------------------------------------------------------
// privacy gate
// ---------------------------------------------------------------------------
/**
 * Run inspectAndScrub over each named field. On the first blocked field the
 * attempt is written to the privacy audit ledger (never the secret itself).
 */
async function gate(home, op, fields) {
  const scrubbed = {};
  const redactions = [];
  for (const [name, value] of Object.entries(fields)) {
    const check = inspectAndScrub(value);
    if (!check.allowed) {
      await appendPrivacyAudit(home, {
        action: 'memory_write_blocked',
        op,
        field: name,
        reason: check.blockedReason,
      });
      return { allowed: false, blockedReason: check.blockedReason };
    }
    scrubbed[name] = check.scrubbedText;
    redactions.push(...check.redactions);
  }
  return { allowed: true, scrubbed, redactions };
}

// ---------------------------------------------------------------------------
// store loaders
// ---------------------------------------------------------------------------
const isActive = (f) => !!f && !f.deletedAt && !f.invalidatedBy && !f.invalidatedAt;

export async function loadFacts(home) {
  const pub = (await readJsonl(home.factsPath)).map(normalizeFact);
  const priv = (await readJsonl(privateFactsPath(home))).map(normalizeFact);
  return { pub, priv };
}

/**
 * One-shot rewrite of an existing store into the full memory contract.
 *
 * Reads stay backward compatible (normalizeFact migrates on the fly), so this is
 * only here to make the on-disk rows self-describing: a `kind`/`text`/`t` triple
 * the model and the panel can rely on without re-deriving it on every read.
 *
 * Idempotent: a marker file records the rewrite, and rows that already carry the
 * contract are rewritten byte-identically, so a second run is a no-op.
 */
export async function migrateFactsToContract(home) {
  const marker = join(home.memoryDir, '.contract-v2');
  if (await readText(marker)) return { migrated: false, rewritten: 0, reason: 'already-migrated' };

  return withLock(home, async () => {
    const out = { migrated: true, rewritten: 0, facts: 0, privateFacts: 0 };
    let sawStore = false;
    for (const [path, key] of [
      [home.factsPath, 'facts'],
      [privateFactsPath(home), 'privateFacts'],
    ]) {
      if ((await readText(path)) !== null) sawStore = true;
      const rows = await readJsonl(path);
      if (!rows.length) continue;
      const next = rows.map((row) => normalizeFact(row));
      const changed = next.reduce((n, row, i) => (JSON.stringify(row) === JSON.stringify(rows[i]) ? n : n + 1), 0);
      if (changed > 0) {
        await writeJsonl(path, next);
        out.rewritten += changed;
        out[key] = changed;
      }
    }
    // An empty store leaves no marker: writing one into a brand-new home raced
    // with test/teardown rmdir (ENOTEMPTY) and buys nothing (re-scan is two ENOENTs).
    if (sawStore || out.rewritten > 0) await atomicWrite(marker, `${new Date().toISOString()}\n`);
    return out;
  });
}

async function readTombstones(home) {
  return readJsonl(tombstonesPath(home));
}

/** relationship.json is optional for recall; defaults stand in when absent. */
async function readRelationshipSafe(home) {
  if (!home?.relationshipPath) return {};
  try {
    const raw = await readText(home.relationshipPath);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** Merge tombstones keeping the newest deletedAt per kind+id. */
function mergeTombstones(list) {
  const map = new Map();
  for (const t of list) {
    if (!t || !t.kind || !t.id) continue;
    const key = `${t.kind}:${t.id}`;
    const prev = map.get(key);
    if (!prev || toMs(t.deletedAt) >= toMs(prev.deletedAt)) map.set(key, t);
  }
  return [...map.values()];
}

async function fileUpdatedAt(path, metaUpdatedAt) {
  if (metaUpdatedAt && toMs(metaUpdatedAt)) return metaUpdatedAt;
  try {
    return new Date((await stat(path)).mtimeMs).toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

/** Panel/distillation view of the Wiki shelf (§7 T2). */
export const listWikiPages = (home) => readWikiPages(home);

async function readWikiPages(home) {
  let names;
  try {
    names = await readdir(home.wikiDir);
  } catch (err) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }
  const pages = [];
  for (const name of names.sort()) {
    if (!name.endsWith('.md') || name.toUpperCase() === 'INDEX.MD') continue;
    const path = join(home.wikiDir, name);
    const raw = await readText(path);
    if (raw == null) continue;
    const { meta, body } = parseDoc(raw);
    const slug = name.slice(0, -3);
    pages.push({
      slug,
      title: str(meta.title) || slug,
      summary: str(meta.summary),
      category: str(meta.category) || 'mental-model',
      links: Array.isArray(meta.links) ? meta.links : extractWikiLinks(body),
      sourceFactIds: Array.isArray(meta.sourceFactIds) ? meta.sourceFactIds : [],
      updatedAt: await fileUpdatedAt(path, meta.updatedAt),
      // DSH rejects tool results whose own keys hold undefined ("value is not lossless
      // JSON"), so an absent createdAt must be null, never an undefined-valued key.
      createdAt: str(meta.createdAt) || null,
      content: body.trim(),
    });
  }
  return pages;
}

export async function readEpisodes(home, { includePrivate = false } = {}) {
  const out = [];
  const dirs = [{ dir: home.episodesDir, visibility: 'syncable' }];
  if (includePrivate) dirs.push({ dir: home.privateDir, visibility: 'private' });
  for (const { dir, visibility } of dirs) {
    let names;
    try {
      names = await readdir(dir);
    } catch (err) {
      if (err?.code === 'ENOENT') continue;
      throw err;
    }
    for (const name of names.sort()) {
      const m = EPISODE_FILE_RE.exec(name);
      if (m) {
        const file = join(dir, name);
        const raw = await readText(file);
        if (raw == null) continue;
        const { meta, body } = parseDoc(raw);
        out.push({
          id: `${m[1]}-${m[2]}`,
          date: m[1],
          kind: m[2],
          file,
          visibility,
          body: body.trim(),
          updatedAt: await fileUpdatedAt(file, meta.updatedAt),
        });
        continue;
      }
      // Session window stars live only under episodesDir (never privateDir).
      if (dir !== home.episodesDir) continue;
      if (!SESSION_EPISODE_FILE_RE.test(name)) continue;
      const file = join(dir, name);
      const raw = await readText(file);
      if (raw == null) continue;
      const { meta, body } = parseDoc(raw);
      const sessionId = str(meta.sessionId).trim() || name.replace(/^session__/, '').replace(/\.md$/, '');
      if (!sessionId) continue;
      const updatedAt = await fileUpdatedAt(file, meta.updatedAt);
      const vis = meta.visibility === 'private' ? 'private' : visibility;
      if (!includePrivate && vis === 'private') continue;
      out.push({
        id: `session:${sessionId}`,
        date: todayYYYYMMDD(toMs(updatedAt) || Date.now()),
        // meta.kind distinguishes summaries / IM threads / verbatim transcripts
        kind: str(meta.kind).trim() || 'session',
        sessionId,
        title: str(meta.title),
        file,
        visibility: vis,
        body: body.trim(),
        updatedAt,
      });
    }
  }
  return out;
}

/** Session-bound episodes only (window stars). */
export async function listSessionEpisodes(home, options = {}) {
  return (await readEpisodes(home, options)).filter((e) => e.kind === 'session');
}

const eventsIndexPath = (home) => join(home.memoryDir, 'events.jsonl');
/** v3 (§10): append-only op log so promise/resolve transitions never lose to LWW. */
const syncOpsPath = (home) => join(home.memoryDir, 'sync-ops.jsonl');
async function appendSyncOp(home, op) {
  await appendFile(syncOpsPath(home), `${JSON.stringify(op)}\n`, 'utf8').catch(() => {});
}

/** Structured event index (§1.1); absent file = no events yet. */
async function readEvents(home) {
  return (await readJsonl(eventsIndexPath(home))).filter((e) => e && !e.deletedAt);
}

const startOfDayMs = (ms) => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/**
 * v3 (§3.3) zero-dependency temporal parser: "昨天 / 上周 / 上个月 / 2026年3月"
 * become a [from,to] window over local days. No window => keyword-only recall.
 */
export function parseTimeWindow(query, nowMs = Date.now()) {
  const q = str(query);
  const today = startOfDayMs(nowMs);
  if (/今天|今日/.test(q)) return { label: 'today', fromMs: today, toMs: today + DAY_MS - 1 };
  if (/昨天/.test(q)) return { label: 'yesterday', fromMs: today - DAY_MS, toMs: today - 1 };
  if (/前天/.test(q)) return { label: 'two-days-ago', fromMs: today - 2 * DAY_MS, toMs: today - DAY_MS - 1 };
  const d = new Date(nowMs);
  const dow = (d.getDay() + 6) % 7; // Monday = 0
  if (/上周/.test(q)) {
    const start = today - (dow + 7) * DAY_MS;
    return { label: 'last-week', fromMs: start, toMs: start + 7 * DAY_MS - 1 };
  }
  if (/本周|这周/.test(q)) {
    const start = today - dow * DAY_MS;
    return { label: 'this-week', fromMs: start, toMs: start + 7 * DAY_MS - 1 };
  }
  if (/上个月|上月/.test(q)) {
    const from = new Date(d.getFullYear(), d.getMonth() - 1, 1).getTime();
    return { label: 'last-month', fromMs: from, toMs: new Date(d.getFullYear(), d.getMonth(), 1).getTime() - 1 };
  }
  if (/本月|这个月/.test(q)) {
    const from = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
    return { label: 'this-month', fromMs: from, toMs: new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime() - 1 };
  }
  const m = q.match(/(\d{4})[年\-/.](\d{1,2})月?/);
  if (m) {
    const from = new Date(Number(m[1]), Number(m[2]) - 1, 1).getTime();
    return { label: `${m[1]}-${m[2]}`, fromMs: from, toMs: new Date(Number(m[1]), Number(m[2]), 1).getTime() - 1 };
  }
  return null;
}

/** Append-or-replace one row of the structured event index (§1.1). */
async function upsertEventIndex(home, row) {
  const rows = await readJsonl(eventsIndexPath(home));
  const i = rows.findIndex((r) => r && r.id === row.id);
  if (i >= 0) rows[i] = { ...rows[i], ...row };
  else rows.push(row);
  await writeJsonl(eventsIndexPath(home), rows);
}

const autoTagsOf = (text) => {
  const tags = new Set();
  const t = str(text);
  if (/\[video\]|bilibili|bvid|BV[0-9A-Za-z]{6,}/i.test(t)) { tags.add('video'); tags.add('bili'); }
  if (/梦|dream/i.test(t)) tags.add('dream');
  if (/承诺|promise|答应/i.test(t)) tags.add('promise');
  return [...tags];
};

/**
 * One-shot backfill of the event index for stores that predate it (§1.1).
 * Summary = the diary's first entry heading; idempotent via a marker file.
 */
export async function backfillEventsIndex(home) {
  const marker = join(home.memoryDir, '.events-backfill');
  if (await readText(marker)) return { backfilled: false, reason: 'already-backfilled' };
  const episodes = await readEpisodes(home, { includePrivate: true });
  const rows = [];
  for (const e of episodes) {
    if (e.kind === 'session') continue; // window stars are not diary events (Tasks 4–5)
    const firstHeading = (e.body.split('\n').find((l) => l.startsWith('## ') || /^\d{1,2}:\d{2}\b/.test(l)) ?? '')
      .replace(/^##\s*/, '');
    rows.push({
      id: `ev_${e.date}-${e.kind}`,
      date: e.date,
      kind: e.kind,
      visibility: e.visibility,
      tags: autoTagsOf(e.body),
      summary: clipText(firstHeading || e.body.split('\n')[0] || e.date, 80),
      episodeFile: `${e.date}-${e.kind}.md`,
      factIds: [],
      updatedAt: e.updatedAt,
    });
  }
  if (rows.length) await writeJsonl(eventsIndexPath(home), rows);
  await atomicWrite(marker, `${new Date().toISOString()}\n`);
  return { backfilled: true, events: rows.length };
}

/**
 * coEvent (§3.2): how entangled a fact is with the last 14 days of shared
 * experience — direct link from a recent event, or a shared tag.
 */
function coEventOf(fact, events, nowMs) {
  const recent = events.filter((e) => nowMs - toMs(e.updatedAt || e.date) <= 14 * DAY_MS);
  if (!recent.length) return 0;
  const linked = recent.some((e) => Array.isArray(e.factIds) && e.factIds.includes(fact.id));
  const tags = new Set(Array.isArray(fact.tags) ? fact.tags.map(str) : []);
  const overlap = tags.size > 0 && recent.some((e) => (Array.isArray(e.tags) ? e.tags : []).some((t) => tags.has(str(t))));
  return 0.5 * (linked ? 1 : 0) + 0.5 * (overlap ? 1 : 0);
}

async function rebuildWikiIndex(home) {
  const pages = await readWikiPages(home);
  const lines = ['# Soulmate Wiki Index', ''];
  for (const p of pages) {
    const summary = p.summary ? ` — ${p.summary.replace(/\s+/g, ' ')}` : '';
    lines.push(`- [[${p.slug}]] ${p.title}${summary} (${p.category})`);
  }
  await atomicWrite(home.wikiIndexPath, `${lines.join('\n')}\n`);
}

// ---------------------------------------------------------------------------
// Retain
// ---------------------------------------------------------------------------
export async function retainFact(home, input = {}) {
  const topic = str(input.topic).trim();
  const content = str(input.content).trim();
  const text = str(input.text).trim();
  if ((!topic || !content) && !text) return { ok: false, error: 'topic and content (or text) are required' };
  const isPrivate = input.visibility === 'private';

  // v3 (§1): the decay class decides the curve; the write path may only nudge it.
  const decayClass = inferDecayClass(input);
  const kindEarly = MEMORY_KINDS.includes(input.kind) ? input.kind : str(input.category) === 'promise' ? 'promise' : 'semantic';
  const halfLife = resolveHalfLifeDays({ kind: kindEarly, decayClass, requested: input.halfLifeDays });
  if (!halfLife.ok) return { ok: false, error: halfLife.error };

  // v3 (§9.2): the contract `text` passes the firewall too — v2 let a secret in
  // via `text` alone, and raw topic/content leaked into the stored `text`.
  const check = await gate(home, 'retainFact', { topic, content, text });
  if (!check.allowed) return { ok: false, blockedReason: check.blockedReason };

  return withLock(home, async () => {
    const nowMs = resolveNow(input.nowMs);
    const iso = new Date(nowMs).toISOString();
    const { pub, priv } = await loadFacts(home);
    const [mine, other, minePath, otherPath] = isPrivate
      ? [priv, pub, privateFactsPath(home), home.factsPath]
      : [pub, priv, home.factsPath, privateFactsPath(home)];

    const id = str(input.id).trim() || newFactId();
    const prev = mine.find((f) => f.id === id);
    // Memory contract: kind / text / t / salience / confidence / evidence.
      const kind = kindEarly;
    const importance = clamp(Math.round(Number(input.importance ?? 3)) || 3, 1, 5);
    const salience = Number.isFinite(Number(input.salience))
      ? clamp(Number(input.salience), 0, 1)
      : salienceFromImportance(importance);
    const confidence = Number.isFinite(Number(input.confidence)) ? clamp(Number(input.confidence), 0, 1) : 0.6;
    // v3 (§9.2): the stored text is built from SCRUBBED fields; private keeps raw.
    const scrubbedText = isPrivate
      ? text || `${topic}：${content}`
      : check.scrubbed.text || `${check.scrubbed.topic}：${check.scrubbed.content}`;
    const provIn = input.provenance && typeof input.provenance === 'object' ? input.provenance : {};
    const provenance = {
      source: str(provIn.source).trim() || str(input.source).trim() || 'chat',
      sessionId: str(provIn.sessionId).trim() || str(input.sessionId).trim() || null,
      at: str(provIn.at).trim() || iso,
    };
    const promiseIn = input.promise && typeof input.promise === 'object' ? input.promise : {};
    const promise =
      kind === 'promise'
        ? {
            status: ['made', 'kept', 'broken', 'released'].includes(promiseIn.status) ? promiseIn.status : 'made',
            dueAt: str(promiseIn.dueAt ?? input.dueAt).trim() || null,
            note: str(promiseIn.note).trim() || null,
          }
        : null;
    const fact = {
      id,
      kind,
      decayClass,
      text: scrubbedText,
      t: str(input.t) || iso,
      salience,
      confidence,
      evidence: Array.isArray(input.evidence) ? input.evidence.map(str).filter(Boolean) : [],
      provenance,
      promise,
      conflictWith: null,
      conflictOpenedAt: null,
      topic: isPrivate ? topic : check.scrubbed.topic || topic,
      content: isPrivate ? content : check.scrubbed.content || content,
      category: str(input.category).trim() || 'general',
      importance,
      visibility: isPrivate ? 'private' : 'syncable',
      halfLifeDays: halfLife.value,
      recallCount: prev?.recallCount ?? 0,
      createdAt: prev?.createdAt ?? iso,
      updatedAt: iso,
      lastRecalledAt: iso,
      invalidatedAt: null,
      invalidatedBy: null,
      deletedAt: null,
    };

    const dirty = new Set();
    const idx = mine.findIndex((f) => f.id === id);
    if (idx >= 0) mine[idx] = fact;
    else mine.push(fact);
    dirty.add(minePath);

    // an id lives in exactly one store
    const dupe = other.findIndex((f) => f.id === id);
    if (dupe >= 0) {
      other.splice(dupe, 1);
      dirty.add(otherPath);
    }

    const supersedesId = str(input.supersedesId).trim();
    if (supersedesId && supersedesId !== id) {
      for (const [list, path] of [
        [pub, home.factsPath],
        [priv, privateFactsPath(home)],
      ]) {
        const old = list.find((f) => f.id === supersedesId);
        if (old) {
          old.invalidatedAt = iso;
          old.invalidatedBy = id;
          old.updatedAt = iso;
          dirty.add(path);
        }
      }
    }

    // v3 (§6): park contradictions instead of letting them co-exist silently.
    // The explicit supersedesId fast path skips detection by design.
    if (!supersedesId && !fact.conflictWith) {
      const tokens = tokenizeQuery(fact.text);
      for (const [list, path] of [[pub, home.factsPath], [priv, privateFactsPath(home)]]) {
        let opened = false;
        for (const old of list) {
          if (!isActive(old) || old.id === id || old.decayClass !== fact.decayClass) continue;
          if (old.conflictWith) continue;
          const sim = similarityOf(tokens, keywordScore(tokens, old.text));
          if (sim < 0.6 || !polarityOpposite(fact.text, old.text)) continue;
          // Handoff / system-noise pairs: keep the incoming row, retire the old —
          // never park a conflict that would ask the user to click 保留新/旧.
          if (shouldAutoResolveConflict(fact, old)) {
            old.invalidatedAt = iso;
            old.invalidatedBy = id;
            old.conflictWith = null;
            old.conflictOpenedAt = null;
            old.conflictOpenedConfidence = undefined;
            old.updatedAt = iso;
            dirty.add(path);
            await appendPrivacyAudit(home, { action: 'conflict_auto_resolved', id, dropped: old.id, reason: 'noise' });
            opened = true;
            break;
          }
          old.conflictWith = id;
          old.conflictOpenedAt = iso;
          old.conflictOpenedConfidence = old.confidence;
          old.confidence = Math.min(old.confidence, CONFIDENCE_BANDS.hold);
          old.updatedAt = iso;
          fact.conflictWith = old.id;
          fact.conflictOpenedAt = iso;
          fact.conflictOpenedConfidence = confidence;
          fact.confidence = Math.min(fact.confidence, CONFIDENCE_BANDS.hold);
          dirty.add(path);
          await appendPrivacyAudit(home, { action: 'conflict_opened', id, with: old.id });
          opened = true;
          break;
        }
        if (opened) break;
      }
    }

    for (const path of dirty) await writeJsonl(path, path === home.factsPath ? pub : priv);

    if (isPrivate) {
      await mkdir(home.privateDir, { recursive: true });
      await appendFile(
        home.privateNotesPath,
        `\n## ${fact.topic} (${fact.id})\n\n- importance: ${fact.importance} · category: ${fact.category} · ${iso}\n\n${fact.content}\n`,
        'utf8'
      );
    }
    return { ok: true, fact, storedIn: isPrivate ? 'private' : 'facts' };
  });
}

// ---------------------------------------------------------------------------
// Experiences (episodes)
// ---------------------------------------------------------------------------

/**
 * One file per dialog session (window star). Overwrites the whole body on each
 * upsert — deleting a sidebar dialog must NOT call this forget path.
 */
export async function upsertSessionEpisode(home, input = {}) {
  const sessionId = str(input.sessionId).trim();
  if (!sessionId) return { ok: false, error: 'sessionId is required' };
  const content = str(input.content).trim();
  if (!content) return { ok: false, error: 'content is required' };
  const isPrivate = input.visibility === 'private';
  const title = str(input.title).trim();
  // `im` = an IM thread; `transcript` = the verbatim conversation of a chat-home window.
  const kind = ['session', 'im', 'transcript'].includes(str(input.kind)) ? str(input.kind) : 'session';

  const check = await gate(home, 'upsertSessionEpisode', { title, content });
  if (!check.allowed) return { ok: false, blockedReason: check.blockedReason };
  const pick = (name, raw) => (isPrivate ? str(raw).trim() : check.scrubbed[name].trim());

  return withLock(home, async () => {
    const nowMs = resolveNow(input.nowMs);
    const iso = new Date(nowMs).toISOString();
    const file = sessionEpisodePath(home, sessionId);
    const safeTitle = pick('title', title);
    const safeContent = pick('content', content);
    const heading = safeTitle || sessionId;
    const body = `# ${heading}\n\n${safeContent}`;
    await atomicWrite(
      file,
      serializeDoc(
        {
          kind,
          sessionId,
          title: safeTitle,
          workspaceId: str(input.workspaceId).trim(),
          visibility: isPrivate ? 'private' : 'syncable',
          updatedAt: iso,
        },
        body
      )
    );
    return { ok: true, id: `session:${sessionId}`, file, updatedAt: iso };
  });
}

export async function recordEpisode(home, input = {}) {
  const nowMs = resolveNow(input.nowMs);
  const date = str(input.date).trim() || todayYYYYMMDD(nowMs);
  const kind = str(input.kind).trim() || 'to-you';
  const content = str(input.content).trim();
  if (!DATE_RE.test(date)) return { ok: false, error: 'date must be YYYY-MM-DD' };
  if (!EPISODE_KINDS.includes(kind)) return { ok: false, error: `kind must be one of ${EPISODE_KINDS.join(', ')}` };
  if (!content) return { ok: false, error: 'content is required' };
  const isPrivate = input.visibility === 'private';

  const check = await gate(home, 'recordEpisode', {
    title: input.title,
    notebookTitle: input.notebookTitle,
    content,
  });
  if (!check.allowed) return { ok: false, blockedReason: check.blockedReason };
  const pick = (name, raw) => (isPrivate ? str(raw).trim() : check.scrubbed[name].trim());

  return withLock(home, async () => {
    const iso = new Date(nowMs).toISOString();
    const file = episodePath(home, date, kind, isPrivate);
    const title = pick('title', input.title);
    const notebook = pick('notebookTitle', input.notebookTitle);
    const d = new Date(nowMs);
    const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    // Plain time headers (no markdown # / ##) — panel & bookshelf show this as-is.
    const entry = `${hhmm}${title ? ` · ${title}` : ''}\n\n${pick('content', content)}\n`;

    const existing = await readText(file);
    let body;
    if (existing != null) {
      body = `${parseDoc(existing).body.trimEnd()}\n\n${entry}`;
    } else {
      const heading = notebook || `${date} ${kind === 'inner' ? '小本本' : '给你的信'}`;
      body = `${heading}\n\n${entry}`;
    }
    await atomicWrite(
      file,
      serializeDoc({ date, kind, visibility: isPrivate ? 'private' : 'syncable', updatedAt: iso }, body)
    );
    // v3 (§1.1): the prose stays human; the machine-readable mirror lives here.
    await upsertEventIndex(home, {
      id: `ev_${date}-${kind}`,
      date,
      kind,
      visibility: isPrivate ? 'private' : 'syncable',
      tags: [...new Set([...(Array.isArray(input.tags) ? input.tags.map(str) : []), ...autoTagsOf(`${title} ${content}`)])],
      summary: clipText(title || content.split('\n')[0], 80),
      episodeFile: `${date}-${kind}.md`,
      factIds: Array.isArray(input.factIds) ? input.factIds.map(str).filter(Boolean) : [],
      updatedAt: iso,
    });
    return { ok: true, date, kind, file, updatedAt: iso };
  });
}

// ---------------------------------------------------------------------------
// Reflect (Wiki)
// ---------------------------------------------------------------------------
export async function reflectToWiki(home, input = {}) {
  const slug = sanitizeSlug(input.slug);
  if (!slug) return { ok: false, error: 'invalid slug' };
  const content = str(input.content).trim();
  if (!content) return { ok: false, error: 'content is required' };

  const check = await gate(home, 'reflectToWiki', {
    title: str(input.title).trim() || slug,
    summary: input.summary,
    content,
  });
  if (!check.allowed) return { ok: false, blockedReason: check.blockedReason };

  return withLock(home, async () => {
    const updatedAt = new Date(resolveNow(input.nowMs)).toISOString();
    const links = extractWikiLinks(check.scrubbed.content).filter((l) => l !== slug);
    const page = {
      slug,
      title: check.scrubbed.title.trim(),
      summary: check.scrubbed.summary.trim(),
      category: str(input.category).trim() || 'mental-model',
      links,
      updatedAt,
    };
    const sourceFactIds = Array.isArray(input.sourceFactIds) ? input.sourceFactIds.map(str).filter(Boolean) : [];
    await atomicWrite(
      wikiPagePath(home, slug),
      serializeDoc({ ...page, sourceFactIds }, check.scrubbed.content)
    );
    await rebuildWikiIndex(home);
    return { ok: true, page };
  });
}

// ---------------------------------------------------------------------------
// Recall
// ---------------------------------------------------------------------------
/** ASCII words + Chinese characters + Chinese bigrams. */
export function tokenizeQuery(query) {
  const s = str(query).toLowerCase();
  const words = new Set();
  const chars = new Set();
  const bigrams = new Set();
  for (const m of s.matchAll(/[a-z0-9_]+/g)) if (m[0].length >= 2) words.add(m[0]);
  for (const m of s.matchAll(/[\u4e00-\u9fff]+/g)) {
    const run = [...m[0]];
    for (let i = 0; i < run.length; i++) {
      chars.add(run[i]);
      if (i + 1 < run.length) bigrams.add(run[i] + run[i + 1]);
    }
  }
  return { words: [...words], chars: [...chars], bigrams: [...bigrams] };
}

function keywordScore(tokens, text) {
  const h = str(text).toLowerCase();
  if (!h) return 0;
  let s = 0;
  for (const w of tokens.words) if (h.includes(w)) s += 2;
  for (const b of tokens.bigrams) if (h.includes(b)) s += 1.5;
  for (const c of tokens.chars) if (h.includes(c)) s += 0.4;
  return s;
}

/**
 * Normalise keyword overlap into 0..1 so it can enter the design's weighted sum.
 * The raw sum is unbounded, so it saturates against the query's own token
 * mass: a document matching every query token scores 1.
 */
function similarityOf(tokens, keywordRaw) {
  const mass =
    2 * tokens.words.length + 1.5 * tokens.bigrams.length + 0.4 * tokens.chars.length;
  if (!(mass > 0)) return 0;
  return clamp(keywordRaw / mass, 0, 1);
}

const isEmptyQuery = (t) => !t.words.length && !t.chars.length;
const minMatch = (t) => (isEmptyQuery(t) ? -1 : t.words.length || t.bigrams.length ? 1 : 0.3);

/** Freshness kept for the 3D nebula's energy glow — recall itself uses recencyOf(). */
function freshness(fact, nowMs) {
  return recencyOf(fact, nowMs);
}

function snippetAround(tokens, text, width = 60) {
  const t = str(text).replace(/\s+/g, ' ');
  const lower = t.toLowerCase();
  let at = -1;
  for (const k of [...tokens.words, ...tokens.bigrams, ...tokens.chars]) {
    at = lower.indexOf(k);
    if (at >= 0) break;
  }
  const start = Math.max(0, at < 0 ? 0 : at - width);
  return t.slice(start, start + width * 2 + 20);
}

export async function recallMemory(home, query, options = {}) {
  const limit = Math.max(1, Math.floor(Number(options.limit ?? 5)) || 5);
  const includePrivate = options.includePrivate !== false;
  const nowMs = resolveNow(options.nowMs);
  const tokens = tokenizeQuery(query);
  const threshold = minMatch(tokens);
  // The relationship term needs warmth/trust; callers may pass it, otherwise read
  // relationship.json. A missing file is normal (defaults), not an error.
  const relationship =
    options.relationship ?? (await readRelationshipSafe(home));

  const run = async () => {
    const { pub, priv } = await loadFacts(home);
    const events = await readEvents(home);
    const candidates = [
      ...pub.filter(isActive).map((f) => ({ f, store: 'pub' })),
      ...(includePrivate ? priv.filter(isActive).map((f) => ({ f, store: 'priv' })) : []),
    ];
    const scored = [];
    for (const c of candidates) {
      // v3 (§3.2): score the contract text once — v2 double-counted topic/content.
      const kw = keywordScore(tokens, c.f.text);
      if (kw <= threshold) continue;
      // Design §4: 0.55 similarity + 0.25 salience + 0.15 recency + 0.05 relationship.
      const { score, parts } = recallScore({
        similarity: similarityOf(tokens, kw),
        fact: c.f,
        nowMs,
        relationship,
        coEvent: coEventOf(c.f, events, nowMs),
      });
      scored.push({ ...c, score, parts });
    }
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, limit);

    if (options.reinforce === true && top.length) {
      const iso = new Date(nowMs).toISOString();
      const hit = { pub: new Set(), priv: new Set() };
      for (const t of top) hit[t.store].add(t.f.id);
      for (const t of top) {
        t.f.recallCount = (Number(t.f.recallCount) || 0) + 1;
        t.f.lastRecalledAt = iso;
      }
      if (hit.pub.size) await writeJsonl(home.factsPath, pub);
      if (hit.priv.size) await writeJsonl(privateFactsPath(home), priv);
    }
    const facts = top.map((t) => ({
      ...t.f,
      score: round(t.score),
      scoreParts: {
        similarity: round(t.parts.similarity),
        salience: round(t.parts.salience),
        recency: round(t.parts.recency),
        relationship: round(t.parts.relationship),
      },
      confidenceBand: confidenceBand(t.f),
    }));

    // Wiki + 1-hop links
    const pages = await readWikiPages(home);
    const byslug = new Map(pages.map((p) => [p.slug, p]));
    const wikiHits = [];
    for (const p of pages) {
      const kw = 1.5 * keywordScore(tokens, `${p.title}\n${p.summary}`) + keywordScore(tokens, p.content);
      if (kw > threshold) wikiHits.push({ p, score: kw });
    }
    wikiHits.sort((a, b) => b.score - a.score);
    const wiki = wikiHits.slice(0, limit).map(({ p, score }) => ({ ...p, score: round(score) }));
    const linkedWiki = [];
    const seen = new Set();
    for (const w of wiki) {
      for (const slug of w.links) {
        const target = byslug.get(slug);
        if (!target || seen.has(slug)) continue;
        seen.add(slug);
        linkedWiki.push({ ...target, linkedFrom: [w.slug] });
      }
    }
    for (const lw of linkedWiki) {
      lw.linkedFrom = wiki.filter((w) => w.links.includes(lw.slug)).map((w) => w.slug);
    }

    // recent episodes
    const eps = (await readEpisodes(home, { includePrivate })).sort((a, b) =>
      a.date === b.date ? (a.kind < b.kind ? 1 : -1) : a.date < b.date ? 1 : -1
    );
    const episodes = [];
    for (const e of eps.slice(0, 60)) {
      const kw = keywordScore(tokens, e.body);
      if (kw <= threshold) continue;
      episodes.push({
        date: e.date,
        kind: e.kind,
        file: e.file,
        visibility: e.visibility,
        updatedAt: e.updatedAt,
        score: round(kw),
        snippet: snippetAround(tokens, e.body),
      });
      if (episodes.length >= limit) break;
    }
    // v3 (§3.1/§3.3): the temporal channel answers "what did we do last month"
    // without any keyword overlap; open promises always travel with the result.
    const window = parseTimeWindow(query, nowMs);
    const mergedEpisodes = [...episodes];
    if (window) {
      const inWindow = events
        .filter((e) => {
          const ms = toMs(e.date);
          return ms >= window.fromMs && ms <= window.toMs;
        })
        .filter((e) => includePrivate || e.visibility !== 'private')
        .sort((a, b) => (a.date < b.date ? 1 : -1));
      for (const e of inWindow) {
        if (mergedEpisodes.length >= limit * 2) break;
        if (mergedEpisodes.some((x) => x.date === e.date && x.kind === e.kind)) continue;
        const ep = eps.find((x) => x.date === e.date && x.kind === e.kind);
        const tagHit = (Array.isArray(e.tags) ? e.tags : []).some(
          (t) => tokens.words.includes(str(t).toLowerCase()) || tokens.bigrams.includes(str(t))
        );
        mergedEpisodes.push({
          date: e.date,
          kind: e.kind,
          file: ep?.file ?? join(home.episodesDir, e.episodeFile ?? `${e.date}-${e.kind}.md`),
          visibility: e.visibility,
          updatedAt: e.updatedAt,
          via: 'temporal',
          score: round(
            clamp(
              0.4 + 0.4 * (tagHit ? 1 : 0) + 0.2 * recencyOf({ halfLifeDays: 90, recallCount: 0, updatedAt: e.updatedAt }, nowMs),
              0,
              1
            )
          ),
          snippet: e.summary || snippetAround(tokens, ep?.body ?? ''),
        });
      }
    }
    const promises = candidates
      .filter((c) => c.f.kind === 'promise' && (c.f.promise?.status ?? 'made') === 'made')
      .slice(0, 5)
      .map((c) => ({ id: c.f.id, text: c.f.text, dueAt: c.f.promise?.dueAt ?? null }));
    // jsonSafe: facts loaded from jsonl may carry undefined-valued keys (e.g. an
    // unset halfLifeDays/conflictOpenedConfidence); DSH's lossless-JSON gate rejects
    // the whole recall over any one of them.
    return jsonSafe({ ok: true, facts, wiki, linkedWiki, episodes: mergedEpisodes, promises, temporalWindow: window?.label ?? null });
  };

  return options.reinforce === true ? withLock(home, run) : run();
}

// ---------------------------------------------------------------------------
// HUD surgery: reinforce / toggle privacy / forget
// ---------------------------------------------------------------------------
const stripPrefix = (id, prefix) => (id.startsWith(prefix) ? id.slice(prefix.length) : id);

export async function reinforceMemoryNode(home, id, options = {}) {
  const target = str(id).trim();
  if (!target) return { ok: false, error: 'id is required' };
  return withLock(home, async () => {
    const iso = new Date(resolveNow(options.nowMs)).toISOString();
    const { pub, priv } = await loadFacts(home);
    for (const [list, path] of [
      [pub, home.factsPath],
      [priv, privateFactsPath(home)],
    ]) {
      const fact = list.find((f) => f.id === target && isActive(f));
      if (!fact) continue;
      fact.recallCount = (Number(fact.recallCount) || 0) + 2;
      fact.lastRecalledAt = iso;
      fact.updatedAt = iso;
      await writeJsonl(path, list);
      return { ok: true, fact: { ...fact } };
    }
    return { ok: false, error: `memory node not found: ${target}` };
  });
}

export async function toggleMemoryPrivacy(home, id, options = {}) {
  const target = str(id).trim();
  if (!target) return { ok: false, error: 'id is required' };

  const pre = await loadFacts(home);
  const toPrivate = pre.pub.some((f) => f.id === target && isActive(f));
  const fromPrivate = pre.priv.some((f) => f.id === target && isActive(f));
  if (!toPrivate && !fromPrivate) return { ok: false, error: `fact not found: ${target}` };

  // moving into the syncable store must pass the outbound gate
  let scrubbed = null;
  if (fromPrivate) {
    const f = pre.priv.find((x) => x.id === target);
    const check = await gate(home, 'toggleMemoryPrivacy', { topic: f.topic, content: f.content });
    if (!check.allowed) return { ok: false, blockedReason: check.blockedReason };
    scrubbed = check.scrubbed;
  }

  return withLock(home, async () => {
    const iso = new Date(resolveNow(options.nowMs)).toISOString();
    const { pub, priv } = await loadFacts(home);
    if (toPrivate) {
      const i = pub.findIndex((f) => f.id === target && isActive(f));
      if (i < 0) return { ok: false, error: `fact not found: ${target}` };
      const [fact] = pub.splice(i, 1);
      const moved = { ...fact, visibility: 'private', updatedAt: iso };
      priv.push(moved);
      await writeJsonl(home.factsPath, pub);
      await writeJsonl(privateFactsPath(home), priv);
      // tell the cloud to drop its copy of what is now local-only
      const tombs = mergeTombstones([...(await readTombstones(home)), { kind: 'fact', id: target, deletedAt: iso }]);
      await writeJsonl(tombstonesPath(home), tombs);
      await mkdir(home.privateDir, { recursive: true });
      await appendFile(
        home.privateNotesPath,
        `\n## ${moved.topic} (${moved.id})\n\n- moved to private · ${iso}\n\n${moved.content}\n`,
        'utf8'
      );
      return { ok: true, fact: moved, visibility: 'private', storedIn: 'private' };
    }
    const i = priv.findIndex((f) => f.id === target && isActive(f));
    if (i < 0) return { ok: false, error: `fact not found: ${target}` };
    const [fact] = priv.splice(i, 1);
    const moved = {
      ...fact,
      topic: scrubbed.topic,
      content: scrubbed.content,
      visibility: 'syncable',
      updatedAt: iso,
    };
    pub.push(moved);
    await writeJsonl(privateFactsPath(home), priv);
    await writeJsonl(home.factsPath, pub);
    const tombs = (await readTombstones(home)).filter((t) => !(t.kind === 'fact' && t.id === target));
    await writeJsonl(tombstonesPath(home), tombs);
    return { ok: true, fact: moved, visibility: 'syncable', storedIn: 'facts' };
  });
}

export async function forgetMemory(home, targetIdOrSlug, options = {}) {
  const raw = str(targetIdOrSlug).trim();
  if (!raw) return { ok: false, error: 'id is required' };
  if (/^(remote|capability):/.test(raw)) {
    return { ok: false, error: 'remote nodes cannot be forgotten locally; use the cloud wipe API' };
  }

  return withLock(home, async () => {
    const iso = new Date(resolveNow(options.nowMs)).toISOString();
    const done = async (kind, id, isPrivate) => {
      const tombs = mergeTombstones([
        ...(await readTombstones(home)),
        { kind, id, deletedAt: iso, ...(isPrivate ? { visibility: 'private' } : {}) },
      ]);
      await writeJsonl(tombstonesPath(home), tombs);
      return { ok: true, kind, id, deletedAt: iso };
    };

    const explicitWiki = raw.startsWith('wiki:');
    const explicitEpisode = /^episode(-private)?:/.test(raw);

    if (!explicitWiki && !explicitEpisode) {
      const { pub, priv } = await loadFacts(home);
      for (const [list, path, isPrivate] of [
        [pub, home.factsPath, false],
        [priv, privateFactsPath(home), true],
      ]) {
        const i = list.findIndex((f) => f.id === raw);
        if (i < 0) continue;
        list.splice(i, 1);
        await writeJsonl(path, list);
        return done('fact', raw, isPrivate);
      }
    }

    if (!explicitEpisode) {
      const slug = sanitizeSlug(stripPrefix(raw, 'wiki:'));
      if (slug) {
        const path = wikiPagePath(home, slug);
        if ((await readText(path)) != null) {
          await rm(path, { force: true });
          await rebuildWikiIndex(home);
          return done('wiki', slug, false);
        }
      }
    }

    const epId = raw.replace(/^episode(-private)?:/, '');
    if (/^\d{4}-\d{2}-\d{2}-(to-you|inner)$/.test(epId)) {
      const date = epId.slice(0, 10);
      const kind = epId.slice(11);
      const order = raw.startsWith('episode-private:') ? [true] : raw.startsWith('episode:') ? [false] : [false, true];
      for (const isPrivate of order) {
        const path = episodePath(home, date, kind, isPrivate);
        if ((await readText(path)) != null) {
          await rm(path, { force: true });
          const rows = await readJsonl(eventsIndexPath(home));
          const keptRows = rows.map((r) => (r && r.id === `ev_${epId}` ? { ...r, deletedAt: iso } : r));
          await writeJsonl(eventsIndexPath(home), keptRows);
          return done('episode', epId, isPrivate);
        }
      }
    }

    // Window stars: episode:session:<sessionId> or session:<sessionId>
    if (/^session:/.test(epId) || raw.startsWith('episode:session:')) {
      const sessionId = epId.replace(/^session:/, '');
      if (sessionId) {
        const byPath = sessionEpisodePath(home, sessionId);
        let path = (await readText(byPath)) != null ? byPath : null;
        if (!path) {
          // Fallback: match meta.sessionId when safeId diverged from raw id.
          let names = [];
          try {
            names = await readdir(home.episodesDir);
          } catch (err) {
            if (err?.code !== 'ENOENT') throw err;
          }
          for (const name of names) {
            if (!SESSION_EPISODE_FILE_RE.test(name)) continue;
            const candidate = join(home.episodesDir, name);
            const rawDoc = await readText(candidate);
            if (rawDoc == null) continue;
            const { meta } = parseDoc(rawDoc);
            if (str(meta.sessionId).trim() === sessionId) {
              path = candidate;
              break;
            }
          }
        }
        if (path) {
          await rm(path, { force: true });
          return done('episode', `session:${sessionId}`, false);
        }
      }
    }
    return { ok: false, error: `memory not found: ${raw}` };
  });
}

/**
 * v3 (§6) zero-dependency polarity heuristic: one side negates / replaces while
 * the other asserts, or both carry numbers that disagree. When neither signal
 * fires we do NOT guess — the row stays a plain fact.
 */
const NEGATION_RE = /(不|没|别|不再|取消|换成|改为|改成)/g;
const CN_NUM = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
const numbersOf = (text) => [
  ...(str(text).match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number),
  ...(str(text).match(/[零一二两三四五六七八九十]/g) ?? []).map((c) => CN_NUM[c]),
];
export function polarityOpposite(a, b) {
  const na = (str(a).match(NEGATION_RE) ?? []).length;
  const nb = (str(b).match(NEGATION_RE) ?? []).length;
  if ((na > 0) !== (nb > 0)) return true;
  const xa = numbersOf(a);
  const xb = numbersOf(b);
  if (xa.length && xb.length && xa.length === xb.length) return xa.some((n, i) => n !== xb[i]);
  return false;
}

/** System / host scaffolding that should never ask the user to pick a side. */
export function isSystemNoiseText(text) {
  const t = str(text);
  if (!t) return false;
  if (/<system-reminder>|soulmate-wake|Current working directory|plugin-sessions|agent-reach/i.test(t)) return true;
  if (/The following information describes your current session/i.test(t)) return true;
  if (/专属窗交接/.test(t) && /近聊摘录|专属对话窗写满/.test(t)) return true;
  return false;
}

/** Conflicts we can settle without a human: handoff rolls or pure system noise. */
export function shouldAutoResolveConflict(a, b) {
  const ta = str(a?.topic).trim();
  const tb = str(b?.topic).trim();
  if (ta === '专属窗交接' && tb === '专属窗交接') return true;
  if (isSystemNoiseText(a?.text) && isSystemNoiseText(b?.text)) return true;
  return false;
}

function factTimeMs(f) {
  const raw = f?.t || f?.updatedAt || f?.createdAt || '';
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * Auto-keep the newer side of noise/handoff conflicts so the panel stays clean.
 * Also collapses duplicate active「专属窗交接」rows down to the newest one.
 * Silent by default (no「改口」diary spam).
 */
export async function autoResolveNoiseConflicts(home, options = {}) {
  const silent = options.silent !== false;
  const reason = str(options.reason).trim() || '自动处理：交接/系统噪音';
  const nowMs = resolveNow(options.nowMs);
  const iso = new Date(nowMs).toISOString();
  const { pub, priv } = await loadFacts(home);
  const active = [...pub, ...priv].filter(isActive);
  const seen = new Set();
  const pairs = [];
  for (const f of active.filter((x) => x.conflictWith)) {
    const key = [f.id, f.conflictWith].sort().join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    const other = active.find((x) => x.id === f.conflictWith);
    if (!other) continue;
    if (!shouldAutoResolveConflict(f, other)) continue;
    const newer = factTimeMs(f) >= factTimeMs(other) ? f : other;
    const older = newer.id === f.id ? other : f;
    pairs.push({ keepId: newer.id, dropId: older.id });
  }
  const resolved = [];
  for (const pair of pairs) {
    const res = await resolveConflict(home, {
      keepId: pair.keepId,
      dropId: pair.dropId,
      reason,
      silent,
      nowMs,
    });
    if (res?.ok) resolved.push(pair);
  }

  // Collapse leftover rolling handoff facts (same topic, no parked conflict).
  const { pub: pub2, priv: priv2 } = await loadFacts(home);
  let pruned = 0;
  for (const [list, path] of [
    [pub2, home.factsPath],
    [priv2, privateFactsPath(home)],
  ]) {
    const handoffs = list
      .filter((f) => isActive(f) && str(f.topic).trim() === '专属窗交接')
      .sort((a, b) => factTimeMs(b) - factTimeMs(a));
    if (handoffs.length <= 1) continue;
    const keep = handoffs[0];
    let dirty = false;
    for (const old of handoffs.slice(1)) {
      old.invalidatedAt = iso;
      old.invalidatedBy = keep.id;
      old.conflictWith = null;
      old.conflictOpenedAt = null;
      old.conflictOpenedConfidence = undefined;
      old.updatedAt = iso;
      dirty = true;
      pruned += 1;
    }
    if (dirty) await writeJsonl(path, list);
  }
  if (pruned) {
    await appendPrivacyAudit(home, { action: 'handoff_pruned', pruned, at: iso }).catch(() => {});
  }
  return { ok: true, resolved: resolved.length, pairs: resolved, pruned };
}

const PROMISE_ACTIONS = Object.freeze({ keep: 'kept', break: 'broken', release: 'released' });

/**
 * v3 (§5) promise lifecycle: made → kept | broken | released.
 * keep/break write a diary line and reinforce the promise once, so kept
 * promises glow instead of silently vanishing.
 */
export async function updatePromise(home, input = {}) {
  const id = str(input.id).trim();
  const action = str(input.action).trim();
  if (!id) return { ok: false, error: 'id is required' };
  if (!PROMISE_ACTIONS[action]) return { ok: false, error: `action must be one of ${Object.keys(PROMISE_ACTIONS).join(', ')}` };
  return withLock(home, async () => {
    const nowMs = resolveNow(input.nowMs);
    const iso = new Date(nowMs).toISOString();
    const { pub, priv } = await loadFacts(home);
    const target = [...pub, ...priv].find((f) => f.id === id);
    if (!target) return { ok: false, error: `memory not found: ${id}` };
    if (target.kind !== 'promise') return { ok: false, error: `${id} is not a promise` };
    if ((target.promise?.status ?? 'made') !== 'made') {
      return { ok: false, error: `promise ${id} is already ${target.promise.status}` };
    }
    const status = PROMISE_ACTIONS[action];
    const note = str(input.note).trim();
    for (const [list, path] of [[pub, home.factsPath], [priv, privateFactsPath(home)]]) {
      const i = list.findIndex((f) => f.id === id);
      if (i < 0) continue;
      list[i] = normalizeFact({
        ...list[i],
        promise: { ...list[i].promise, status, note: note || list[i].promise?.note || null },
        updatedAt: iso,
        recallCount: action === 'release' ? list[i].recallCount : (Number(list[i].recallCount) || 0) + 1,
        lastRecalledAt: action === 'release' ? list[i].lastRecalledAt : iso,
      });
      await writeJsonl(path, list);
    }
    await appendSyncOp(home, { kind: 'promise', id, action, at: iso, note: note || null });
    return { ok: true, id, status, diary: action === 'release' ? null : { verb: action === 'keep' ? '兑现了' : '没兑现', text: target.text, note } };
  }).then(async (res) => {
    // The diary write takes the same home lock, so it happens after the lock frees.
    if (res.ok && res.diary) {
      await recordEpisode(home, {
        kind: 'inner',
        visibility: 'private',
        title: `承诺·${res.diary.verb}`,
        content: `${res.diary.text}${res.diary.note ? `（${res.diary.note}）` : ''}`,
        nowMs: resolveNow(input.nowMs),
      });
    }
    const { diary, ...rest } = res;
    return rest;
  });
}

/**
 * v3 (§6) resolve a parked conflict: the winner regains its confidence, the
 * loser retires through invalidatedBy (history kept), and the "she misremembered"
 * moment lands in the diary — trust is repaired out loud, not silently.
 */
export async function resolveConflict(home, input = {}) {
  const keepId = str(input.keepId).trim();
  const dropId = str(input.dropId).trim();
  if (!keepId || !dropId || keepId === dropId) return { ok: false, error: 'keepId and dropId must differ' };
  return withLock(home, async () => {
    const iso = new Date(resolveNow(input.nowMs)).toISOString();
    const { pub, priv } = await loadFacts(home);
    const all = [...pub, ...priv];
    const keeper = all.find((f) => f.id === keepId);
    const dropper = all.find((f) => f.id === dropId);
    if (!keeper || !dropper) return { ok: false, error: 'both conflict sides must exist' };
    if (keeper.conflictWith !== dropId && dropper.conflictWith !== keepId) {
      return { ok: false, error: `${keepId} and ${dropId} are not a parked conflict pair` };
    }
    const reason = str(input.reason).trim();
    for (const [list, path] of [[pub, home.factsPath], [priv, privateFactsPath(home)]]) {
      let dirtyHere = false;
      for (const f of list) {
        if (f.id === keepId) {
          f.confidence = Number.isFinite(Number(f.conflictOpenedConfidence)) ? Number(f.conflictOpenedConfidence) : f.confidence;
          f.conflictWith = null;
          f.conflictOpenedAt = null;
          f.conflictOpenedConfidence = undefined;
          f.updatedAt = iso;
          dirtyHere = true;
        }
        if (f.id === dropId) {
          f.invalidatedAt = iso;
          f.invalidatedBy = keepId;
          f.conflictWith = null;
          f.conflictOpenedAt = null;
          f.conflictOpenedConfidence = undefined;
          f.updatedAt = iso;
          dirtyHere = true;
        }
      }
      if (dirtyHere) await writeJsonl(path, list);
    }
    await appendSyncOp(home, { kind: 'resolve', keepId, dropId, at: iso, reason: reason || null });
    return { ok: true, keepId, dropId, diary: `我记岔了：保留「${keeper.text}」，作废「${dropper.text}」${reason ? `（${reason}）` : ''}` };
  }).then(async (res) => {
    if (res.ok && !input.silent) {
      await recordEpisode(home, { kind: 'inner', visibility: 'private', title: '改口', content: res.diary, nowMs: resolveNow(input.nowMs) });
    }
    const { diary, ...rest } = res;
    return rest;
  });
}

/** v3 (§11) headline memory counters: active vs historical, distillation debt. */
export async function memoryCounts(home, options = {}) {
  const { pub, priv } = await loadFacts(home);
  const all = [...pub, ...priv];
  const active = all.filter(isActive);
  const pages = await readWikiPages(home);
  const distilled = new Set(pages.flatMap((p) => p.sourceFactIds ?? []));
  const undistilled = active.filter((f) => f.kind !== 'promise' && !f.conflictWith && !distilled.has(f.id)).length;
  const lastDistilledAt = pages.reduce((m, p) => (p.updatedAt > m ? p.updatedAt : m), '');
  return {
    activeFacts: active.length,
    historicalFacts: all.length,
    conflictsOpen: active.filter((f) => f.conflictWith).length,
    undistilled,
    lastDistilledAt,
  };
}

/** Panel/route view of the trust layer (§5/§6): promises + open conflict pairs. */
export async function listTrustItems(home, options = {}) {
  const nowMs = resolveNow(options.nowMs);
  const { pub, priv } = await loadFacts(home);
  const active = [...pub, ...priv].filter(isActive);
  const promises = active
    .filter((f) => f.kind === 'promise')
    .map((f) => {
      const status = f.promise?.status ?? 'made';
      const due = f.promise?.dueAt ? toMs(f.promise.dueAt) : 0;
      return {
        id: f.id,
        text: f.text,
        status,
        dueAt: f.promise?.dueAt ?? null,
        note: f.promise?.note ?? null,
        overdueDays: status === 'made' && due && due < nowMs ? Math.floor((nowMs - due) / DAY_MS) : 0,
      };
    });
  const seen = new Set();
  const conflicts = [];
  for (const f of active.filter((x) => x.conflictWith)) {
    const key = [f.id, f.conflictWith].sort().join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    const other = active.find((x) => x.id === f.conflictWith);
    conflicts.push({
      newer: { id: f.id, text: f.text },
      older: { id: f.conflictWith, text: other?.text ?? null },
      openedAt: f.conflictOpenedAt,
    });
  }
  return { ok: true, promises, conflicts };
}

/**
 * v3 (§4) the Presence Digest: what she "remembers" without being asked.
 * Order is priority; trimming drops low salience×relationship items first,
 * never promises and never the open conflict.
 */
const isIdentityOrBoundary = (f) => {
  const t = str(f?.topic);
  return t.startsWith('identity:') || t.startsWith('boundary:');
};

export async function composePresenceDigest(home, options = {}) {
  const maxChars = Math.max(120, Math.floor(Number(options.maxChars ?? 900)) || 900);
  const nowMs = resolveNow(options.nowMs);
  const relationship = options.relationship ?? (await readRelationshipSafe(home));
  const { pub, priv } = await loadFacts(home);
  const active = [...pub, ...priv].filter(isActive);
  const promises = active.filter((f) => f.kind === 'promise' && (f.promise?.status ?? 'made') === 'made');
  const conflicts = active.filter((f) => f.conflictWith);
  const seenPair = new Set();
  const conflictLines = [];
  for (const f of conflicts) {
    const key = [f.id, f.conflictWith].sort().join('|');
    if (seenPair.has(key)) continue;
    seenPair.add(key);
    const other = active.find((x) => x.id === f.conflictWith);
    conflictLines.push(`- 冲突：旧「${clipText(other?.text ?? '?', 40)}」／新「${clipText(f.text, 40)}」→ 需要问他`);
  }
  const promiseLines = promises.slice(0, 5).map((f) => {
    const due = f.promise?.dueAt ? `，截止 ${f.promise.dueAt.slice(0, 10)}` : '';
    const overdue = f.promise?.dueAt && toMs(f.promise.dueAt) < nowMs ? `，已逾期 ${Math.floor((nowMs - toMs(f.promise.dueAt)) / DAY_MS)} 天` : '';
    return `- 承诺${due}${overdue}：${clipText(f.text, 60)}`;
  });
  const presenceFacts = active.filter((f) => f.kind !== 'promise' && !f.conflictWith && isPresenceClass(f.decayClass));
  // identity:* / boundary:* sit after promises/conflicts but before ordinary preferences.
  const anchors = presenceFacts
    .filter(isIdentityOrBoundary)
    .sort((a, b) => str(a.topic).localeCompare(str(b.topic)) || (a.updatedAt < b.updatedAt ? 1 : -1));
  const candidates = presenceFacts
    .filter((f) => !isIdentityOrBoundary(f))
    .map((f) => ({ f, key: f.salience * relationshipOf(f, relationship, 0) }))
    .sort((a, b) => b.key - a.key || trimRank(b.f.decayClass) - trimRank(a.f.decayClass));
  // Prefer recently updated window stars / diaries for「最近经历」.
  const episodes = (await readEpisodes(home, { includePrivate: false })).sort(
    (a, b) => toMs(b.updatedAt) - toMs(a.updatedAt) || (a.date < b.date ? 1 : -1)
  );
  const lastEpisode = episodes[0];

  const gender = options.gender ?? null;
  const title =
    gender === 'male' ? '# 他此刻记得' : gender === 'female' ? '# 她此刻记得' : '# 我此刻记得';
  const classLabel = { preference: '偏好', fact: '事实', promise: '承诺', event: '经历', emotion: '情绪' };
  const renderFacts = (facts) => facts.map((f) => `- ${classLabel[f.decayClass] || '记忆'}：${clipText(f.text, 70)}`).join('\n');
  const anchorLines = anchors.map((f) => `- ${classLabel[f.decayClass] || '记忆'}：${clipText(f.text, 70)}`);

  const lines = [title];
  lines.push(...promiseLines);
  lines.push(...conflictLines.slice(0, 1));
  lines.push(...anchorLines);
  const tail = [];
  if (lastEpisode) tail.push(`- 最近经历：${lastEpisode.date} ${clipText(lastEpisode.body.split('\n')[0], 50)}`);
  const emotion = active.filter((f) => f.decayClass === 'emotion').sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0];
  if (emotion) tail.push(`- 情绪底色：${clipText(emotion.text, 50)}`);

  // Nothing to say -> no digest at all (the anchor stays persona-only).
  if (!promiseLines.length && !conflictLines.length && !anchors.length && !candidates.length && !tail.length) {
    return { ok: true, text: '', chars: 0, promises: promises.length, conflictsOpen: conflicts.length, facts: 0, updatedAt: new Date(nowMs).toISOString() };
  }

  // v3 §11: trimming is by *importance*, not by array position. The head (promises, the open
  // conflict, identity/boundary anchors) and the tail (last episode, emotional undertone) are
  // reserved first; only the loose facts compete for what is left.
  const head = lines.join('\n');
  const tailText = tail.join('\n');
  const reserved = head.length + (tailText ? tailText.length + 1 : 0);
  const fitted = fitMemoryDigest(
    candidates.map((c) => c.f),
    { maxChars: Math.max(0, maxChars - reserved), render: renderFacts, nowMs },
  );
  const factText = renderFacts(fitted.items);
  const text = [head, factText, tailText].filter(Boolean).join('\n');
  return {
    ok: true,
    text: text.slice(0, maxChars),
    chars: Math.min(text.length, maxChars),
    promises: promises.length,
    conflictsOpen: conflicts.length,
    facts: fitted.items.length + anchors.length,
    factsDropped: fitted.dropped,
    updatedAt: new Date(nowMs).toISOString(),
  };
}

const clipText = (s, n) => {
  const t = str(s).replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : `${t.slice(0, n)}…`;
};

// ---------------------------------------------------------------------------
// Sync (syncable memory only; never touches home.privateDir)
// ---------------------------------------------------------------------------
export async function buildSyncableSnapshot(home, sinceCursor = 0) {
  const since = Number(sinceCursor) || 0;
  const newer = (iso) => toMs(iso) > since;
  let cursor = since;
  const bump = (iso) => {
    cursor = Math.max(cursor, toMs(iso));
  };

  const wikiUpserts = [];
  for (const p of await readWikiPages(home)) {
    if (!newer(p.updatedAt)) continue;
    bump(p.updatedAt);
    wikiUpserts.push({
      slug: p.slug,
      title: p.title,
      summary: p.summary,
      category: p.category,
      links: p.links,
      sourceFactIds: p.sourceFactIds,
      content: p.content,
      updatedAt: p.updatedAt,
    });
  }

  const factUpserts = [];
  for (const raw of await readJsonl(home.factsPath)) {
    if (raw.visibility === 'private' || raw.deletedAt) continue;
    if (!newer(raw.updatedAt)) continue;
    // v3 (§9.2): whitelist-only payload, plus a second scrub right at egress.
    const f = normalizeFact(raw);
    const evidence = Array.isArray(f.evidence) ? f.evidence : [];
    const scrubText = inspectAndScrub(f.text);
    const scrubEv = evidence.map((e) => inspectAndScrub(e));
    const scrubSession = inspectAndScrub(f.provenance.sessionId ?? '');
    if (!scrubText.allowed || scrubEv.some((x) => !x.allowed) || !scrubSession.allowed) {
      await appendPrivacyAudit(home, { action: 'sync_blocked', id: f.id, reason: 'egress scrub refused' });
      continue;
    }
    const redacted =
      scrubText.redactions.length > 0 || scrubEv.some((x) => x.redactions.length > 0) || scrubSession.redactions.length > 0;
    if (redacted) await appendPrivacyAudit(home, { action: 'sync_field_redacted', id: f.id });
    bump(f.updatedAt);
    factUpserts.push({
      id: f.id,
      kind: f.kind,
      decayClass: f.decayClass,
      text: scrubText.scrubbedText,
      t: f.t,
      salience: f.salience,
      confidence: f.confidence,
      evidence: scrubEv.map((x) => x.scrubbedText).filter(Boolean),
      provenance: { ...f.provenance, sessionId: scrubSession.scrubbedText || null },
      promise: f.promise,
      conflictWith: f.conflictWith,
      conflictOpenedAt: f.conflictOpenedAt,
      category: f.category,
      visibility: f.visibility,
      halfLifeDays: f.halfLifeDays,
      recallCount: f.recallCount,
      createdAt: f.createdAt,
      updatedAt: f.updatedAt,
      lastRecalledAt: f.lastRecalledAt,
    });
  }

  const episodeUpserts = [];
  for (const e of await readEpisodes(home, { includePrivate: false })) {
    if (e.kind === 'session') continue; // session stars stay local until sync wiring lands
    if (!newer(e.updatedAt)) continue;
    bump(e.updatedAt);
    episodeUpserts.push({ date: e.date, kind: e.kind, content: e.body, updatedAt: e.updatedAt });
  }

  const tombstones = [];
  for (const t of await readTombstones(home)) {
    if (t.visibility === 'private' || !newer(t.deletedAt)) continue;
    bump(t.deletedAt);
    tombstones.push({ kind: t.kind, id: t.id, deletedAt: t.deletedAt });
  }

  const ops = [];
  for (const op of await readJsonl(syncOpsPath(home))) {
    if (!op || !op.kind || !toMs(op.at)) continue;
    if (!newer(op.at)) continue;
    bump(op.at);
    ops.push(op);
  }

  return { ok: true, since, cursor, wikiUpserts, factUpserts, episodeUpserts, tombstones, ops };
}

/** Merge a remote delta with Last-Write-Wins on updatedAt; tombstones beat older writes. */
export async function applyRemoteSyncDelta(home, delta = {}) {
  const list = (v) => (Array.isArray(v) ? v : []);
  return withLock(home, async () => {
    const applied = { wiki: 0, facts: 0, episodes: 0, tombstones: 0, conflicts: 0, ops: 0 };
    let skipped = 0;

    const tombs = mergeTombstones([...(await readTombstones(home))]);
    const tombMap = new Map(tombs.map((t) => [`${t.kind}:${t.id}`, t]));
    const remoteTombs = [];
    for (const t of list(delta.remoteTombstones)) {
      if (!t || !['fact', 'wiki', 'episode'].includes(t.kind) || !t.id || !toMs(t.deletedAt)) {
        skipped++;
        continue;
      }
      const id = t.kind === 'wiki' ? sanitizeSlug(t.id) : str(t.id);
      if (!id) {
        skipped++;
        continue;
      }
      const key = `${t.kind}:${id}`;
      const prev = tombMap.get(key);
      if (!prev || toMs(t.deletedAt) > toMs(prev.deletedAt)) {
        const rec = { kind: t.kind, id, deletedAt: t.deletedAt };
        tombMap.set(key, rec);
        remoteTombs.push(rec);
      }
    }
    const tombAt = (kind, id) => toMs(tombMap.get(`${kind}:${id}`)?.deletedAt);

    // --- facts (public store only; local private facts always win) ---
    const { pub, priv } = await loadFacts(home);
    let factsDirty = false;
    for (const rf of list(delta.remoteFactUpserts)) {
      // v3: the whitelist payload carries `text`; legacy peers still send topic/content.
      if (!rf || !str(rf.id) || !(str(rf.text).trim() || str(rf.content).trim()) || !toMs(rf.updatedAt)) {
        skipped++;
        continue;
      }
      if (priv.some((f) => f.id === rf.id)) {
        skipped++;
        continue;
      }
      if (tombAt('fact', rf.id) >= toMs(rf.updatedAt)) {
        skipped++;
        continue;
      }
      const i = pub.findIndex((f) => f.id === rf.id);
      if (i >= 0 && toMs(pub[i].updatedAt) >= toMs(rf.updatedAt)) {
        skipped++;
        continue;
      }
      // v3 (§10): two devices editing the same memory within a minute is a
      // disagreement, not a race — park both versions instead of last-write-wins.
      if (i >= 0 && Math.abs(toMs(pub[i].updatedAt) - toMs(rf.updatedAt)) < 60_000 && str(pub[i].text) !== str(rf.text) && !pub[i].conflictWith) {
        const isoNow = new Date(Date.now()).toISOString();
        const shadowId = `${rf.id}~r${Math.round(toMs(rf.updatedAt) / 1000).toString(36)}`;
        const local = pub[i];
        const shadow = normalizeFact({
          ...rf,
          id: shadowId,
          conflictWith: local.id,
          conflictOpenedAt: isoNow,
          conflictOpenedConfidence: Number(rf.confidence) || 0.6,
          confidence: Math.min(Number(rf.confidence) || 0.6, 0.55),
        });
        local.conflictWith = shadowId;
        local.conflictOpenedAt = isoNow;
        local.conflictOpenedConfidence = local.confidence;
        local.confidence = Math.min(local.confidence, 0.55);
        pub.push(shadow);
        factsDirty = true;
        applied.conflicts++;
        continue;
      }
      const next = normalizeFact({
        ...rf,
        visibility: 'syncable', // remote can never inject private facts
        importance: clamp(Math.round(Number(rf.importance ?? 3)) || 3, 1, 5),
        halfLifeDays: Number(rf.halfLifeDays) > 0 ? Number(rf.halfLifeDays) : undefined,
        recallCount: Math.max(Number(rf.recallCount) || 0, i >= 0 ? Number(pub[i].recallCount) || 0 : 0),
        deletedAt: null,
      });
      if (i >= 0) pub[i] = next;
      else pub.push(next);
      factsDirty = true;
      applied.facts++;
    }

    // --- wiki ---
    for (const rw of list(delta.remoteWikiUpserts)) {
      const slug = sanitizeSlug(rw?.slug);
      if (!slug || !str(rw.content).trim() || !toMs(rw.updatedAt)) {
        skipped++;
        continue;
      }
      if (tombAt('wiki', slug) >= toMs(rw.updatedAt)) {
        skipped++;
        continue;
      }
      const path = wikiPagePath(home, slug);
      const rawLocal = await readText(path);
      if (rawLocal != null) {
        const local = await fileUpdatedAt(path, parseDoc(rawLocal).meta.updatedAt);
        if (toMs(local) >= toMs(rw.updatedAt)) {
          skipped++;
          continue;
        }
      }
      const content = str(rw.content).trim();
      await atomicWrite(
        path,
        serializeDoc(
          {
            slug,
            title: str(rw.title) || slug,
            summary: str(rw.summary),
            category: str(rw.category) || 'mental-model',
            links: extractWikiLinks(content).filter((l) => l !== slug),
            updatedAt: rw.updatedAt,
            sourceFactIds: Array.isArray(rw.sourceFactIds) ? rw.sourceFactIds.map(str) : [],
          },
          content
        )
      );
      applied.wiki++;
    }

    // --- episodes ---
    for (const re of list(delta.remoteEpisodeUpserts)) {
      const date = str(re?.date);
      const kind = str(re?.kind) || 'to-you';
      if (!DATE_RE.test(date) || !EPISODE_KINDS.includes(kind) || !str(re.content).trim() || !toMs(re.updatedAt)) {
        skipped++;
        continue;
      }
      if (tombAt('episode', `${date}-${kind}`) >= toMs(re.updatedAt)) {
        skipped++;
        continue;
      }
      const path = episodePath(home, date, kind, false);
      const rawLocal = await readText(path);
      if (rawLocal != null) {
        const local = await fileUpdatedAt(path, parseDoc(rawLocal).meta.updatedAt);
        if (toMs(local) >= toMs(re.updatedAt)) {
          skipped++;
          continue;
        }
      }
      await atomicWrite(
        path,
        serializeDoc({ date, kind, visibility: 'syncable', updatedAt: re.updatedAt }, str(re.content))
      );
      applied.episodes++;
    }

    // --- tombstones: delete local copies that are not newer than the tombstone ---
    for (const t of remoteTombs) {
      const at = toMs(t.deletedAt);
      if (t.kind === 'fact') {
        const i = pub.findIndex((f) => f.id === t.id);
        if (i >= 0 && toMs(pub[i].updatedAt) <= at) {
          pub.splice(i, 1);
          factsDirty = true;
        }
      } else if (t.kind === 'wiki') {
        const path = wikiPagePath(home, t.id);
        const rawLocal = await readText(path);
        if (rawLocal != null) {
          const local = await fileUpdatedAt(path, parseDoc(rawLocal).meta.updatedAt);
          if (toMs(local) <= at) {
            await rm(path, { force: true });
            applied.wiki++;
          }
        }
      } else if (/^\d{4}-\d{2}-\d{2}-(to-you|inner)$/.test(t.id)) {
        const path = episodePath(home, t.id.slice(0, 10), t.id.slice(11), false);
        const rawLocal = await readText(path);
        if (rawLocal != null) {
          const local = await fileUpdatedAt(path, parseDoc(rawLocal).meta.updatedAt);
          if (toMs(local) <= at) await rm(path, { force: true });
        }
      }
      applied.tombstones++;
    }

    if (factsDirty) await writeJsonl(home.factsPath, pub);

    // v3 (§10): replay promise/resolve ops in time order; both are idempotent,
    // so echoing our own ops back is harmless.
    const ops = [...list(delta.remoteOps), ...list(delta.ops)]
      .filter((o) => o && o.kind && toMs(o.at))
      .sort((a, b) => toMs(a.at) - toMs(b.at));
    if (ops.length) {
      const fresh = await loadFacts(home);
      const all = [...fresh.pub, ...fresh.priv];
      let opDirtyPub = false;
      let opDirtyPriv = false;
      for (const op of ops) {
        if (op.kind === 'promise') {
          const target = all.find((f) => f.id === op.id && f.kind === 'promise');
          if (!target || (target.promise?.status ?? 'made') !== 'made') continue;
          const status = { keep: 'kept', break: 'broken', release: 'released' }[op.action];
          if (!status) continue;
          target.promise = { ...target.promise, status, note: op.note ?? target.promise?.note ?? null };
          target.updatedAt = op.at;
          applied.ops++;
          opDirtyPub = true;
          opDirtyPriv = true;
        }
        if (op.kind === 'resolve') {
          const keeper = all.find((f) => f.id === op.keepId);
          const dropper = all.find((f) => f.id === op.dropId);
          if (!keeper || !dropper || dropper.invalidatedBy) continue;
          keeper.confidence = Number.isFinite(Number(keeper.conflictOpenedConfidence)) ? Number(keeper.conflictOpenedConfidence) : keeper.confidence;
          keeper.conflictWith = null;
          keeper.conflictOpenedAt = null;
          dropper.invalidatedAt = op.at;
          dropper.invalidatedBy = op.keepId;
          dropper.conflictWith = null;
          dropper.conflictOpenedAt = null;
          applied.ops++;
          opDirtyPub = true;
          opDirtyPriv = true;
        }
      }
      if (opDirtyPub) await writeJsonl(home.factsPath, fresh.pub);
      if (opDirtyPriv) await writeJsonl(privateFactsPath(home), fresh.priv);
    }
    if (remoteTombs.length) await writeJsonl(tombstonesPath(home), [...tombMap.values()]);
    if (applied.wiki) await rebuildWikiIndex(home);
    return { ok: true, applied, skipped };
  });
}

// ---------------------------------------------------------------------------
// 3D Sci-Fi Neural Connectome
// ---------------------------------------------------------------------------
const COLORS = Object.freeze({
  wiki: '#00f2fe',
  fact: '#4facfe',
  shield: '#ffd700',
  episode: '#7ee8fa',
  session: '#ffb347',
  remoteCloud: '#b721ff',
  remoteCapability: '#ff2a85',
  milestone: '#f0c14a',
  memento: '#e09a3e',
});
const PULSE = Object.freeze({
  wiki_link: '#00f2fe',
  topic_cluster: '#4facfe',
  warp_sync_beam: '#b721ff',
  episode_chain: '#7ee8fa',
  milestone_link: '#f0c14a',
  memento_link: '#e09a3e',
});
const CORE_RADIUS = 12;
const ORPHAN_RADIUS = 20;
const REMOTE_RADIUS = 56;
const CAPABILITY_RADIUS = 66;
const MEMENTO_RADIUS = 24;
const VAULT_CENTER = [-38, 0, 0];
const HELIX_CENTER = [28, 0, 0];
const PRIVATE_HELIX_CENTER = [-38, 0, 16];
const MEMENTO_CENTER = [28, 10, 0];

const pos = (x, y, z) => ({ x: round(x), y: round(y), z: round(z) });

function fibSphere(i, n, r, c = [0, 0, 0]) {
  const y = n > 1 ? 1 - (i / (n - 1)) * 2 : 0;
  const ring = Math.sqrt(Math.max(0, 1 - y * y));
  const th = GOLDEN_ANGLE * i;
  return pos(c[0] + Math.cos(th) * ring * r, c[1] + y * r, c[2] + Math.sin(th) * ring * r);
}

/** Double-helix (DNA) coordinates: even index on strand A, odd on strand B. */
function helixPos(i, n, c) {
  const strand = i % 2;
  const t = Math.floor(i / 2);
  const angle = t * 0.7 + strand * Math.PI;
  return pos(c[0] + Math.cos(angle) * 5, c[1] + (t - n / 4) * 1.6, c[2] + Math.sin(angle) * 5);
}

const energyOf = (fresh) => round(clamp(0.1 + 0.9 * fresh, 0.1, 1), 3);
const shorten = (s, n = 80) => {
  const t = str(s).replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

export async function buildNeuralGraph(home, options = {}) {
  const nowMs = resolveNow(options.nowMs);
  const cloudSynced = options.cloudSynced !== false;
  const syncedIds = options.syncedIds ? new Set(options.syncedIds) : null;
  const capabilities = Array.isArray(options.remoteCapabilities) ? options.remoteCapabilities : [];

  const pages = (await readWikiPages(home)).sort((a, b) => (a.slug < b.slug ? -1 : 1));
  const { pub, priv } = await loadFacts(home);
  const cmp = (a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1);
  const facts = pub.filter(isActive).sort(cmp);
  const privs = priv.filter(isActive).sort(cmp);
  const eps = (await readEpisodes(home, { includePrivate: true })).sort((a, b) =>
    a.date === b.date ? (a.kind < b.kind ? -1 : 1) : a.date < b.date ? -1 : 1
  );

  const nodes = [];
  const synapses = [];
  const synapseIds = new Set();
  const addSynapse = (kind, source, target, strength) => {
    const id = `syn:${kind}:${source}>${target}`;
    if (synapseIds.has(id)) return;
    synapseIds.add(id);
    synapses.push({ id, source, target, kind, strength: round(strength, 3), pulseColor: PULSE[kind] });
  };

  // --- Wiki stars (inner core) ---
  const wikiNode = new Map();
  const childCount = new Map();
  pages.forEach((p, i) => {
    const isSelfArc = p.slug === 'self-arc' || p.category === 'self-arc';
    const node = {
      id: `wiki:${p.slug}`,
      label: p.title,
      kind: 'wiki_star',
      zone: 'local_cortex',
      color: COLORS.wiki,
      size: isSelfArc ? 5 : 3,
      energy: energyOf(2 ** (-Math.max(0, (nowMs - toMs(p.updatedAt)) / DAY_MS) / 90)),
      importance: isSelfArc ? 8 : 5,
      recallCount: 0,
      halfLifeDays: 90,
      shielded: false,
      synced: false,
      summary: p.summary || shorten(p.content),
      content: p.content,
      updatedAt: p.updatedAt,
      createdAt: p.createdAt,
      // self-arc hugs the core (smaller radius) so it reads as the protagonist hub
      position: fibSphere(i, pages.length, isSelfArc ? CORE_RADIUS * 0.55 : CORE_RADIUS),
    };
    wikiNode.set(p.slug, node);
    nodes.push(node);
  });

  for (const p of pages) {
    for (const link of p.links) {
      if (wikiNode.has(link) && link !== p.slug) addSynapse('wiki_link', `wiki:${p.slug}`, `wiki:${link}`, 0.9);
    }
  }

  // --- Facts orbit their wiki star (topic cluster) ---
  const sourceOwner = new Map();
  for (const p of pages) for (const id of p.sourceFactIds) if (!sourceOwner.has(id)) sourceOwner.set(id, p.slug);
  const titleIndex = pages.map((p) => ({ slug: p.slug, title: p.title.toLowerCase() }));
  const parentOf = (f) => {
    const owner = sourceOwner.get(f.id);
    if (owner) return owner;
    const topic = str(f.topic).trim().toLowerCase();
    if (!topic) return null;
    const bySlug = sanitizeSlug(topic);
    if (wikiNode.has(bySlug)) return bySlug;
    const exact = titleIndex.find((t) => t.title === topic);
    if (exact) return exact.slug;
    const fuzzy = titleIndex.find((t) => t.title.length >= 2 && (t.title.includes(topic) || topic.includes(t.title)));
    return fuzzy ? fuzzy.slug : null;
  };

  const orphans = [];
  const factNodes = [];
  for (const f of facts) {
    const parent = parentOf(f);
    const k = parent ? (childCount.get(parent) ?? 0) : 0;
    if (parent) childCount.set(parent, k + 1);
    const isMilestone = str(f.category).toLowerCase() === 'milestone';
    const node = factToNode(
      f,
      nowMs,
      isMilestone ? 'milestone_spark' : 'fact_neuron',
      'local_cortex',
      isMilestone ? COLORS.milestone : COLORS.fact
    );
    if (isMilestone) {
      node.size = round(Math.max(node.size, 1.8), 3);
    }
    if (parent) {
      const c = wikiNode.get(parent).position;
      const a = k * GOLDEN_ANGLE;
      const r = 3.5 + (k % 3) * 0.9;
      node.position = pos(c.x + Math.cos(a) * r, c.y + ((k % 5) - 2) * 0.7, c.z + Math.sin(a) * r);
      node._parent = parent;
    } else {
      orphans.push(node);
    }
    factNodes.push(node);
    nodes.push(node);
  }
  orphans.forEach((n, i) => {
    n.position = fibSphere(i, orphans.length, ORPHAN_RADIUS);
  });
  for (const n of factNodes) {
    if (n._parent) {
      const synKind = n.kind === 'milestone_spark' ? 'milestone_link' : 'topic_cluster';
      addSynapse(synKind, n.id, `wiki:${n._parent}`, n.importance / 5);
    }
    delete n._parent;
  }

  // --- Private quantum-shielded neurons ---
  privs.forEach((f, i) => {
    const node = factToNode(f, nowMs, 'private_shielded', 'private_vault', COLORS.shield);
    node.shielded = true;
    node.position = fibSphere(i, privs.length, 6, VAULT_CENTER);
    nodes.push(node);
  });

  // --- Episode crystals on DNA helices (date-kind diaries + session window stars) ---
  const pubEps = eps.filter((e) => e.visibility !== 'private');
  const privEps = eps.filter((e) => e.visibility === 'private');
  const episodeNodes = [];
  const episodeIdSet = new Set();
  for (const [group, center, isPrivate] of [
    [pubEps, HELIX_CENTER, false],
    [privEps, PRIVATE_HELIX_CENTER, true],
  ]) {
    let prev = null;
    group.forEach((e, i) => {
      const isSession = e.kind === 'session' || e.kind === 'im';
      const isTranscript = e.kind === 'transcript';
      const transcriptTitle = str(e.title).replace(/^原文\s*·\s*/, '');
      const node = {
        id: `${isPrivate ? 'episode-private' : 'episode'}:${e.id}`,
        label: isTranscript
          ? `原文 · ${transcriptTitle || e.date}`
          : isSession ? e.title || e.sessionId || e.id : `${e.date} ${e.kind}`,
        kind: isTranscript ? 'transcript_star' : isSession ? 'session_star' : 'episode_crystal',
        zone: isPrivate ? 'private_vault' : 'local_cortex',
        color: isPrivate ? COLORS.shield : (isSession || isTranscript) ? COLORS.session : COLORS.episode,
        size: isSession || isTranscript ? 1.2 : 1,
        energy: energyOf(2 ** (-Math.max(0, (nowMs - toMs(e.updatedAt)) / DAY_MS) / 14)),
        importance: 2,
        recallCount: 0,
        halfLifeDays: 14,
        shielded: isPrivate,
        synced: false,
        summary: shorten(e.body.replace(/^#.*$/m, '').replace(/^##.*$/gm, '')),
        content: e.body,
        updatedAt: e.updatedAt,
        position: helixPos(i, group.length, center),
      };
      nodes.push(node);
      episodeIdSet.add(node.id);
      if (!isPrivate) episodeNodes.push(node);
      if (prev) addSynapse('episode_chain', prev.id, node.id, 0.4);
      prev = node;
    });
  }

  // --- Memento relics (photo-wall souvenirs → amber nodes near helix) ---
  const mementos = Array.isArray(options.mementos) ? options.mementos : [];
  const nodeIds = new Set(nodes.map((n) => n.id));
  mementos.forEach((m, i) => {
    if (!m || typeof m !== 'object') return;
    const mid = str(m.id).trim() || `idx-${i}`;
    const id = `memento:${mid}`;
    const updatedAt = str(m.createdAt || m.updatedAt) || new Date(nowMs).toISOString();
    const label = str(m.title || m.label || mid).trim() || mid;
    const summary = shorten(str(m.subtitle || m.summary || m.caption || label));
    nodes.push({
      id,
      label,
      kind: 'memento_relic',
      zone: 'local_cortex',
      color: COLORS.memento,
      size: 1.5,
      energy: energyOf(2 ** (-Math.max(0, (nowMs - toMs(updatedAt)) / DAY_MS) / 60)),
      importance: 4,
      recallCount: 0,
      halfLifeDays: 60,
      shielded: false,
      synced: m.synced === true || str(m.source) === 'cloud',
      summary,
      content: summary,
      updatedAt,
      position: fibSphere(i, Math.max(1, mementos.length), MEMENTO_RADIUS, MEMENTO_CENTER),
    });
    nodeIds.add(id);

    const linkTargets = [];
    const factId = str(m.factId).trim();
    if (factId) linkTargets.push(factId);
    const episodeId = str(m.episodeId).trim();
    if (episodeId) {
      linkTargets.push(episodeId.startsWith('episode') ? episodeId : `episode:${episodeId}`);
    }
    const wikiSlug = str(m.wikiSlug || m.wiki).trim();
    if (wikiSlug) linkTargets.push(wikiSlug.startsWith('wiki:') ? wikiSlug : `wiki:${wikiSlug}`);

    for (const target of linkTargets) {
      if (nodeIds.has(target) || episodeIdSet.has(target)) {
        addSynapse('memento_link', id, target, 0.7);
      }
    }
  });

  // --- Remote cloud ring (warp-sync counterparts) + capabilities ---
  if (cloudSynced) {
    const syncable = nodes.filter((n) => !n.shielded && n.zone === 'local_cortex');
    for (const local of syncable) {
      if (syncedIds && !syncedIds.has(local.id)) continue;
      local.synced = true;
      const { x, y, z } = local.position;
      const len = Math.hypot(x, y, z) || 1;
      const remote = {
        ...local,
        id: `remote:${local.id}`,
        label: local.label,
        kind: 'remote_cloud',
        zone: 'remote_nebula',
        color: COLORS.remoteCloud,
        size: round(local.size * 0.8, 3),
        shielded: false,
        synced: true,
        position: pos((x / len) * REMOTE_RADIUS, (y / len) * REMOTE_RADIUS, (z / len) * REMOTE_RADIUS),
      };
      nodes.push(remote);
      addSynapse('warp_sync_beam', local.id, remote.id, local.energy);
    }
  }
  capabilities.forEach((cap, i) => {
    const raw = typeof cap === 'string' ? { id: cap } : (cap ?? {});
    const id = str(raw.id ?? raw.name ?? raw.toolName ?? `cap-${i}`);
    const angle = (i / Math.max(1, capabilities.length)) * Math.PI * 2;
    nodes.push({
      id: `capability:${id}`,
      label: str(raw.title ?? raw.name ?? id),
      kind: 'remote_capability',
      zone: 'remote_nebula',
      color: COLORS.remoteCapability,
      size: 1.6,
      energy: 0.8,
      importance: 3,
      recallCount: 0,
      halfLifeDays: 0,
      shielded: false,
      synced: true,
      summary: shorten(raw.description ?? ''),
      content: str(raw.description ?? ''),
      updatedAt: str(raw.updatedAt ?? new Date(nowMs).toISOString()),
      position: pos(Math.cos(angle) * CAPABILITY_RADIUS, 8 * Math.sin(i * 1.7), Math.sin(angle) * CAPABILITY_RADIUS),
    });
  });

  const avg = nodes.length ? nodes.reduce((s, n) => s + n.energy, 0) / nodes.length : 0;
  return {
    ok: true,
    nodes,
    synapses,
    stats: {
      localCount: nodes.filter((n) => n.zone === 'local_cortex').length,
      privateShieldedCount: nodes.filter((n) => n.zone === 'private_vault').length,
      remoteCloudCount: nodes.filter((n) => n.zone === 'remote_nebula').length,
      synapseCount: synapses.length,
      averageEnergy: round(avg, 3),
    },
  };
}

function factToNode(f, nowMs, kind, zone, color) {
  const importance = clamp(Number(f.importance) || 3, 1, 5);
  return {
    id: f.id,
    label: f.topic,
    kind,
    zone,
    color,
    size: round(0.6 + importance * 0.4, 3),
    energy: energyOf(freshness(f, nowMs)),
    importance,
    recallCount: Number(f.recallCount) || 0,
    halfLifeDays: Number(f.halfLifeDays) || 30,
    shielded: false,
    synced: false,
    summary: shorten(f.content),
    content: f.content,
    updatedAt: f.updatedAt,
    createdAt: f.createdAt,
    position: pos(0, 0, 0),
  };
}
