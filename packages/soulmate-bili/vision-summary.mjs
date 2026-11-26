/**
 * Vision-based timeline takeaway for Bilibili digests.
 * Injectable visionSummarize; soft-fails without frames / model / on error.
 */
import { clampLiveFrameEverySec, LIVE_FRAME_DEFAULT_EVERY_SEC } from './live-frames.mjs';
import { composeVideoTakeaway } from './subtitle-align.mjs';
import { classifyVideoGenre, opinionInstruction } from './video-genre.mjs';

export const VISION_FRAME_MAX = 16;
/** 观感上限：500 字（用户要求）。模型写超了就截断，别让观感淹没时间线。 */
export const VISION_OPINION_MAX_CHARS = 500;
/** 分批看图：每批帧数上限（宿主单条消息图片上限 20，末帧锚点占 1 席也够）。 */
export const VISION_BATCH_SIZE = 16;
/** 分批看图：单次看片最多批数，防超长片把 token 烧穿；超出部分均匀降采样覆盖全片。 */
export const VISION_BATCH_MAX = 10;

/**
 * How many frames a video of this length is worth sending, in whole 16-frame batches.
 * Under an hour keeps the old "all available up to 160" behavior. Longer videos get a
 * time-based budget: ~1 frame / 90 s normally, ~1 frame / 60 s on a deep second pass.
 * 153-min compilation → 112 frames (7 batches) normal, 160 (10 batches) deep.
 */
export function visionFrameBudget(durationSec, { deep = false } = {}) {
  const d = Math.max(0, Math.floor(num(durationSec, 0)));
  if (d < 60 * 60) return VISION_BATCH_SIZE * VISION_BATCH_MAX;
  const per = deep ? 60 : 90;
  const raw = Math.ceil(d / per);
  const batches = Math.min(VISION_BATCH_MAX, Math.max(2, Math.ceil(raw / VISION_BATCH_SIZE)));
  return batches * VISION_BATCH_SIZE;
}

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

/** Keep start/end coverage when there are too many chapters: thin evenly, never slice the tail. */
export function thinChapters(chapters, max) {
  const list = Array.isArray(chapters) ? chapters : [];
  const cap = Math.max(1, Math.floor(num(max, 16)));
  if (list.length <= cap) return list;
  return evenIndices(list.length, cap).map((i) => list[i]);
}

/**
 * Deterministic whole-film overview when no synthesis call is available: one slice each
 * from the opening, the middle and the ending — never a 10-batch comma chain.
 */
export function composeLongOverview(batchBits, batchCount) {
  const bits = (Array.isArray(batchBits) ? batchBits : []).map((s) => str(s).trim()).filter(Boolean);
  const n = Math.max(1, Math.floor(num(batchCount, bits.length || 1)));
  if (!bits.length) return '';
  if (bits.length <= 3) return clip(`本片共 ${n} 段：${bits.join('；')}`, 420);
  const clean = (s) => clip(str(s)
    .replace(/^(这一批|本批|这批)[，,：:]?\s*/, '')
    .replace(/^(开场|开头|开篇|片头)(是|从)?[，,：:]?\s*/, '')
    .replace(/^(收尾|结尾|最后|最终)(是|从|落在)?[，,：:]?\s*/, '')
    .trim(), 60);
  const first = clean(bits[0]);
  const mid = clean(bits[Math.floor((bits.length - 1) / 2)]);
  const last = clean(bits[bits.length - 1]);
  return `本片共 ${n} 段：开场${first}；中段${mid}；收尾${last}。`;
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
      ...(str(hit.path || hit.filePath) ? { path: str(hit.path || hit.filePath) } : {}),
    });
  }
  // Fallback: if density mapping yielded nothing, take evenly from pool order
  const candidates = mapped.length
    ? mapped
    : pool.map((f, i) => ({
      tSec: frameTimeSec(f, i),
      url: frameUrl(f),
      label: str(f.label) || formatClock(frameTimeSec(f, i)),
      ...(str(f.path || f.filePath) ? { path: str(f.path || f.filePath) } : {}),
    }));

  const idxs = evenIndices(candidates.length, maxFrames);
  return {
    frames: idxs.map((i) => candidates[i]),
    source,
  };
}

export function buildVisionPrompt({ title = '', desc = '', transcript = '', frames = [], worthScore = 0, persona = '', transcriptChars = 800, segment = null, genre = null, durationSec = 0 } = {}) {
  const voice = str(persona).trim();
  const seg = segment && num(segment.total, 1) > 1 ? segment : null;
  const g = genre && genre.opinion ? genre : classifyVideoGenre({ title, desc });
  const long = num(durationSec) >= 60 * 60;
  const lines = [];
  if (seg) {
    const idx = Math.max(1, Math.floor(num(seg.index, 1)));
    const total = Math.floor(num(seg.total, 1));
    lines.push(`这是同一支视频的分段看图：第 ${idx}/${total} 批画面（按时间顺序切批，本批只覆盖视频的一段）。`);
    lines.push(idx < total
      ? '本批只输出「总览」（本批画面讲了什么，一句话）和「时间线」（本批时间段内的章节，2–5 段）；不要写观感——全片评价在最后一批统一给。'
      : '这是最后一批：请结合【前情】里之前各批的结论，输出覆盖全片的「总览」、补全本批时间段的「时间线」，并给出全片「观感」。');
    lines.push('其余要求与单批看片相同：以画面为准，字幕仅在相符时参考，不编造画面外情节；时间线客观准确。');
  } else {
    lines.push('请以当前人设的身份看这支视频：根据【标题】【简介】【可选字幕】以及按时间顺序给出的画面帧，写出能让读者完整了解本片内容的中文总结。');
    lines.push('要求：以画面为准；字幕仅在与标题相符时参考；不要编造与画面无关的情节。总览与时间线保持客观准确，性格只体现在「观感」里。');
  }
  lines.push('输出格式（严格）：');
  lines.push('总览：<一句话，' + (seg ? '本批画面' : '这片子整体') + '讲了什么>');
  lines.push(`时间线（按【类型：${g.label}】切章）：`);
  lines.push('· mm:ss–mm:ss <章标题>：<要点>');
  lines.push('· …（' + (seg ? '2–5 段，只写本批时间段' : long ? '8–16 段，长片/合集按季或单元分段' : '3–6 段') + '）');
  lines.push(`切章侧重：${g.timeline}`);
  if (!seg || num(seg.index, 1) >= num(seg.total, 1)) {
    lines.push(voice
      ? opinionInstruction(g, { voice, maxChars: VISION_OPINION_MAX_CHARS })
      : `观感：<不超过 ${VISION_OPINION_MAX_CHARS} 字，3–6 句。必须覆盖全片（开头、中段、结尾），不能只评其中一段。按【类型：${g.label}】的侧重点写：${g.opinion} 用自然口语写，不要中性分析报告；不要复述时间线，不要编造画面外内容。>`);
    if (voice) lines.push(`【你的性格（只影响观感措辞）】${clip(voice, 300)}`);
  }
  lines.push('');
  lines.push(`标题：${clip(title, 120)}`);
  lines.push(`类型：${g.label}`);
  lines.push(`简介：${clip(desc, 400) || '（无）'}`);
  lines.push(`评分参考：${num(worthScore, 0)}/20`);
  const tx = str(transcript).trim();
  if (tx) lines.push(`字幕摘录：${clip(tx, Math.max(800, Math.floor(num(transcriptChars, 800))))}`);
  if (seg) {
    const prev = str(seg.prevNotes).trim();
    if (prev) {
      lines.push('【前情（你之前看完各批后写下的结论，按批排列）】');
      lines.push(clip(prev, 2600));
    }
    if (num(seg.anchorTSec, -1) >= 0 && num(seg.index, 1) > 1) {
      lines.push(`（本批第一张图是上一批的最后一帧 ${formatClock(seg.anchorTSec)}，仅作衔接锚点，时间线不要重复计入它。）`);
    }
  }
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

  // 观感取到下一个字段头或空行为止，允许 2–3 句跨行；兼容旧格式单行。
  const opinionM = text.match(/观感\s*[:：]\s*([\s\S]+?)(?=\n\s*\n|\n\s*(?:总览|时间线|标题|简介|字幕摘录|画面帧)\s*[:：]|$)/);
  if (opinionM) opinion = opinionM[1].split('\n').map((l) => l.replace(/^[\s·\-•*]+/, '').trim()).filter(Boolean).join(' ');

  const body = text.includes('时间线') ? text.split(/时间线\s*[:：]?\s*/)[1] || '' : text;
  const chapterPart = opinionM ? body.slice(0, body.indexOf(opinionM[0])) : body;
  for (const line of chapterPart.split('\n')) {
    const t = line.replace(/^[\s·\-•*]+/, '').trim();
    if (!t) continue;
    if (/^(总览|观感|标题|简介)/.test(t)) continue;
    // Our type-aware prompt emits a「（按【类型：…】切章）：」header; it is not a chapter.
    if (t.includes('按【类型') || /切章[)）]?[:：]?$/.test(t)) continue;
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
  const op = clip(str(opinion).replace(/^观感\s*[:：]\s*/, '').trim() || fallbackOpinion, VISION_OPINION_MAX_CHARS);
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

/** 无画面模型时的纯文本推断 prompt:字幕/热评/弹幕高峰做时间锚点,明示未看画面。 */
export function buildTextFallbackPrompt(digest = {}, { persona = '', genre = null } = {}) {
  const comments = (Array.isArray(digest.hotComments) ? digest.hotComments : [])
    .slice(0, 5).map((c) => str(c?.text ?? c)).filter(Boolean).join(' / ');
  const peaks = (Array.isArray(digest.peaks) ? digest.peaks : [])
    .slice(0, 8).map((p) => `${formatClock(p?.tSec ?? p?.sec ?? p?.t ?? 0)}(${p?.count ?? p?.text ?? ''})`).join(' / ');
  const voice = str(persona).trim();
  const g = genre && genre.opinion ? genre : classifyVideoGenre(digest);
  const long = num(digest.durationSec) >= 60 * 60;
  const lines = [
    '请以当前人设的身份看这支视频。当前没有可用的画面模型,请仅根据下列文本信息推断本片内容与章节时间线。',
    '要求:以"按文案/弹幕推断,未看画面"为前提;时间线用字幕/弹幕高峰的时间锚点,不得编造具体画面细节。总览与时间线客观准确,性格只体现在「观感」里。',
    '输出格式(严格):',
    '总览:<一句话,这片子整体讲了什么>',
    `时间线(按【类型:${g.label}】切章):`,
    '· mm:ss–mm:ss <章标题>:<要点>',
    `· …(${long ? '8–16 段' : '3–6 段'})`,
    `切章侧重:${g.timeline}`,
    voice
      ? opinionInstruction(g, { voice, maxChars: VISION_OPINION_MAX_CHARS })
      : `观感:<不超过 ${VISION_OPINION_MAX_CHARS} 字,3–6 句。必须覆盖全片(开头、中段、结尾),不能只评其中一段。按【类型:${g.label}】的侧重点写:${g.opinion} 用自然口语写,不要复述时间线,不要编造画面外内容。>`,
  ];
  if (voice) lines.push(`【你的性格（只影响观感措辞）】${clip(voice, 300)}`);
  lines.push('');
  lines.push(`标题:${clip(digest.title, 120)}`);
  lines.push(`类型:${g.label}`);
  lines.push(`简介:${clip(digest.desc, 400) || '(无)'}`);
  lines.push(`字幕摘录:${clip(digest.transcript, 800) || '(无)'}`);
  lines.push(`热评:${clip(comments, 400) || '(无)'}`);
  lines.push(`弹幕高峰:${peaks || '(无)'}`);
  return lines.join('\n');
}

/** 相邻批共享的衔接锚点帧：同 url 同时间戳才算同一帧。 */
function sameVisionFrame(a, b) {
  return !!a && !!b && frameUrl(a) === frameUrl(b) && frameTimeSec(a, -1) === frameTimeSec(b, -2);
}

/**
 * Full pipeline. visionSummarize required for success.
 * 超过单批上限的帧按时间切批多轮送模：上一批的结论 + 末帧锚点带进下一批，
 * 最后一批出全片总览与观感；各批时间线合并为完整时间线。
 * @returns {{ ok, channel, takeaway, frames?, error?, batches?, partial? }}
 */
export async function composeVisionTimelineSummary({
  digest = {},
  everySec = LIVE_FRAME_DEFAULT_EVERY_SEC,
  visionSummarize,
  model = '',
  maxFrames = VISION_FRAME_MAX,
  persona = '',
  deepWatch = false,
} = {}) {
  if (typeof visionSummarize !== 'function') {
    return { ok: false, channel: 'skip:no-vision-model', takeaway: '', error: 'no-vision-callback' };
  }
  // 单批上限（宿主单条消息图片上限 20，再多会被整批拒收）；深看二刷 20，常规 16。
  maxFrames = Math.min(20, Math.max(4, Math.floor(num(maxFrames, VISION_FRAME_MAX))));

  const live = digest.liveFrameStills
    || digest.liveFrames?.frames
    || [];
  const board = digest.storyboardFrames || [];
  // 采样密度只决定抽帧/时间点候选；这里取全片候选（≤240），超过单批上限就分批喂。
  // 深看（含二刷）字幕摘录放宽到 2400 字。
  const deep = deepWatch === true || maxFrames > VISION_FRAME_MAX;
  const totalCap = Math.min(
    240,
    VISION_BATCH_SIZE * VISION_BATCH_MAX,
    visionFrameBudget(digest.durationSec, { deep }),
  );
  const picked = pickVisionFrames({
    liveFrames: live,
    storyboardFrames: board,
    durationSec: digest.durationSec,
    everySec: 1,
    maxFrames: totalCap,
  });
  const transcriptChars = deep ? 2400 : 800;
  const modelArg = str(model).trim() || undefined;
  const genre = classifyVideoGenre(digest);
  const basePrompt = {
    title: digest.title,
    desc: digest.desc,
    transcript: digest.transcript || digest.subtitle?.text || '',
    worthScore: digest.worthScore,
    persona,
    transcriptChars,
    durationSec: digest.durationSec,
    genre,
  };
  const toImages = (frames) => frames.map((f) => ({
    tSec: f.tSec,
    url: f.url,
    label: f.label,
    ...(f.path ? { path: f.path } : {}),
  }));
  const callOnce = async (frames, segment) => visionSummarize({
    model: modelArg,
    prompt: buildVisionPrompt({ ...basePrompt, frames, ...(segment ? { segment } : {}) }),
    images: toImages(frames),
  });

  // 单批路径：帧数不超过单批上限，行为与旧版一致。
  if (picked.frames.length <= maxFrames) {
    try {
      const out = await callOnce(picked.frames, null);
      const raw = str(out?.text ?? out?.content ?? out).trim();
      const textOnly = !picked.frames.length || out?.textOnly === true;
      if (!raw) {
        return {
          ok: false,
          channel: textOnly ? 'skip:no-frames' : 'skip:vision-error',
          takeaway: '',
          error: textOnly ? 'no-frames' : 'empty-response',
          frames: picked.frames,
        };
      }
      // Model saw only timestamp list (images never attached) — treat as soft failure.
      if (visionResponseLooksBlind(raw)) {
        return {
          ok: false,
          channel: 'skip:vision-error',
          takeaway: '',
          error: 'blind-no-pixels',
          frames: picked.frames,
          raw,
        };
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
        channel: textOnly ? 'ok:text-only' : (picked.source === 'live' ? 'ok:live' : 'ok:storyboard'),
        takeaway,
        frames: picked.frames,
        raw,
        ...(textOnly ? { textOnly: true } : {}),
      };
    } catch (err) {
      return visionTextFallback({ digest, persona, modelArg, visionSummarize, picked, err });
    }
  }

  // 分批路径：按时间切 ≤VISION_BATCH_SIZE 帧一批（批数封顶 VISION_BATCH_MAX，
  // 超出时全片均匀降采样）。批 k(k>1) 开头重复上一批末帧作衔接锚点。
  const batchSize = Math.min(VISION_BATCH_SIZE, Math.max(4, maxFrames));
  const batches = [];
  for (let i = 0; i < picked.frames.length; i += batchSize) {
    batches.push(picked.frames.slice(i, i + batchSize));
  }
  const notes = [];
  const chapters = [];
  const raws = [];
  let finalParsed = null;
  let failedBatches = 0;
  for (let bi = 0; bi < batches.length; bi += 1) {
    const anchor = bi > 0 ? batches[bi - 1][batches[bi - 1].length - 1] : null;
    const frames = anchor && !sameVisionFrame(anchor, batches[bi][0]) ? [anchor, ...batches[bi]] : batches[bi];
    try {
      const out = await callOnce(frames, {
        index: bi + 1,
        total: batches.length,
        prevNotes: notes.join('\n'),
        anchorTSec: anchor ? anchor.tSec : -1,
      });
      const raw = str(out?.text ?? out?.content ?? out).trim();
      if (!raw || visionResponseLooksBlind(raw)) { failedBatches += 1; continue; }
      raws.push(raw);
      const parsed = parseVisionTimelineText(raw);
      for (const c of parsed?.chapters || []) {
        if (c.start || c.text) chapters.push(c);
      }
      notes.push(`第${bi + 1}批（${formatClock(frames[0].tSec)}–${formatClock(frames[frames.length - 1].tSec)}）：${clip(parsed?.overview || raw.split('\n')[0], 160)}`);
      finalParsed = parsed;
    } catch {
      failedBatches += 1;
    }
  }
  if (!raws.length) {
    return visionTextFallback({ digest, persona, modelArg, visionSummarize, picked, err: new Error('all-batches-failed') });
  }
  // Whole-film overview. Each batch overview describes only its slice; a long film's
  // "讲了什么" must not be the last slice or a comma-chain of all of them. One cheap
  // text-only call synthesizes a 1–2 sentence overview across the whole run.
  let synthesizedOverview = '';
  if (batches.length > 1 && num(digest.durationSec) >= 60 * 60 && typeof visionSummarize === 'function') {
    try {
      const noteLines = notes
        .map((n) => n.replace(/^第\d+批（[^）]*）：/, ''))
        .join('\n');
      const out = await visionSummarize({
        model: modelArg,
        prompt: [
          `你看完了一支 ${formatClock(digest.durationSec)} 的视频，下面是你每批画面的简短结论。`,
          '请用 1–2 句中文写「全片总览」：覆盖开头、中段、结尾；不要分点，不要逐批复述，不超过 120 字。',
          '只输出总览正文，不要解释。',
          noteLines,
        ].join('\n'),
        images: [],
      });
      const t = str(out?.text ?? out?.content ?? out).trim();
      if (t && !visionResponseLooksBlind(t)) {
        synthesizedOverview = clip(t.split('\n').find((l) => l.trim()) || t, 180);
      }
    } catch { /* fall back to the batch chain below */ }
  }
  // Each batch's 总览 only describes its own slice. Using the last one as the whole-film
  // overview made a 153-min film read as "本批在夜间尸潮…". Synthesize from every batch,
  // capped so the line stays readable.
  const batchBits = notes
    .map((n) => clip(n.replace(/^第\d+批（[^）]*）：/, ''), 55))
    .filter(Boolean);
  const overview = synthesizedOverview || (batchBits.length
    ? composeLongOverview(batchBits, batches.length)
    : (finalParsed?.overview || ''));
  // 16 used to be a hard slice, which cut the last batches off a long compilation.
  const chapterCap = Math.min(24, Math.max(16, batches.length * 3));
  const takeaway = formatVisionTakeaway({
    overview,
    chapters: thinChapters(chapters, chapterCap),
    opinion: finalParsed?.opinion,
    worthScore: digest.worthScore,
  });
  return {
    ok: true,
    channel: picked.source === 'live' ? 'ok:live' : 'ok:storyboard',
    takeaway,
    frames: picked.frames,
    raw: raws.join('\n\n'),
    batches: { total: batches.length, ok: raws.length, failed: failedBatches, frames: picked.frames.length },
    ...(failedBatches ? { partial: true } : {}),
  };
}

/** 画面模型不可用/拒收图片时的纯文本推断兜底（原 catch 分支，单批与分批共用）。 */
async function visionTextFallback({ digest, persona, modelArg, visionSummarize, picked, err }) {
  if (picked.frames.length && typeof visionSummarize === 'function') {
    try {
      const out2 = await visionSummarize({
        model: modelArg,
        prompt: buildTextFallbackPrompt(digest, { persona, genre: classifyVideoGenre(digest) }),
        images: [],
      });
      const raw2 = str(out2?.text ?? out2?.content ?? out2).trim();
      if (raw2) {
        const parsed2 = parseVisionTimelineText(raw2);
        return {
          ok: true,
          channel: 'ok:text-only',
          takeaway: formatVisionTakeaway({
            overview: parsed2?.overview,
            chapters: parsed2?.chapters,
            opinion: parsed2?.opinion,
            worthScore: digest.worthScore,
          }),
          frames: picked.frames,
          raw: raw2,
          textOnly: true,
          fallback: 'text-infer',
        };
      }
    } catch { /* fall through to the original failure */ }
  }
  const textOnly = !picked.frames.length;
  return {
    ok: false,
    channel: textOnly ? 'skip:no-frames' : 'skip:vision-error',
    takeaway: '',
    error: textOnly ? 'no-frames' : (err instanceof Error ? err.message : String(err)),
    frames: picked.frames,
  };
}

/** True when the model admits it never saw frame pixels (only timestamps / labels). */
export function visionResponseLooksBlind(raw = '') {
  const t = str(raw);
  if (!t) return false;
  const noPixels = /没有画面|无画面|看不到画面|未看到画面|无可读画面|画面内容缺失|画面证据缺失|只给了时间戳|仅有时间戳|只有时间戳|没有画面描述|无可读图像|不可分析样本/;
  const onlyClock = /采样点|时间戳|占位帧/;
  return noPixels.test(t) && (onlyClock.test(t) || /00:\d{2}/.test(t));
}

/** Map vision channel code → short Chinese note for the takeaway opinion line. */
export function visionSkipNote(channel = '', error = '') {
  const c = str(channel);
  if (c === 'skip:no-vision-model') return '未接通聊天多模态模型，未生成时间线';
  if (c === 'skip:no-frames') return '无可用画面帧，未生成时间线';
  if (c === 'skip:disabled') return '画面总结已关闭';
  if (c === 'skip:vision-error') {
    const e = str(error).trim();
    if (e === 'blind-no-pixels') return '画面未送进模型，未生成时间线';
    return e ? `画面理解失败：${e.slice(0, 40)}` : '画面理解失败，未生成时间线';
  }
  return '未看画面';
}

/** Soft fallback takeaway with optional note in opinion. */
export function fallbackTakeawayWithVisionNote(digest, { note = '', channel = '', error = '' } = {}) {
  const tag = str(note).trim() || visionSkipNote(channel, error);
  let t = composeVideoTakeaway({
    title: digest?.title,
    desc: digest?.desc,
    transcript: digest?.transcript || '',
    tags: digest?.tags,
    worthScore: digest?.worthScore,
  });
  if (tag && !t.includes(tag)) {
    t = t.replace(/观感：/, `观感：（${tag}）`);
  }
  return t;
}

/** Parse `/dsh-soulmate/api/live-frame?bvid=BVxxx&i=0` → disk path under soulmateRoot. */
export function resolveLiveFrameDiskPath(url, soulmateRoot = '') {
  const root = str(soulmateRoot).trim();
  const u = str(url).trim();
  if (!root || !u || !u.includes('live-frame')) return '';
  let params;
  try {
    if (/^https?:\/\//i.test(u)) params = new URL(u).searchParams;
    else if (u.startsWith('/')) params = new URL(u, 'http://local.invalid').searchParams;
    else return '';
  } catch {
    return '';
  }
  const bvid = str(params.get('bvid')).trim();
  if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) return '';
  const i = Math.max(0, Math.floor(Number(params.get('i')) || 0));
  if (i > 240) return '';
  const name = `frame_${String(i + 1).padStart(3, '0')}.jpg`;
  const sep = root.includes('\\') ? '\\' : '/';
  const base = root.endsWith('/') || root.endsWith('\\') ? root.slice(0, -1) : root;
  return `${base}${sep}cache${sep}live-frames${sep}${bvid}${sep}${name}`;
}

async function readLocalImageDataUrl(filePath, readFileImpl) {
  const p = str(filePath).trim();
  if (!p) return '';
  try {
    let buf;
    if (typeof readFileImpl === 'function') {
      buf = await readFileImpl(p);
    } else {
      const { readFile } = await import('node:fs/promises');
      buf = await readFile(p);
    }
    if (!buf || !buf.length) return '';
    const b64 = Buffer.isBuffer(buf) ? buf.toString('base64') : Buffer.from(buf).toString('base64');
    const lower = p.toLowerCase();
    const ct = lower.endsWith('.png') ? 'image/png' : lower.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
    return `data:${ct};base64,${b64}`;
  } catch {
    return '';
  }
}

/**
 * Fetch remote/local frame URLs into data: URLs so vision providers that cannot
 * pull Bilibili CDN themselves still get pixels.
 * Prefer on-disk live-frame `path` / soulmateRoot resolution — relative
 * `/dsh-soulmate/api/live-frame` URLs are not fetchable from the node process.
 */
export async function materializeVisionImages(images = [], {
  fetchImpl,
  timeoutMs = 20_000,
  readFileImpl,
  soulmateRoot = '',
  referer,
} = {}) {
  const fetchFn = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch;
  // The bili CDN needs its referer; other hosts (QQ multimedia) REJECT a foreign
  // referer with HTTP 400 — callers pass referer:'' for non-bili sources.
  const ref = referer === undefined ? 'https://www.bilibili.com' : str(referer);
  const out = [];
  for (const img of Array.isArray(images) ? images : []) {
    const url = str(img?.url).trim();
    const localPath = str(img?.path || img?.filePath).trim()
      || resolveLiveFrameDiskPath(url, soulmateRoot);
    if (!url && !localPath) continue;
    if (url.startsWith('data:')) {
      out.push({ ...img, url });
      continue;
    }
    if (localPath) {
      const dataUrl = await readLocalImageDataUrl(localPath, readFileImpl);
      if (dataUrl) {
        out.push({ ...img, url: dataUrl, path: localPath });
        continue;
      }
    }
    // Relative app routes cannot be fetched from node — skip rather than pass blind URLs.
    if (url.startsWith('/') && !url.startsWith('//')) continue;
    if (typeof fetchFn !== 'function') continue;
    try {
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
      const res = await fetchFn(url, {
        headers: { ...(ref ? { referer: ref } : {}), accept: 'image/*' },
        signal: controller?.signal,
      });
      if (timer) clearTimeout(timer);
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length) continue;
      const ct = str(res.headers?.get?.('content-type') || 'image/jpeg').split(';')[0] || 'image/jpeg';
      out.push({ ...img, url: `data:${ct};base64,${buf.toString('base64')}` });
    } catch {
      /* skip unreadable frame */
    }
  }
  return out;
}
