// The engage brain: comments and thread replies authored in character from her own
// watch notes, instead of the three canned template lines. Pure prompt/parse helpers
// plus one factory that wraps a metered one-shot call; every failure falls back to the
// heuristic plan, so a dead model can never mute her or make her post garbage.

import { sanitizeCommentText } from './engage.mjs';

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const clip = (s, n) => {
  const t = str(s);
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/**
 * Prompt for a fresh public comment under a video she just watched.
 * Her takeaway is the material; the persona brief is the voice; the cap is the law.
 */
export function composeEngageCommentPrompt({ digest = {}, persona = {}, voice = '', maxChars = 80 } = {}) {
  const displayName = str(persona.name).trim() || 'soulmate';
  const selfRef = str(persona.selfRef).trim() || '我';
  const takeaway = clip(str(digest.summary || digest.takeaway || digest.howIWatched), 400);
  return [
    `你是${displayName}（自称「${selfRef}」），刚看完《${clip(digest.title, 60)}》，想在评论区留一条真实的短评。`,
    voice ? `【你的性格】${voice}` : '',
    takeaway ? `【你的观后笔记】\n${takeaway}` : '',
    `要求：像真人随手留言，说具体的点（画面/结论/翻车处），不要空泛吹捧；不超过 ${maxChars} 字；中文口语。`,
    '禁止：外链、导流、辱骂、冒充官方、复读刷屏；不要提 AI/模型/系统；不要「UP主加油」这类万能句。',
    '不想评就只输出两个字：不评。只输出评论正文或「不评」，不要解释。',
  ].filter(Boolean).join('\n');
}

/** Prompt for one threaded reply: actually read what the other person said. */
export function composeThreadReplyPrompt({ threadTitle = '', theirReply = '', myComment = '', persona = {}, voice = '', maxChars = 80, round = 1, maxRounds = 2 } = {}) {
  const displayName = str(persona.name).trim() || 'soulmate';
  const selfRef = str(persona.selfRef).trim() || '我';
  return [
    `你是${displayName}（自称「${selfRef}」）。你在《${clip(threadTitle, 50)}》下评论过「${clip(myComment, 80)}」，有人回复了你。`,
    voice ? `【你的性格】${voice}` : '',
    `【对方的回复】${clip(theirReply, 200)}`,
    `认真接对方的话：同意就说为什么，不同意可以温和反驳，问句就回答。这是第 ${round}/${maxRounds} 轮，${round >= maxRounds ? '这是最后一轮，收个尾。' : '聊得下去就聊，没话可接可以不回。'}`,
    `不超过 ${maxChars} 字；中文口语；禁止外链/导流/辱骂；不要提 AI/系统。`,
    '不想回就只输出两个字：不回。只输出回复正文或「不回」，不要解释。',
  ].filter(Boolean).join('\n');
}

/** Parse an authored line. 「不评/不回」and garbage both mean "skip", never a throw. */
export function parseAuthoredText(raw, { maxChars = 80, skipWords = ['不评', '不回'] } = {}) {
  const text = str(raw).replace(/^["'「」]+|["'「」]+$/g, '').trim();
  if (!text) return { ok: false, text: '', reason: 'empty' };
  if (skipWords.some((w) => text === w || text === `${w}。`)) return { ok: false, text: '', reason: 'declined' };
  const scrub = sanitizeCommentText(text, maxChars);
  if (!scrub.ok) return { ok: false, text: '', reason: scrub.reason };
  return { ok: true, text: scrub.text };
}

/**
 * Factory: a `decideEngage` override for afterSurfWatch. Keeps the heuristic's action
 * flags (they encode her personality thresholds) and only re-authors the comment text;
 * coin may be revoked by the model's judgment but never invented by it.
 */
export function createLlmEngageDecider({ oneShotLlm, listHostModels, resolveModel, meteredCall, voiceOf, maxCharsOf }) {
  return async function decideEngage({ digest, persona, heuristic }) {
    if (!heuristic?.comment) return heuristic;
    try {
      const models = typeof listHostModels === 'function' ? await listHostModels().catch(() => []) : [];
      const picked = resolveModel({ models, preferredId: '' });
      if (!picked?.id) return heuristic;
      const maxChars = typeof maxCharsOf === 'function' ? await maxCharsOf() : 80;
      const prompt = composeEngageCommentPrompt({
        digest,
        persona,
        voice: typeof voiceOf === 'function' ? voiceOf(persona) : '',
        maxChars,
      });
      const call = () => oneShotLlm({ prompt, modelId: picked.id, kind: 'engage-llm' });
      const metered = typeof meteredCall === 'function'
        ? await meteredCall({ kind: 'engage-llm', trigger: 'auto', prompt, call })
        : { ok: true, out: await call() };
      if (!metered.ok || metered.blocked) return heuristic;
      const raw = typeof metered.out === 'string' ? metered.out : str(metered.out?.text);
      const parsed = parseAuthoredText(raw, { maxChars });
      if (!parsed.ok) {
        // She chose not to comment (or the text failed the public-comment rules).
        return { ...heuristic, comment: false, commentText: '', reason: `她自己决定不评（${parsed.reason}）` };
      }
      return { ...heuristic, commentText: parsed.text, reason: `${heuristic.reason || ''}（评论她自己写的）`.trim() };
    } catch {
      return heuristic;
    }
  };
}