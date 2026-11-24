// Tracks comments we posted so reply-patrol can watch threads.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWriteJson } from '../soulmate-core/state.mjs';

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));

export const commentLedgerPath = (home) => join(home.rootDir, 'surf-comment-ledger-bilibili.json');

export async function readCommentLedger(home) {
  try {
    const data = JSON.parse(await readFile(commentLedgerPath(home), 'utf8'));
    return { threads: Array.isArray(data?.threads) ? data.threads : [] };
  } catch {
    return { threads: [] };
  }
}

export async function writeCommentLedger(home, ledger) {
  await atomicWriteJson(commentLedgerPath(home), ledger);
}

export async function rememberPostedComment(home, { bvid, aid, rpid, videoId, title, commentText } = {}) {
  const id = str(rpid);
  if (!id) return { ok: false };
  const ledger = await readCommentLedger(home);
  if (ledger.threads.some((t) => str(t.rpid) === id)) return { ok: true, duplicate: true };
  ledger.threads.push({
    rpid: id,
    root: id,
    bvid: str(bvid || videoId),
    aid: str(aid),
    title: str(title),
    commentText: str(commentText),
    rounds: 0,
    closed: false,
    seenReplyIds: [],
    at: new Date().toISOString(),
  });
  await writeCommentLedger(home, ledger);
  return { ok: true };
}
