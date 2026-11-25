// QQ inbound vision: when someone sends an image, she should be able to SEE it —
// the mirror carries the attachment URL, the host multimodal model writes a short
// description, and the timeline row reads 「[图片] 描述…」 instead of a blank bubble.
// Voice messages carry the platform's own asr_refer_text; no extra model needed.

import { join } from 'node:path';
import { appendJsonl, loadConfig, readJsonlTail } from '../state.mjs';
import { listImChat } from '../im-chat.mjs';
import { str, clip } from '../small-utils.mjs';

const IMAGE_TYPES = /^image\//i;
const MAX_PER_PASS = 3;

/** Attachment list → the text a reader (and the memory star) should see. */
export function describeAttachments(media, { descriptions = {} } = {}) {
  const parts = [];
  for (const m of Array.isArray(media) ? media : []) {
    const ct = str(m?.contentType);
    if (IMAGE_TYPES.test(ct) || ct === 'image') {
      const d = str(descriptions[str(m?.url)]);
      parts.push(d ? `[图片] ${d}` : '[图片]');
    } else if (/voice|audio|silk/i.test(ct)) {
      const asr = str(m?.asrText);
      parts.push(asr ? `[语音] ${asr}` : '[语音]');
    } else if (/video/i.test(ct)) {
      parts.push('[视频]');
    } else if (ct) {
      parts.push(`[文件] ${str(m?.filename) || ''}`.trim());
    }
  }
  return parts.join(' ');
}

/**
 * One pass: find recent QQ image rows without a description, ask the vision model,
 * journal the result. The timeline rows themselves stay immutable; readers join the
 * descriptions from logs/qq-vision.jsonl (same pattern as bili vision notes).
 */
export async function runQqVisionIfEnabled({ home, warn, describe }) {
  const conf = await loadConfig(home).catch(() => null);
  if (conf?.extensions?.qqVisionEnabled === false) return { ok: true, ran: false, reason: 'disabled' };
  if (typeof describe !== 'function') return { ok: true, ran: false, reason: 'no-vision-model' };

  const journalPath = join(home.rootDir, 'logs', 'qq-vision.jsonl');
  const done = await readJsonlTail(journalPath, 300).catch(() => []);
  const doneUrls = new Set(done.map((r) => str(r?.url)).filter(Boolean));

  const rows = await listImChat(home, { platform: 'qq', peerId: '', limit: 60 }).catch(() => []);
  let described = 0;
  for (const row of rows) {
    if (described >= MAX_PER_PASS) break;
    if (row.role !== 'user' || !Array.isArray(row.media)) continue;
    for (const m of row.media) {
      if (described >= MAX_PER_PASS) break;
      const ct = str(m?.contentType);
      const url = str(m?.url);
      if (!url || (!IMAGE_TYPES.test(ct) && ct !== 'image') || doneUrls.has(url)) continue;
      try {
        const out = await describe({
          prompt: '用一两句中文客观描述这张 QQ 聊天图片的内容（人物/物体/文字/场景），不要猜测发送者意图，不超过 60 字。',
          images: [{ url }],
          purpose: 'qq-vision',
        });
        const text = clip(str(out?.text), 160);
        if (!text) continue;
        await appendJsonl(journalPath, {
          at: new Date().toISOString(), url, messageId: row.messageId, peerId: row.peerId, text,
        });
        doneUrls.add(url);
        described += 1;
      } catch (err) {
        warn('qq vision describe failed', err);
        // Journal the failure so a dead URL is not retried every tick.
        await appendJsonl(journalPath, {
          at: new Date().toISOString(), url, messageId: row.messageId, peerId: row.peerId, text: '', error: str(err?.message || err),
        }).catch(() => {});
        doneUrls.add(url);
      }
    }
  }
  return { ok: true, ran: true, described };
}

/** url → description map for timeline readers. */
export async function readQqVisionDescriptions(home) {
  const rows = await readJsonlTail(join(home.rootDir, 'logs', 'qq-vision.jsonl'), 300).catch(() => []);
  const map = {};
  for (const r of rows) {
    const url = str(r?.url);
    const text = str(r?.text);
    if (url && text) map[url] = text;
  }
  return map;
}