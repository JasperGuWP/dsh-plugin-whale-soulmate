// Long-video consent gate.
//
// User rule (2026-11-26): an extra-long video may be watched only after the user
// agrees. Auto-surf used to pick a 65-minute video and consume it unattended; now it
// parks the candidate in a pending list, and a human "看" is required before any
// frames / subtitles / vision / memory work happens.
//
// The store is local JSON next to the surf ledger. 0 minutes disables the gate.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWriteJson } from '../soulmate-core/state.mjs';
import { clip, str } from '../soulmate-core/small-utils.mjs';

export const DEFAULT_LONG_VIDEO_CONSENT_MINUTES = 60;
export const LONG_CONSENT_TTL_MS = 3 * 86_400_000;
const MAX_ITEMS = 30;
const FILE = 'bili-long-consent.json';

/** Threshold in minutes; 0 = gate disabled. Unset/invalid falls back to 60. */
export function longVideoConsentMinutes(ext = {}) {
  const raw = ext?.biliLongVideoConsentMinutes;
  if (raw === 0 || raw === '0' || raw === false) return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_LONG_VIDEO_CONSENT_MINUTES;
}

export function needsLongVideoConsent(durationSec, ext = {}) {
  const mins = longVideoConsentMinutes(ext);
  return mins > 0 && Number(durationSec) >= mins * 60;
}

const pathOf = (home) => join(home.rootDir, FILE);

export async function readLongConsents(home) {
  try {
    const raw = await readFile(pathOf(home), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.items) ? parsed.items.filter((x) => x && typeof x === 'object') : [];
  } catch {
    return [];
  }
}

async function writeLongConsents(home, items) {
  const kept = items
    .filter((x) => x && x.bvid)
    .slice(-MAX_ITEMS);
  await atomicWriteJson(pathOf(home), { version: 1, items: kept });
}

/** Waiting for the user, newest first. Expired entries are hidden (and pruned on write). */
export async function listPendingLongConsents(home, { nowMs = Date.now() } = {}) {
  const items = await readLongConsents(home);
  return items
    .filter((x) => x.status === 'pending' && (!x.expiresAt || Date.parse(x.expiresAt) > nowMs))
    .sort((a, b) => (Date.parse(b.requestedAt) || 0) - (Date.parse(a.requestedAt) || 0));
}

/** Park one auto-found long video. Idempotent per bvid while still pending. */
export async function requestLongConsent(home, {
  bvid, title = '', author = '', durationSec = 0, url = '', coverUrl = '',
  source = '', keyword = '', nowMs = Date.now(),
} = {}) {
  const id = str(bvid).trim();
  if (!id) return null;
  const items = await readLongConsents(home);
  const existing = items.find((x) => x.bvid === id && x.status === 'pending');
  if (existing) return existing;
  const at = new Date(nowMs);
  const item = {
    bvid: id,
    title: clip(str(title), 80),
    author: clip(str(author), 40),
    durationSec: Math.max(0, Math.floor(Number(durationSec) || 0)),
    url: str(url),
    coverUrl: str(coverUrl),
    source: str(source),
    keyword: str(keyword),
    status: 'pending',
    requestedAt: at.toISOString(),
    expiresAt: new Date(nowMs + LONG_CONSENT_TTL_MS).toISOString(),
  };
  await writeLongConsents(home, [...items, item]);
  return item;
}

/** Approve / decline one pending item. Returns the updated item, or null when absent. */
export async function resolveLongConsent(home, { bvid, action = 'approve', nowMs = Date.now() } = {}) {
  const id = str(bvid).trim();
  if (!id) return null;
  const items = await readLongConsents(home);
  const item = items.find((x) => x.bvid === id && x.status === 'pending');
  if (!item) return null;
  item.status = action === 'decline' ? 'declined' : 'approved';
  item.decidedAt = new Date(nowMs).toISOString();
  await writeLongConsents(home, items);
  return item;
}

/** Record the outcome after an approved watch so the panel/ledger can be honest. */
export async function settleLongConsent(home, { bvid, status = 'watched', error = '', nowMs = Date.now() } = {}) {
  const id = str(bvid).trim();
  if (!id) return null;
  const items = await readLongConsents(home);
  const item = items.find((x) => x.bvid === id && (x.status === 'approved' || x.status === 'pending'));
  if (!item) return null;
  item.status = status;
  item.settledAt = new Date(nowMs).toISOString();
  if (error) item.error = clip(str(error), 200);
  await writeLongConsents(home, items);
  return item;
}