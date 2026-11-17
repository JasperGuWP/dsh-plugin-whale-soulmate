/**
 * Vision-based timeline takeaway for Bilibili digests.
 * Injectable visionSummarize; soft-fails without frames / model / on error.
 */
import { clampLiveFrameEverySec, LIVE_FRAME_DEFAULT_EVERY_SEC } from './live-frames.mjs';
import { composeVideoTakeaway } from './subtitle-align.mjs';

export const VISION_FRAME_MAX = 16;

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const num = (v, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const clip = (s, n) => {
  const t = str(s);
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

const pad2 = (n) => String(Math.floor(Math.max(0, n))).padStart(2, '0');
export function formatClock(sec) {
  const s = Math.max(0, Math.floor(num(sec)));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h > 0 ? `${h}:${pad2(m)}:${pad2(r)}` : `${pad2(m)}:${pad2(r)}`;
}

function frameUrl(f) {
  return str(f?.url || f?.imageUrl || f?.src).trim();
}

function frameTimeSec(f, fallback = 0) {
  if (Number.isFinite(Number(f?.tSec))) return Number(f.tSec);
  if (Number.isFinite(Number(f?.timeSec))) return Number(f.timeSec);
  if (Number.isFinite(Number(f?.from))) return Number(f.from);
  return fallback;
}

/** Evenly pick up to `max` indices from `n` items. */
export function evenIndices(n, max = VISION_FRAME_MAX) {
  const total = Math.max(0, Math.floor(n));
  const cap = Math.max(1, Math.floor(max));
  if (total <= 0) return [];
  if (total <= cap) return Array.from({ length: total }, (_, i) => i);
  const out = [];
  const seen = new Set();
  for (let i = 0; i < cap; i += 1) {
    const idx = Math.round((i * (total - 1)) / (cap - 1));
    if (!seen.has(idx)) {
      seen.add(idx);
      out.push(idx);
    }
  }
  return out;
}

/**
 * Build target sample times for a duration at everySec density.
 */
export function sampleTimes(durationSec, everySec) {
  const every = clampLiveFrameEverySec(everySec ?? LIVE_FRAME_DEFAULT_EVERY_SEC);
  const dur = Math.max(1, Math.floor(num(durationSec, 60)));
  const times = [];
  for (let t = 0; t < dur; t += every) times.push(t);
  if (!times.length) times.push(0);
  if (times[times.length - 1] < dur - 1) {
    // ensure near-end coverage without duplicating last
    const last = Math.max(0, dur - 1);
    if (last - times[times.length - 1] >= Math.max(1, Math.floor(every / 2))) times.push(last);
  }
  return { everySec: every, times };
}

function nearestFrame(frames, tSec) {
  let best = null;
  let bestDist = Infinity;
  for (const f of frames) {
    const url = frameUrl(f);
    if (!url) continue;
    const ft = frameTimeSec(f, 0);
    const d = Math.abs(ft - tSec);
    if (d < bestDist) {
      bestDist = d;
      best = { ...f, url, tSec: ft };
    }
  }
  return best;
}

/**
 * Prefer live frames; else storyboard. Thin to ≤16 by density then evenIndices.
 * @returns {{ frames: object[], source: 'live'|'storyboard'|'none' }}
 */
export function pickVisionFrames({
  liveFrames = [],
  storyboardFrames = [],
  durationSec = 60,
  everySec = LIVE_FRAME_DEFAULT_EVERY_SEC,
  maxFrames = VISION_FRAME_MAX,
} = {}) {
  const live = (Array.isArray(liveFrames) ? liveFrames : []).filter((f) => frameUrl(f));
  const board = (Array.isArray(storyboardFrames) ? storyboardFrames : []).filter((f) => frameUrl(f));
  const pool = live.length ? live : board;
  const source = live.length ? 'live' : board.length ? 'storyboard' : 'none';
  if (!pool.length) return { frames: [], source: 'none' };

  const { times } = sampleTimes(durationSec, everySec);
  const mapped = [];
  const used = new Set();
  for (const t of times) {
    const hit = nearestFrame(pool, t);
    if (!hit) continue;
    const key = `${hit.url}@${hit.tSec}`;
    if (used.has(key)) continue;
    used.add(key);
    mapped.push({
      tSec: hit.tSec,
      url: hit.url,
      label: str(hit.label) || formatClock(hit.tSec),
    });
  }
  // Fallback: if density mapping yielded nothing, take evenly from pool order
  const candidates = mapped.length
    ? mapped
    : pool.map((f, i) => ({
      tSec: frameTimeSec(f, i),
      url: frameUrl(f),
      label: str(f.label) || formatClock(frameTimeSec(f, i)),
    }));

  const idxs = evenIndices(candidates.length, maxFrames);
  return {
    frames: idxs.map((i) => candidates[i]),
    source,
  };
}

export function buildVisionPrompt({ title = '', desc = '', transcript = '', frames = [], worthScore = 0 } = {}) {
  const lines = [
    '你是视频内容分析助手。请根据【标题】【简介】【可选字幕】以及按时间顺序给出的画面帧，写出能让读者完整了解本片内容的中文总结。',
    '要求：以画面为准；字幕仅在与标题相符时参考；不要编造与画面无关的情节。',
    '输出格式（严格）：',
    '总览：<一句话>',
    '时间线：',
    '· mm:ss–mm:ss <章标题>：<要点>',
    '· …（3–6 段）',
    '观感：<一句话，结合信息密度>',
    '',
    `标题：${clip(title, 120)}`,
    `简介：${clip(desc, 400) || '（无）'}`,
    `评分参考：${num(worthScore, 0)}/20`,
  ];
  const tx = str(transcript).trim();
  if (tx) lines.push(`字幕摘录：${clip(tx, 800)}`);
  lines.push('画面帧（按时间）：');
  for (const f of frames) {
    lines.push(`- ${formatClock(f.tSec)} ${f.label || ''}`.trim());
  }
  return lines.join('\n');
}

/**
 * Parse model text into structured parts; tolerant of minor format drift.
 */
export function parseVisionTimelineText(raw) {
  const text = str(raw).replace(/\r\n/g, '\n').trim();
  if (!text) return null;
  let overview = '';
  const chapters = [];
  let opinion = '';

  const overviewM = text.match(/(?:总览|一句话总览|讲了什么)\s*[:：]\s*(.+)/);
  if (overviewM) overview = overviewM[1].trim().split('\n')[0];

  const opinionM = text.match(/观感\s*[:：]\s*(.+)/);
  if (opinionM) opinion = opinionM[1].trim().split('\n')[0];

  const body = text.includes('时间线') ? text.split(/时间线\s*[:：]?\s*/)[1] || '' : text;
  const chapterPart = opinionM ? body.slice(0, body.indexOf(opinionM[0])) : body;
  for (const line of chapterPart.split('\n')) {
    const t = line.replace(/^[\s·\-•*]+/, '').trim();
    if (!t) continue;
    if (/^(总览|观感|标题|简介)/.test(t)) continue;
    const m = t.match(/^(\d{1,2}:\d{2}(?::\d{2})?)\s*[–—\-~～至到]+\s*(\d{1,2}:\d{2}(?::\d{2})?)\s*(.*)$/);
    if (m) {
      chapters.push({ start: m[1], end: m[2], text: m[3].replace(/^[:：]\s*/, '').trim() });
    } else if (chapters.length < 8 && t.length >= 4 && !/^观感/.test(t)) {
      chapters.push({ start: '', end: '', text: t });
    }
  }

  if (!overview && chapters.length) overview = chapters[0].text.slice(0, 80);
  if (!overview) overview = clip(text.split('\n').find((l) => l.trim().length > 8) || text, 120);
  return { overview, chapters: chapters.slice(0, 8), opinion };
}

export function formatVisionTakeaway({ overview, chapters, opinion, worthScore = 0 } = {}) {
  const score = num(worthScore, 0);
  const fallbackOpinion = score >= 13
    ? '信息密度还可以，值得记一笔。'
    : score >= 7
      ? '一般，挑着看就行。'
      : '水分偏多，下次换方向。';
  const op = str(opinion).replace(/^观感\s*[:：]\s*/, '').trim() || fallbackOpinion;
  const lines = [`讲了什么：${str(overview).trim() || '（画面摘要生成中）'}`];
  if (chapters?.length) {
    lines.push('时间线：');
    for (const c of chapters) {
      const span = c.start && c.end ? `${c.start}–${c.end} ` : '';
      lines.push(`· ${span}${c.text}`.trim());
    }
  }
  lines.push(`观感：${op}`);
  return lines.join('\n');
}

/** Append engagement phrase: ｜已点赞、已收藏 */
export function appendEngagePhrase(summary, actions = {}) {
  let base = str(summary).replace(/\s*｜(?:已点赞|已收藏|已评论|已关注|仅观看)[^｜]*$/u, '').trim();
  const bits = [];
  if (actions.like) bits.push('已点赞');
  if (actions.favorite) bits.push('已收藏');
  if (actions.comment) bits.push('已评论');
  if (actions.follow) bits.push('已关注');
  if (!bits.length) {
    const skipped = Array.isArray(actions.skippedReasons) ? actions.skippedReasons : [];
    if (skipped.length && !skipped.includes('pending-engage')) {
      return `${base}｜仅观看`;
    }
    return base;
  }
  return `${base}｜${bits.join('、')}`;
}

/**
 * Full pipeline. visionSummarize required for success.
 * @returns {{ ok, channel, takeaway, frames?, error? }}
 */
export async function composeVisionTimelineSummary({
  digest = {},
  everySec = LIVE_FRAME_DEFAULT_EVERY_SEC,
  visionSummarize,
  model = '',
  maxFrames = VISION_FRAME_MAX,
} = {}) {
  if (typeof visionSummarize !== 'function') {
    return { ok: false, channel: 'skip:no-vision-model', takeaway: '', error: 'no-vision-callback' };
  }

  const live = digest.liveFrameStills
    || digest.liveFrames?.frames
    || [];
  const board = digest.storyboardFrames || [];
  const picked = pickVisionFrames({
    liveFrames: live,
    storyboardFrames: board,
    durationSec: digest.durationSec,
    everySec,
    maxFrames,
  });
  if (!picked.frames.length) {
    return { ok: false, channel: 'skip:no-frames', takeaway: '', error: 'no-frames' };
  }

  const prompt = buildVisionPrompt({
    title: digest.title,
    desc: digest.desc,
    transcript: digest.transcript || digest.subtitle?.text || '',
    frames: picked.frames,
    worthScore: digest.worthScore,
  });

  try {
    const out = await visionSummarize({
      model: str(model).trim() || undefined,
      prompt,
      images: picked.frames.map((f) => ({ tSec: f.tSec, url: f.url, label: f.label })),
    });
    const raw = str(out?.text ?? out?.content ?? out).trim();
    if (!raw) {
      return { ok: false, channel: 'skip:vision-error', takeaway: '', error: 'empty-response', frames: picked.frames };
    }
    const parsed = parseVisionTimelineText(raw);
    const takeaway = formatVisionTakeaway({
      overview: parsed?.overview,
      chapters: parsed?.chapters,
      opinion: parsed?.opinion,
      worthScore: digest.worthScore,
    });
    return {
      ok: true,
      channel: picked.source === 'live' ? 'ok:live' : 'ok:storyboard',
      takeaway,
      frames: picked.frames,
      raw,
    };
  } catch (err) {
    return {
      ok: false,
      channel: 'skip:vision-error',
      takeaway: '',
      error: err instanceof Error ? err.message : String(err),
      frames: picked.frames,
    };
  }
}

/** Soft fallback takeaway with optional「未看画面」tag in opinion. */
export function fallbackTakeawayWithVisionNote(digest, { note = '未看画面' } = {}) {
  let t = composeVideoTakeaway({
    title: digest?.title,
    desc: digest?.desc,
    transcript: digest?.transcript || '',
    tags: digest?.tags,
    worthScore: digest?.worthScore,
  });
  if (note && !t.includes(note)) {
    t = t.replace(/观感：/, `观感：（${note}）`);
  }
  return t;
}
