// Per-platform surf journal (screenshots, links, summary, on-platform actions).
import { access, rename, writeFile } from 'node:fs/promises';
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

/**
 * List newest-first. filter: all | engaged | watch-only
 */
export async function listSurfLog(home, { platform = 'bilibili', filter = 'all', limit = 40 } = {}) {
  await migrateLegacySurfLog(home).catch(() => {});
  const cap = Math.min(200, Math.max(1, Math.floor(Number(limit) || 40)));
  const rows = await readJsonlTail(surfLogPath(home, platform), Math.max(cap * 3, 120));
  const normalized = rows.map((r) => normalizeSurfEntry(r, platform)).reverse();
  let out = normalized;
  if (filter === 'engaged') out = normalized.filter((e) => hasEngagement(e.actions) || (e.replies && e.replies.length));
  else if (filter === 'watch-only') out = normalized.filter((e) => !hasEngagement(e.actions) && !(e.replies && e.replies.length));
  return out.slice(0, cap);
}

/**
 * Patch the newest matching entry (by videoId) — used after engage / reply.
 */
export async function patchSurfLogActions(home, { platform = 'bilibili', videoId, actions, replies, summary } = {}) {
  const id = str(videoId).trim();
  if (!id) return { ok: false, error: 'videoId required' };
  const path = surfLogPath(home, platform);
  const rows = await readJsonlTail(path, 500);
  let hit = -1;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const r = rows[i];
    if (str(r.videoId || r.bvid) === id) {
      hit = i;
      break;
    }
  }
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
