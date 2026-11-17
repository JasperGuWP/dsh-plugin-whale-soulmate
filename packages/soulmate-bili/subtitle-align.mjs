/** Shared title↔transcript alignment + takeaway composition (no circular imports). */

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const num = (v, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const clip = (s, n) => {
  const t = str(s);
  return t.length > n ? `${t.slice(0, n)}…` : t;
};
const stripTags = (s) => str(s).replace(/<[^>]*>/g, '');
const stripControl = (s) => str(s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');

const SUBTITLE_SPAM_RE = /投降\s*包村|包村\s*拥|拥\s*威信|威信\s*扫|敲重点\s*[↓⬇]+|加\s*[微薇威]\s*信|薇信|威信|二维码|扫一扫|关注公众号|私信领取|免费领取/i;

export function scrubTranscriptNoise(text) {
  let t = stripControl(stripTags(text)).replace(/\s+/g, ' ').trim();
  if (!t) return '';
  t = t
    .split(/(?<=[。！？\n])|(?=敲重点)/)
    .map((part) => part.trim())
    .filter((part) => part && !SUBTITLE_SPAM_RE.test(part) && !/^(↓|⬇|\.|…|-)+$/.test(part))
    .join('');
  t = t.replace(/(.{4,24}?)(?:\s*\1){2,}/g, '$1');
  t = t.replace(/(投降\s*包村\s*拥\s*威信\s*扫\s*)+/g, '');
  t = t.replace(/(敲重点\s*[↓⬇]*\s*)+/g, '');
  return t.replace(/\s+/g, ' ').trim();
}

/** Title/desc cues should appear in a real transcript; discard mismatched AI subtitles. */
export function transcriptAlignedWithMeta({ title = '', desc = '', transcript = '' } = {}) {
  const text = scrubTranscriptNoise(transcript);
  if (text.length < 40) return { aligned: true, reason: 'short-or-empty' };
  const stop = new Set([
    '视频', '什么', '一个', '我们', '他们', '以及', '这个', '那个', '今天', '分享', '一起',
    '可以', '因为', '所以', '如果', '还是', '不是', '就是', '真的', '感觉', '如何', '进行',
    'the', 'and', 'for', 'with', 'http', 'https', 'www',
  ]);
  const meta = str(`${title} ${desc}`);
  const cues = [];
  const cjkOnly = meta.replace(/[^\u4e00-\u9fff]/g, '');
  for (let i = 0; i < cjkOnly.length - 1; i += 1) {
    const bg = cjkOnly.slice(i, i + 2);
    if (!stop.has(bg)) cues.push(bg);
  }
  for (const m of meta.match(/[A-Za-z][A-Za-z0-9_-]{2,}/g) || []) {
    const t = m.toLowerCase();
    if (!stop.has(t)) cues.push(t);
  }
  const uniq = [...new Set(cues)].slice(0, 40);
  if (uniq.length < 3) return { aligned: true, reason: 'few-tokens', tokens: uniq.length };
  const hay = text.slice(0, 1200).toLowerCase();
  const hits = uniq.filter((t) => hay.includes(String(t).toLowerCase()));
  const ratio = hits.length / uniq.length;
  if (hits.length === 0) return { aligned: false, reason: 'no-title-overlap', hits: 0, tokens: uniq.length };
  if (ratio < 0.06) return { aligned: false, reason: 'weak-overlap', hits: hits.length, tokens: uniq.length };
  return { aligned: true, reason: 'ok', hits: hits.length, tokens: uniq.length };
}

/** Extract the「讲了什么」body from a takeaway/summary line for alignment checks. */
export function takeawayBodyOf(text) {
  let t = str(text);
  // composeSurfSummary: 看了《title》@author，评分 N/20。讲了什么：…
  t = t.replace(/^看了《[\s\S]*?》(?:@[^，,]*)?，评分\s*\d+\/20。/, '');
  t = t.replace(/^讲了什么：/, '');
  t = t.replace(/\s*观感：[\s\S]*$/, '');
  return t.trim();
}

/**
 * Build a short「讲了什么 + 观感」takeaway — never dump raw spammy / mismatched subtitles.
 */
export function composeVideoTakeaway({
  title = '',
  desc = '',
  transcript = '',
  tags = [],
  worthScore = 0,
} = {}) {
  let cleanedTx = scrubTranscriptNoise(transcript);
  if (cleanedTx.length >= 40) {
    const align = transcriptAlignedWithMeta({ title, desc, transcript: cleanedTx });
    if (!align.aligned) cleanedTx = '';
  }
  const cleanedDesc = scrubTranscriptNoise(desc);
  const source = cleanedTx.length >= 40 ? cleanedTx : (cleanedDesc.length >= 12 ? cleanedDesc : '');
  let content = '';
  if (source) {
    content = clip(source.replace(/^[：:\-—\s]+/, ''), 160);
  } else {
    const tagBits = (Array.isArray(tags) ? tags : []).map((x) => str(x).trim()).filter(Boolean).slice(0, 4);
    content = tagBits.length
      ? `从标题与标签看，偏「${tagBits.join('、')}」方向`
      : `从标题看是「${clip(stripControl(title), 40)}」`;
  }
  const score = num(worthScore, 0);
  const opinion = score >= 13
    ? '观感：信息密度还可以，值得记一笔。'
    : score >= 7
      ? '观感：一般，挑着看就行。'
      : '观感：水分偏多，下次换方向。';
  return `讲了什么：${content} ${opinion}`;
}

/** True when an existing takeaway/summary body clearly diverges from the video title. */
export function takeawayMismatchesTitle(title, takeawayOrSummary) {
  const body = takeawayBodyOf(takeawayOrSummary);
  if (body.length < 40) return false;
  const align = transcriptAlignedWithMeta({ title, transcript: body });
  return !align.aligned;
}
