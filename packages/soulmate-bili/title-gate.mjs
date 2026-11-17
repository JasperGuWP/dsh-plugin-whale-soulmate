/**
 * Pre-watch title gate: skip obvious bait / outbound-link / follow-farm titles
 * before spending ffmpeg frames or multimodal tokens.
 */

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));

/** Normalize fancy unicode slashes / fullwidth punctuation used to smuggle URLs. */
export function normalizeTitleForGate(title = '') {
  return str(title)
    .normalize('NFKC')
    .replace(/[\u2044\u2215\u29F8\uFF0F\u2571\u29F6]/g, '/')
    .replace(/[\uFF1A]/g, ':')
    .replace(/[\uFF0E]/g, '.')
    .replace(/\s+/g, ' ')
    .trim();
}

const SHORT_LINK_RE = /\b(?:t\.co|bit\.ly|tinyurl\.com|goo\.gl|shorturl\.at|url\.cn|b23\.tv\/\w{0,4}$)\b/i;
const OUTBOUND_HOST_RE = /\b(?:https?:\/\/|www\.)\S+/i;
const X_STATUS_RE = /\b(?:x\.com|twitter\.com)\/\S+/i;
const FOLLOW_BAIT_RE = /follow\s*(me|back|for\s*follow)|互粉|求关|求关注|请关注|关注我|回关|互关|请关|双关|涨粉|引流/i;
const TEAM_FOLLOW_RE = /bilibili\s*team\s*follow|please\s+.{0,40}follow\s*(me|back)?/i;
const LIVE_TEASE_RE = /newest\s+video\s+is\s+live|come\s+(join|watch|quick)|video\s+loading|surprise\s*!/i;
const WECHAT_BAIT_RE = /加微信|加v\b|私信领取|扫码加|联系方式|优惠券|免费领/i;

/**
 * @returns {{ ok: boolean, reason: string, kind: string }}
 * kind: ok | short-link | outbound-link | follow-bait | tease | empty | gibberish
 */
export function assessTitleWatchWorth(title = '', { desc = '' } = {}) {
  const raw = str(title).trim();
  const t = normalizeTitleForGate(raw);
  const d = normalizeTitleForGate(desc);
  const blob = `${t} ${d}`.trim();

  if (!t || t.length < 2) {
    return { ok: false, reason: '标题为空', kind: 'empty' };
  }
  if (SHORT_LINK_RE.test(blob) || /https?:\/\/t\.co\//i.test(blob)) {
    return { ok: false, reason: '标题像外链引流（短链）', kind: 'short-link' };
  }
  if (X_STATUS_RE.test(blob)) {
    return { ok: false, reason: '标题主要是站外动态链接', kind: 'outbound-link' };
  }
  // Title is mostly a URL / domain + filler.
  const withoutUrls = t.replace(OUTBOUND_HOST_RE, '').replace(/[-_|·•]+/g, ' ').trim();
  if (OUTBOUND_HOST_RE.test(t) && withoutUrls.length < 8) {
    return { ok: false, reason: '标题几乎只有链接', kind: 'outbound-link' };
  }
  if (FOLLOW_BAIT_RE.test(blob) || TEAM_FOLLOW_RE.test(blob)) {
    return { ok: false, reason: '标题像求关注/互粉引导', kind: 'follow-bait' };
  }
  if (LIVE_TEASE_RE.test(blob)) {
    return { ok: false, reason: '标题像空壳引流话术', kind: 'tease' };
  }
  if (WECHAT_BAIT_RE.test(blob)) {
    return { ok: false, reason: '标题像私域引流', kind: 'follow-bait' };
  }
  // Very short Latin gibberish with almost no CJK / readable words.
  const cjk = (t.match(/[\u4e00-\u9fff]/g) || []).length;
  const letters = (t.match(/[A-Za-z]/g) || []).length;
  if (t.length <= 12 && cjk === 0 && letters <= 6 && !/\d{2,}/.test(t)) {
    return { ok: false, reason: '标题过短且无实质内容', kind: 'gibberish' };
  }
  return { ok: true, reason: '', kind: 'ok' };
}
