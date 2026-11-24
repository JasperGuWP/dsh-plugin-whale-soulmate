// Mirror real QQ msg_ids to disk for the proactive sender.
//
// The official SDK caches reply msg_ids in memory only; the DSH session transcript
// stores DSH-internal ids, which the QQ platform rejects ("msg_id 无效或越权").
// QQBot is an exported class, so we wrap its inbound handler once to record
// { scope, targetId, msgId, at } per message into a small json file the bridge reads.
// This is additive (calls through unchanged) and reversible on dispose.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

const DEFAULT_STORE = join(homedir(), '.dsh', 'soulmate', 'logs', 'qq-msgids.json');
let STORE = DEFAULT_STORE;
/** Test seam: point the mirror at a temp file. */
export function setQqMsgIdStore(p) { STORE = p || DEFAULT_STORE; }
const TTL_GROUP = 5 * 60_000;
const TTL_C2C = 30 * 60_000;
const MAX_PER_TARGET = 10;

let patched = false;
let original = null;

async function record(scope, targetId, msgId) {
  if (!scope || !targetId || !msgId) return;
  let data = { targets: {} };
  try { data = JSON.parse(await readFile(STORE, 'utf8')); } catch { /* fresh */ }
  if (!data.targets || typeof data.targets !== 'object') data.targets = {};
  const key = `${scope}:${targetId}`;
  const now = Date.now();
  const ttl = scope === 'group' ? TTL_GROUP : TTL_C2C;
  const list = (Array.isArray(data.targets[key]) ? data.targets[key] : [])
    .filter((e) => e && now - (Number(e.at) || 0) < ttl && e.msgId !== msgId);
  list.push({ msgId, at: now });
  data.targets[key] = list.slice(-MAX_PER_TARGET);
  try {
    await mkdir(dirname(STORE), { recursive: true });
    await writeFile(STORE, JSON.stringify(data), 'utf8');
  } catch { /* best effort */ }
}

/**
 * Install the prototype wrap once. Returns a disposer that restores the original.
 * Safe if QQBot is unavailable (tests / non-QQ hosts): returns a no-op.
 */
export function startQqMsgIdMirror(ctx, QQBotClass) {
  const QQBot = QQBotClass;
  if (patched || !QQBot || typeof QQBot.prototype?.handleInboundMessage !== 'function') {
    return () => {};
  }
  original = QQBot.prototype.handleInboundMessage;
  QQBot.prototype.handleInboundMessage = async function (raw) {
    try {
      if (raw && raw.kind === 'c2c' && raw.senderId && raw.messageId) {
        void record('c2c', raw.senderId, raw.messageId);
      } else if (raw && raw.kind === 'group' && raw.groupOpenid && raw.messageId) {
        void record('group', raw.groupOpenid, raw.messageId);
      }
    } catch { /* never break inbound */ }
    return original.call(this, raw);
  };
  patched = true;
  const dispose = () => {
    if (patched && original) QQBot.prototype.handleInboundMessage = original;
    patched = false;
    original = null;
  };
  if (typeof ctx?.effect === 'function') ctx.effect(() => dispose);
  return dispose;
}

/** Read fresh reply ids for a target (newest first), for the proactive sender. */
export async function readQqReplyIds(scope, targetId, nowMs = Date.now()) {
  let data = null;
  try { data = JSON.parse(await readFile(STORE, 'utf8')); } catch { return []; }
  const key = `${scope}:${targetId}`;
  const ttl = scope === 'group' ? TTL_GROUP : TTL_C2C;
  const list = Array.isArray(data?.targets?.[key]) ? data.targets[key] : [];
  return list
    .filter((e) => e && e.msgId && nowMs - (Number(e.at) || 0) < ttl)
    .sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0));
}