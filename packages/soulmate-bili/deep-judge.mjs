// 细看裁决：初扫之后，把「要不要认真看完」交给带人设的 Agent 判断。
// 判定 deep 的片子在 DSH 里按人设做第二遍深看（更密帧 + 更长字幕 + 人设化全片评价）。
// 纯函数部分（prompt 构建 / 回执解析 / 启发式兜底）可单测；网络与深看由调用方注入。
import { formatClock } from './vision-summary.mjs';

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const num = (v, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const clip = (s, n) => {
  const t = str(s);
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/**
 * 裁决 prompt：给初扫结论 + 元数据 + 人设与兴趣，要求只回一行 JSON。
 * @param {object} digest 初扫 digest（title/desc/takeaway/worthScore/durationSec/coverage…）
 * @param {object} opts { persona: 性格小传, interests: 关键词数组, callUser }
 */
export function buildDeepJudgePrompt(digest = {}, { persona = '', interests = [], callUser = '你' } = {}) {
  const lines = [
    `请以当前人设的身份做一次「细看裁决」：你刚粗扫了下面这支 B 站视频，判断值不值得在 DSH 里认真看完第二遍（更密画面帧 + 完整字幕，按你的性格写全片评价）。`,
    '判断依据：内容深度与信息密度、与你的兴趣和你搭档关心的事的相关度、初扫是否没看够（长视频/信息量大但初扫只扫了开头）。',
    '娱乐整活/短平快的片子粗扫就够了；硬核教程、深度访谈、行业分析这类值得细看。拿不准时偏向细看。',
    '只输出一行 JSON，不要别的字：{"deep":true|false,"reason":"<一句中文理由，用你的口吻>"}',
  ];
  const voice = str(persona).trim();
  if (voice) lines.push(`【你的性格】${clip(voice, 300)}`);
  const kw = (Array.isArray(interests) ? interests : []).map((k) => str(k).trim()).filter(Boolean).slice(0, 8);
  if (kw.length) lines.push(`【你的兴趣关键词】${kw.join('、')}（搭档称呼：${str(callUser).trim() || '你'}）`);
  lines.push('');
  lines.push(`标题：${clip(digest.title, 120)}`);
  lines.push(`UP主：${clip(digest.author, 40)}｜时长：${formatClock(digest.durationSec)}｜初扫评分：${num(digest.worthScore)}/20`);
  lines.push(`简介：${clip(digest.desc, 240) || '（无）'}`);
  lines.push(`初扫结论：${clip(digest.takeaway, 500) || '（无）'}`);
  lines.push(`初扫覆盖：${clip(digest.coverage?.report || '', 160) || '（未知）'}`);
  return lines.join('\n');
}

/** 解析裁决回执：容忍前后废话 / Markdown 围栏，取第一个含 deep 字段的 JSON。 */
export function parseDeepJudgeReply(raw) {
  const text = str(raw).trim();
  if (!text) return null;
  const candidates = text.match(/\{[\s\S]*?\}/g) || [];
  for (const c of candidates) {
    try {
      const obj = JSON.parse(c);
      if (obj && typeof obj.deep === 'boolean') {
        return { deep: obj.deep, reason: clip(str(obj.reason).trim(), 120) };
      }
    } catch { /* next */ }
  }
  // 退化：明确说了「值得细看 / 不细看」也认。
  if (/(值得|需要|要)细看|认真看完/.test(text) && !/不值得|不需要|不用细看|不必/.test(text)) {
    return { deep: true, reason: clip(text.split('\n')[0], 120) };
  }
  if (/(不值得|不需要|不用|不必)细看|粗扫就够/.test(text)) {
    return { deep: false, reason: clip(text.split('\n')[0], 120) };
  }
  return null;
}

/** 无模型/模型拒答时的启发式兜底：高分 + 有信息量的长片才细看。 */
export function heuristicDeepJudge(digest = {}) {
  const score = num(digest.worthScore);
  const dur = num(digest.durationSec);
  const subChars = str(digest.transcript).length;
  if (score >= 13 && (dur >= 480 || subChars >= 1500)) {
    return { deep: true, reason: `评分 ${score}/20 的信息量长片，粗扫没看够`, via: 'heuristic' };
  }
  return { deep: false, reason: score >= 13 ? '分高但短平快，粗扫够了' : '信息量一般，不值得二刷', via: 'heuristic' };
}

/**
 * 执行裁决。generateText: async (prompt) => string（由调用方绑定 DSH 模型）。
 * 任何失败都落到启发式，绝不因裁决挂掉而丢片。
 */
export async function judgeDeepWatch(digest, { persona = '', interests = [], callUser = '你', generateText } = {}) {
  if (typeof generateText === 'function') {
    try {
      const raw = await generateText(buildDeepJudgePrompt(digest, { persona, interests, callUser }));
      const parsed = parseDeepJudgeReply(raw);
      if (parsed) return { ...parsed, via: 'agent' };
    } catch { /* fall through */ }
  }
  return heuristicDeepJudge(digest);
}