// Per-platform surf journal (screenshots, links, summary, on-platform actions).
import { access, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { appendJsonl, readJsonlTail } from './state.mjs';

export const SURF_PLATFORMS = Object.freeze(['bilibili', 'douyin']);

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));

export function surfLogPath(home, platform = 'bilibili') {
  const p = SURF_PLATFORMS.includes(platform) ? platform : 'bilibili';
  return join(home.rootDir, `surf-log-${p}.jsonl`);
}

/** One-time migrate legacy bili-surf-log.jsonl → surf-log-bilibili.jsonl. */
export async function migrateLegacySurfLog(home) {
  const legacy = join(home.rootDir, 'bili-surf-log.jsonl');
  const dest = surfLogPath(home, 'bilibili');
  try {
    await access(legacy);
  } catch {
    return { migrated: false };
  }
  try {
    await access(dest);
    return { migrated: false, reason: 'dest-exists' };
  } catch {
    /* dest missing — rename */
  }
  await rename(legacy, dest);
  return { migrated: true };
}

function hasEngagement(actions) {
  if (!actions || typeof actions !== 'object') return false;
  return !!(actions.like || actions.favorite || actions.comment || actions.follow
    || (Array.isArray(actions.replies) && actions.replies.length));
}

export function normalizeSurfEntry(raw = {}, platform = 'bilibili') {
  const videoId = str(raw.videoId || raw.bvid).trim();
  const actions = raw.actions && typeof raw.actions === 'object'
    ? { ...raw.actions }
    : { like: false, favorite: false, comment: false, follow: false, skippedReasons: ['pending'] };
  return {
    id: str(raw.id) || `${platform}:${videoId}:${str(raw.at) || Date.now()}`,
    platform,
    at: str(raw.at) || new Date().toISOString(),
    videoId,
    bvid: platform === 'bilibili' ? videoId : str(raw.bvid),
    url: str(raw.url),
    title: str(raw.title),
    author: str(raw.author),
    authorId: str(raw.authorId || raw.mid),
    coverUrl: str(raw.coverUrl),
    stills: Array.isArray(raw.stills)
      ? raw.stills.map((s) => {
        if (s && typeof s === 'object') {
          const url = str(s.url || s.imageUrl).trim();
          if (!url) return null;
          return {
            url,
            x: Math.max(0, Math.floor(Number(s.x) || 0)),
            y: Math.max(0, Math.floor(Number(s.y) || 0)),
            width: Math.max(1, Math.floor(Number(s.width) || 160)),
            height: Math.max(1, Math.floor(Number(s.height) || 90)),
            sheetWidth: Math.max(1, Math.floor(Number(s.sheetWidth) || Number(s.width) || 160)),
            sheetHeight: Math.max(1, Math.floor(Number(s.sheetHeight) || Number(s.height) || 90)),
            label: str(s.label),
          };
        }
        const url = str(s).trim();
        return url || null;
      }).filter(Boolean).slice(0, 24)
      : [],
    worthScore: Number.isFinite(Number(raw.worthScore)) ? Number(raw.worthScore) : null,
    summary: str(raw.summary),
    actions,
    replies: Array.isArray(raw.replies) ? raw.replies : [],
  };
}

export async function appendSurfLog(home, entry, platform = 'bilibili') {
  await migrateLegacySurfLog(home).catch(() => {});
  const row = normalizeSurfEntry(entry, platform);
  await appendJsonl(surfLogPath(home, platform), row);
  return row;
}

/** Local calendar day YYYY-MM-DD for an entry timestamp. */
export function surfEntryDayKey(at, nowMs = Date.now()) {
  const d = new Date(at || nowMs);
  if (Number.isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function applySurfFilters(normalized, { filter = 'all', day = '' } = {}) {
  let out = normalized;
  if (filter === 'engaged') out = out.filter((e) => hasEngagement(e.actions) || (e.replies && e.replies.length));
  else if (filter === 'watch-only') out = out.filter((e) => !hasEngagement(e.actions) && !(e.replies && e.replies.length));
  const dayKey = str(day).trim();
  if (dayKey) out = out.filter((e) => surfEntryDayKey(e.at) === dayKey);
  return out;
}

/**
 * Distinct days (newest first) with counts, after engagement filter.
 */
export async function listSurfLogDates(home, {
  platform = 'bilibili',
  filter = 'all',
  scan = 2000,
} = {}) {
  await migrateLegacySurfLog(home).catch(() => {});
  const rows = await readJsonlTail(surfLogPath(home, platform), Math.min(5000, Math.max(200, Math.floor(Number(scan) || 2000))));
  const normalized = rows.map((r) => normalizeSurfEntry(r, platform)).reverse();
  const filtered = applySurfFilters(normalized, { filter });
  const counts = new Map();
  for (const e of filtered) {
    const day = surfEntryDayKey(e.at);
    if (!day) continue;
    counts.set(day, (counts.get(day) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([day, count]) => ({ day, count }))
    .sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));
}

/**
 * List newest-first. filter: all | engaged | watch-only; optional day=YYYY-MM-DD.
 * Supports limit + offset for「加载更多」.
 */
export async function listSurfLogPage(home, {
  platform = 'bilibili',
  filter = 'all',
  day = '',
  limit = 20,
  offset = 0,
} = {}) {
  await migrateLegacySurfLog(home).catch(() => {});
  const cap = Math.min(200, Math.max(1, Math.floor(Number(limit) || 20)));
  const skip = Math.max(0, Math.floor(Number(offset) || 0));
  // Read enough tail rows to cover skip+cap after filter (filters shrink the set).
  const need = Math.min(5000, Math.max((skip + cap) * 6, 200));
  const rows = await readJsonlTail(surfLogPath(home, platform), need);
  const normalized = rows.map((r) => normalizeSurfEntry(r, platform)).reverse();
  const out = applySurfFilters(normalized, { filter, day });
  const total = out.length;
  const entries = out.slice(skip, skip + cap);
  return {
    entries,
    total,
    offset: skip,
    limit: cap,
    day: str(day).trim() || '',
    hasMore: skip + entries.length < total,
  };
}

export async function listSurfLog(home, opts = {}) {
  const page = await listSurfLogPage(home, opts);
  return page.entries;
}

/**
 * Delete one journal row by exact entry id (preferred) or videoId+at.
 */
export async function deleteSurfLogEntry(home, {
  platform = 'bilibili',
  id = '',
  videoId = '',
  at = '',
} = {}) {
  const entryId = str(id).trim();
  const vid = str(videoId).trim();
  const atKey = str(at).trim();
  if (!entryId && !(vid && atKey)) return { ok: false, error: 'id required' };
  const path = surfLogPath(home, platform);
  let raw = '';
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { ok: false, error: 'not-found' };
    throw err;
  }
  const rows = raw
    .split(/\n/)
    .map((line) => {
      const t = line.trim();
      if (!t) return null;
      try {
        return JSON.parse(t);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  let hit = -1;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const n = normalizeSurfEntry(rows[i], platform);
    if (entryId && n.id === entryId) {
      hit = i;
      break;
    }
    if (!entryId && n.videoId === vid && n.at === atKey) {
      hit = i;
      break;
    }
  }
  if (hit < 0) return { ok: false, error: 'not-found' };
  const removed = normalizeSurfEntry(rows[hit], platform);
  rows.splice(hit, 1);
  const text = rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');
  await writeFile(path, text, 'utf8');
  return { ok: true, entry: removed, remaining: rows.length };
}

/**
 * Patch the newest matching entry (by videoId) — used after engage / reply.
 */
export async function patchSurfLogActions(home, { platform = 'bilibili', videoId, at = '', id: entryId = '', actions, replies, summary } = {}) {
  const id = str(videoId).trim();
  const atKey = str(at).trim();
  const exactId = str(entryId).trim();
  if (!id && !exactId) return { ok: false, error: 'videoId required' };
  const path = surfLogPath(home, platform);
  // 全量读再重写：tail 截断会把 500 条以前的旧记录整段丢掉。
  const rows = await readJsonlTail(path, 0);
  let hit = -1;
  let fallback = -1;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const r = rows[i];
    const n = normalizeSurfEntry(r, platform);
    // 优先精确匹配（同片重看会有多条记录，不能把互动记到旧条目上）。
    if (exactId && n.id === exactId) { hit = i; break; }
    if (!exactId && atKey && n.videoId === id && n.at === atKey) { hit = i; break; }
    if (fallback < 0 && str(r.videoId || r.bvid) === id) fallback = i;
  }
  if (hit < 0) hit = fallback;
  if (hit < 0) return { ok: false, error: 'not-found' };
  const next = normalizeSurfEntry(rows[hit], platform);
  if (actions && typeof actions === 'object') next.actions = { ...next.actions, ...actions };
  if (Array.isArray(replies) && replies.length) {
    next.replies = [...(next.replies || []), ...replies];
  }
  if (summary != null) next.summary = str(summary);
  rows[hit] = next;
  const text = rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');
  await writeFile(path, text, 'utf8');
  return { ok: true, entry: next };
}

/**
 * Rewrite summaries for entries where rebuildFn returns a new summary string.
 * rebuildFn(entry) → string | null (null = keep).
 */
export async function rewriteSurfLogSummaries(home, {
  platform = 'bilibili',
  rebuildFn,
} = {}) {
  if (typeof rebuildFn !== 'function') return { ok: false, error: 'rebuildFn required', repaired: 0 };
  const path = surfLogPath(home, platform);
  // 全量读再重写：任何截断都会让重写丢掉旧记录。
  const rows = await readJsonlTail(path, 0);
  let repaired = 0;
  const nextRows = rows.map((raw) => {
    const entry = normalizeSurfEntry(raw, platform);
    const summary = rebuildFn(entry);
    if (summary == null || summary === entry.summary) return entry;
    repaired += 1;
    return { ...entry, summary: str(summary) };
  });
  if (repaired === 0) return { ok: true, repaired: 0 };
  const text = nextRows.map((r) => JSON.stringify(r)).join('\n') + (nextRows.length ? '\n' : '');
  await writeFile(path, text, 'utf8');
  return { ok: true, repaired };
}
