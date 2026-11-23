// Learn / refresh Bilibili surf interest keywords from recent chat + memory.
import { loadConfig, saveConfigAuto } from '../soulmate-core/state.mjs';
import { listSessionEpisodes } from '../soulmate-core/memory-engine.mjs';
import { listImChat } from '../soulmate-core/im-chat.mjs';
import { measureFromRecords, normalizeChatHome } from '../soulmate-core/chat-home.mjs';
import { sessionIdsToWatch } from '../soulmate-core/session-star.mjs';
import { resolveLlmModel } from '../soulmate-core/llm-model-pick.mjs';

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));

const STOP = new Set([
  '这个', '那个', '什么', '怎么', '为什么', '可以', '一个', '我们', '你们', '他们',
  '今天', '明天', '昨天', '现在', '时候', '东西', '视频', '看看', '一下', '还有',
  '不是', '就是', '然后', '因为', '所以', '如果', '已经', '没有', '真的', '好的',
  '哈哈', '嘿嘿', '谢谢', '你好', '在干嘛', '干嘛', '怎么样', '自己', '对方',
  'the', 'and', 'for', 'with', 'you', 'are', 'this', 'that', 'from', 'have',
  // 内部字段/系统词:曾被误学进关键词,永久屏蔽
  'identity', 'following', 'system-reminder', 'system', 'reminder', 'video', 'bvid',
  'worthscore', 'https', 'http', 'www', 'bilibili', 'skill', 'tool', 'json', 'dsh',
  'soulmate', 'session', 'token', 'api', 'prompt', 'assistant', 'user', 'model',
  'soulmate-wake', 'wake', 'current', 'describes', 'information', 'of', 'your',
  'null', 'true', 'false', 'undefined', 'todo', 'task', 'context', 'message',
]);

/** 明显是内部字段/URL 片段的 token 直接丢弃。 */
const JUNK = /(system-reminder|worthscore|bvid|^https?:?$|www\.|\.com\b|\.cn\b|\/)/i;

const INTEREST_CUE = /想看|想了解|感兴趣|最近在看|推荐(?:个|几个|一下)?|搜一下|关于|讲讲|聊聊|关注|学习|入门|教程|新闻|科技|编程|AI|装机|硬件|数码/;

export function normalizeKeywordList(list, max = 8) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const k = str(raw).replace(/\s+/g, ' ').trim();
    if (!k || k.length > 24) continue;
    const key = k.toLowerCase();
    if (seen.has(key) || STOP.has(k) || STOP.has(key) || JUNK.test(k)) continue;
    seen.add(key);
    out.push(k);
    if (out.length >= max) break;
  }
  return out;
}

/** 自动学习只追加、不覆盖:已有学习词在前,新候选去重追加,最多 max 个。 */
export function appendLearnedKeywords(existing, candidates, max = 20) {
  return normalizeKeywordList([...(Array.isArray(existing) ? existing : []), ...(Array.isArray(candidates) ? candidates : [])], max);
}

/** 冲浪实际使用的手动 + 学习并集:手填的永远在,学习词追加去重;两侧都过垃圾词闸,防止旧配置里的污染词继续搜出去。 */
export function mergeSurfKeywords(manual, learned) {
  const out = [];
  const seen = new Set();
  for (const raw of [...(Array.isArray(manual) ? manual : []), ...(Array.isArray(learned) ? learned : [])]) {
    const k = str(raw).replace(/\s+/g, ' ').trim();
    if (!k || k.length > 24) continue;
    const key = k.toLowerCase();
    if (seen.has(key) || STOP.has(k) || STOP.has(key) || JUNK.test(k)) continue;
    seen.add(key);
    out.push(k);
  }
  return out;
}

/** Pull searchable topic-ish tokens from free text. */
export function extractKeywordsFromText(text) {
  const t = str(text).replace(/\s+/g, ' ').trim();
  if (!t) return [];
  const found = [];
  for (const m of t.match(/[A-Za-z][A-Za-z0-9+\-/#.]{1,20}/g) || []) {
    if (!STOP.has(m.toLowerCase())) found.push(m);
  }
  for (const m of t.match(/[\u4e00-\u9fff]{2,8}/g) || []) {
    if (!STOP.has(m)) found.push(m);
  }
  return normalizeKeywordList(found, 12);
}

/**
 * Score and pick next keyword set.
 * seed = user-pinned baseline; current = last working set; signals from chat/memory.
 */
export function proposeSurfKeywords({
  current = [],
  seed = [],
  chatTexts = [],
  imTexts = [],
  factSnippets = [],
  max = 6,
} = {}) {
  const scores = new Map();
  const bump = (raw, weight) => {
    for (const k of normalizeKeywordList([raw], 1)) {
      scores.set(k, (scores.get(k) || 0) + weight);
    }
  };

  for (const k of normalizeKeywordList(seed, 12)) bump(k, 6);
  for (const k of normalizeKeywordList(current, 12)) bump(k, 2.5);

  // All conversational sources: DSH 专属窗 / 普通会话 / 全平台 IM
  const chats = [
    ...(Array.isArray(chatTexts) ? chatTexts : []),
    ...(Array.isArray(imTexts) ? imTexts : []),
  ];
  for (const text of chats) {
    const t = str(text);
    if (!t.trim()) continue;
    const w = INTEREST_CUE.test(t) ? 5 : 1.2;
    for (const k of extractKeywordsFromText(t)) bump(k, w);
    // Whole short phrases after cues:「想看量子计算」
    const m = t.match(/(?:想看|推荐|搜一下|关于)\s*([A-Za-z0-9\u4e00-\u9fff+\- ]{2,16})/);
    if (m) bump(m[1].trim(), 7);
  }

  for (const snip of Array.isArray(factSnippets) ? factSnippets : []) {
    for (const k of extractKeywordsFromText(snip)) bump(k, 2);
  }

  const ranked = [...scores.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh'))
    .map(([k]) => k);

  const next = normalizeKeywordList(ranked, max);
  if (next.length) return next;
  return normalizeKeywordList(current.length ? current : seed, max);
}

function parseKeywordReply(raw) {
  const text = str(raw?.text ?? raw?.content ?? raw).trim();
  if (!text) return [];
  try {
    const jsonMatch = text.match(/\[[\s\S]*?\]/);
    if (jsonMatch) {
      const arr = JSON.parse(jsonMatch[0]);
      if (Array.isArray(arr)) return normalizeKeywordList(arr, 8);
    }
  } catch { /* fall through */ }
  return normalizeKeywordList(text.split(/[,，、\n|/]+/), 8);
}

function sameList(a, b) {
  const x = normalizeKeywordList(a, 12);
  const y = normalizeKeywordList(b, 12);
  if (x.length !== y.length) return false;
  return x.every((k, i) => k.toLowerCase() === y[i].toLowerCase());
}

/** Pull user lines from session-star episode bodies (`- 你：…`). */
function userLinesFromEpisodeBody(body) {
  const out = [];
  for (const line of str(body).split(/\n+/)) {
    const m = line.match(/^[-\s]*(?:你|搭档|用户|User)\s*[：:]\s*(.+)$/i);
    if (m && m[1].trim()) out.push(m[1].trim());
  }
  if (!out.length && str(body).trim()) out.push(str(body).slice(0, 240));
  return out;
}

async function collectDshSessionUserTexts(home, conf, controller) {
  const texts = [];
  if (!controller || typeof controller.events !== 'function') return texts;
  const chatHome = normalizeChatHome(conf.chatHome);
  const ids = sessionIdsToWatch(chatHome).slice(0, 6);
  for (const sessionId of ids) {
    try {
      const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
        ? AbortSignal.timeout(12_000)
        : new AbortController().signal;
      const page = await controller.events({
        address: { kind: 'session', sessionId },
        maxMessages: 60,
      }, signal);
      const measure = measureFromRecords(page);
      for (const s of measure.snippets || []) {
        if (s.role === 'user' && str(s.text).trim()) texts.push(str(s.text).trim());
      }
    } catch {
      // session gone / host busy — skip
    }
  }
  return texts;
}

/**
 * Refresh config.extensions.biliKeywords from ALL recent chats + facts (optional LLM polish).
 * Sources: 全平台 IM、DSH 专属/已知会话、窗星星图 episode、记忆 facts。
 */
export async function refreshSurfKeywords(home, options = {}) {
  const conf = await loadConfig(home);
  const ext = conf.extensions ?? {};
  if (ext.biliKeywordsAuto === false) {
    return { ok: true, skipped: true, reason: 'disabled', keywords: mergeSurfKeywords(ext.biliKeywords, ext.biliLearnedKeywords) };
  }

  const chatTexts = [];

  // 1) All IM platforms (not only WeChat)
  const imRows = await listImChat(home, { platform: '', limit: 80 }).catch(() => []);
  for (const r of Array.isArray(imRows) ? imRows : []) {
    if (r && r.role === 'user' && str(r.text).trim()) chatTexts.push(str(r.text).trim());
  }

  // 2) DSH chat windows (专属窗 + known sessions)
  const controller = typeof options.sessionController === 'function'
    ? options.sessionController()
    : options.sessionController;
  const homeTexts = await collectDshSessionUserTexts(home, conf, controller).catch(() => []);
  chatTexts.push(...homeTexts);

  // 3) Session-star episode excerpts (covers windows we already distilled)
  try {
    const episodes = await listSessionEpisodes(home, { includePrivate: false });
    const recent = (Array.isArray(episodes) ? episodes : [])
      .slice()
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
      .slice(0, 8);
    for (const ep of recent) {
      chatTexts.push(...userLinesFromEpisodeBody(ep.body));
      if (str(ep.title).trim()) chatTexts.push(str(ep.title).trim());
    }
  } catch {
    // optional
  }

  // 只在真的有聊天内容时学习:没聊天 = 不总结、不写任何东西
  const chatSample = chatTexts.filter(Boolean).slice(0, 60);
  if (!chatSample.length) {
    return { ok: true, ran: false, reason: 'no-chat', keywords: mergeSurfKeywords(ext.biliKeywords, ext.biliLearnedKeywords) };
  }

  const manual = Array.isArray(ext.biliKeywords) ? ext.biliKeywords : [];
  const learnedPrev = Array.isArray(ext.biliLearnedKeywords) ? ext.biliLearnedKeywords : [];
  let candidates = proposeSurfKeywords({
    current: learnedPrev,
    seed: manual,
    chatTexts: chatSample,
    factSnippets: [],
    max: Math.min(8, Math.max(3, Math.floor(Number(options.max) || 6))),
  });

  if (typeof options.oneShotLlm === 'function' && typeof options.listHostModels === 'function') {
    try {
      const models = await options.listHostModels();
      const picked = resolveLlmModel({ models, preferredId: str(options.modelId) });
      if (picked?.id) {
        const prompt = [
          '根据搭档在 DSH 对话窗与各 IM 平台的近聊，提炼 3～6 个适合 B 站搜索的兴趣关键词。',
          '要求：短词/短语，适合搜索；不要句子；不要解释；只输出 JSON 字符串数组；不要改写手填词。',
          `手填关键词（保持不动）：${JSON.stringify(manual)}`,
          `已学习关键词：${JSON.stringify(learnedPrev)}`,
          `近聊摘录：\n${chatSample.slice(0, 16).map((t) => `- ${t.slice(0, 80)}`).join('\n')}`,
        ].join('\n');
        const out = await options.oneShotLlm({ prompt, modelId: picked.id, kind: 'surf-keywords' });
        const parsed = parseKeywordReply(out);
        if (parsed.length >= 2) candidates = parsed;
      }
    } catch {
      // heuristic result stands
    }
  }

  // 追加式:手填词永不改写;学习词去重后追加,总量封顶 20
  const learnedNext = appendLearnedKeywords(learnedPrev, candidates, 20);
  const merged = mergeSurfKeywords(manual, learnedNext);
  if (!learnedNext.length) {
    return { ok: true, changed: false, reason: 'empty', keywords: merged };
  }
  if (sameList(learnedNext, learnedPrev)) {
    return { ok: true, changed: false, keywords: merged };
  }

  const at = new Date(options.nowMs ?? Date.now()).toISOString();
  await saveConfigAuto(home, {
    extensions: {
      biliLearnedKeywords: learnedNext,
      biliKeywordsUpdatedAt: at,
    },
  });
  return { ok: true, changed: true, keywords: merged, learned: learnedNext, at };
}
