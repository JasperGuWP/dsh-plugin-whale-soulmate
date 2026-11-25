// Live mirror of the official QQ bot's inbound messages, lifecycle events and button
// interactions — written by the qqbot-server wrapper (same process as the SDK), read by
// the soulmate bridge. This replaces transcript-zstd polling as the PRIMARY inbound path:
// real QQ msg_ids, real timestamps, attachments and sender nicknames arrive the moment
// the platform delivers them, with no multi-frame zstd decoding in the loop.
//
// The original msg-id window store (qq-msgids.json) is still maintained for the sender.

import { readFile, writeFile, mkdir, rename, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { clip, str } from './small-utils.mjs';

const DEFAULT_DIR = join(homedir(), '.dsh', 'soulmate', 'logs');
let DIR = DEFAULT_DIR;
/** Test seam: point every mirror file at a temp dir. */
export function setQqInboundStore(dir) { DIR = dir || DEFAULT_DIR; }

export const qqInboundPath = () => join(DIR, 'qq-inbound.jsonl');
export const qqOutboundPath = () => join(DIR, 'qq-outbound.jsonl');
export const qqLifecyclePath = () => join(DIR, 'qq-lifecycle.jsonl');
export const qqInteractionsPath = () => join(DIR, 'qq-interactions.jsonl');

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const KEEP_BYTES = 1024 * 1024;

async function appendLine(path, row) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(row)}\n`, { encoding: 'utf8', flag: 'a' });
  // Bound growth: keep the newer half once the file passes the ceiling.
  try {
    const st = await stat(path);
    if (st.size > MAX_FILE_BYTES) {
      const raw = await readFile(path, 'utf8');
      const tail = raw.slice(raw.length - KEEP_BYTES);
      const nl = tail.indexOf('\n');
      const trimmed = nl >= 0 ? tail.slice(nl + 1) : tail;
      const tmp = `${path}.tmp-${process.pid}`;
      await writeFile(tmp, trimmed, 'utf8');
      await rename(tmp, path);
    }
  } catch { /* best effort */ }
}

/** RawMessageAttachment[] → compact, storable descriptors. */
export function normalizeAttachments(list) {
  const out = [];
  for (const a of Array.isArray(list) ? list : []) {
    if (!a || typeof a !== 'object') continue;
    const contentType = str(a.content_type).trim();
    const url = str(a.url).trim();
    if (!contentType && !url) continue;
    out.push({
      contentType,
      url: clip(url, 600),
      filename: clip(str(a.filename), 120),
      voiceWavUrl: clip(str(a.voice_wav_url), 600),
      asrText: clip(str(a.asr_refer_text), 300),
      width: Number(a.width) || 0,
      height: Number(a.height) || 0,
    });
  }
  return out.slice(0, 9);
}

/** One inbound SDK message → the flat row the bridge consumes. */
export function inboundRowFromRaw(raw, nowMs = Date.now()) {
  if (!raw || typeof raw !== 'object') return null;
  const kind = raw.kind === 'group' ? 'group' : raw.kind === 'c2c' ? 'c2c' : '';
  const targetId = kind === 'group' ? str(raw.groupOpenid) : str(raw.senderId);
  const msgId = str(raw.messageId);
  if (!kind || !targetId || !msgId) return null;
  const ts = Date.parse(str(raw.timestamp));
  return {
    at: new Date(Number.isFinite(ts) ? ts : nowMs).toISOString(),
    receivedAt: new Date(nowMs).toISOString(),
    kind,
    targetId,
    msgId,
    senderId: str(raw.senderId),
    senderName: clip(str(raw.senderName), 80),
    senderIsBot: raw.senderIsBot === true,
    text: clip(str(raw.content), 1800),
    attachments: normalizeAttachments(raw.attachments),
  };
}

export async function recordQqInbound(raw, nowMs = Date.now()) {
  const row = inboundRowFromRaw(raw, nowMs);
  if (!row) return null;
  await appendLine(qqInboundPath(), row);
  return row;
}

/** Read mirror rows newer than `sinceIso` (exclusive), oldest first. */
export async function readQqInboundSince(sinceIso = '', { path = qqInboundPath(), limit = 500 } = {}) {
  let raw = '';
  try { raw = await readFile(path, 'utf8'); } catch { return []; }
  const sinceMs = Date.parse(str(sinceIso)) || 0;
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    const t = Date.parse(str(row?.receivedAt || row?.at));
    if (!Number.isFinite(t) || t <= sinceMs) continue;
    out.push(row);
  }
  return out.slice(-Math.max(1, limit));
}

export async function recordQqOutbound(row) {
  if (!row || !str(row.targetId) || !str(row.messageId)) return null;
  const full = {
    at: str(row.at) || new Date().toISOString(),
    kind: row.kind === 'group' ? 'group' : 'c2c',
    targetId: str(row.targetId),
    messageId: str(row.messageId),
    text: clip(str(row.text), 1800),
    mediaType: str(row.mediaType),
    via: str(row.via) || 'proactive',
  };
  await appendLine(qqOutboundPath(), full);
  return full;
}

export async function recordQqLifecycle(eventType, data, nowMs = Date.now()) {
  const type = str(eventType).trim();
  if (!type) return null;
  const d = data && typeof data === 'object' ? data : {};
  const row = {
    at: new Date(nowMs).toISOString(),
    type,
    groupOpenid: str(d.group_openid),
    openid: str(d.openid || d.user_openid),
    memberOpenid: str(d.group_member_openid || d.member_openid),
    opOpenid: str(d.op_member_openid || d.op_user_openid),
  };
  await appendLine(qqLifecyclePath(), row);
  return row;
}

export async function recordQqInteraction(event, nowMs = Date.now()) {
  if (!event || typeof event !== 'object') return null;
  const resolved = event.data?.resolved || {};
  const row = {
    at: new Date(nowMs).toISOString(),
    id: str(event.id),
    scene: str(event.scene),
    groupOpenid: str(event.group_openid),
    userOpenid: str(event.user_openid),
    memberOpenid: str(event.group_member_openid),
    buttonId: str(resolved.button_id),
    buttonData: clip(str(resolved.button_data), 300),
    messageId: str(resolved.message_id),
    acked: false,
  };
  if (!row.id) return null;
  await appendLine(qqInteractionsPath(), row);
  return row;
}

let installed = false;
let originalInbound = null;

/**
 * Wrap QQBot.prototype.handleInboundMessage once: record the full message (ids,
 * sender, attachments) then call through unchanged. Reversible via the returned disposer.
 */
export function installQqInboundMirror(ctx, QQBotClass) {
  if (installed || !QQBotClass || typeof QQBotClass.prototype?.handleInboundMessage !== 'function') {
    return () => {};
  }
  originalInbound = QQBotClass.prototype.handleInboundMessage;
  QQBotClass.prototype.handleInboundMessage = async function (raw) {
    try { await recordQqInbound(raw); } catch { /* never break inbound */ }
    return originalInbound.call(this, raw);
  };
  installed = true;
  const dispose = () => {
    if (installed && originalInbound) QQBotClass.prototype.handleInboundMessage = originalInbound;
    installed = false;
    originalInbound = null;
  };
  if (typeof ctx?.effect === 'function') ctx.effect(() => dispose);
  return dispose;
}

/**
 * Attach lifecycle + interaction listeners to one live bot instance. `start` may be the
 * SDK's start() (instance created inside the official plugin) — we hook the prototype
 * once so whichever instance starts gets the listeners before its gateway connects.
 */
export function installQqBotEventMirror(ctx, QQBotClass) {
  if (!QQBotClass || typeof QQBotClass.prototype?.start !== 'function' || typeof QQBotClass.prototype?.on !== 'function') {
    return () => {};
  }
  const originalStart = QQBotClass.prototype.start;
  let hooked = true;
  const onRaw = (rawCtx) => { void recordQqLifecycle(rawCtx?.eventType, rawCtx?.data).catch(() => {}); };
  const onInteraction = (interactionCtx) => { void recordQqInteraction(interactionCtx?.event).catch(() => {}); };
  QQBotClass.prototype.start = async function (...args) {
    try {
      this.on('rawEvent', onRaw);
      this.on('interaction', onInteraction);
    } catch { /* listeners are additive */ }
    return originalStart.apply(this, args);
  };
  const dispose = () => {
    if (hooked) QQBotClass.prototype.start = originalStart;
    hooked = false;
  };
  if (typeof ctx?.effect === 'function') ctx.effect(() => dispose);
  return dispose;
}