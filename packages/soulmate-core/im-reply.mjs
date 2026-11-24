// Persona-aware IM reply prompt (used when host has no generateReply).
import { getDisplayName } from './persona.mjs';

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const clip = (s, n) => {
  const t = str(s);
  return t.length <= n ? t : `${t.slice(0, n)}…`;
};

/**
 * Build a short one-shot prompt so IM replies sound like the companion, not the template.
 */
export function composeImPersonaPrompt({
  persona = {},
  state = {},
  text = '',
  memories = {},
  platform = 'weixin',
  trusted = true,
  speaker = null,
} = {}) {
  const name = getDisplayName(persona) || '伙伴';
  const me = str(persona.selfRef).trim() || '我';
  const call = str(persona.callUser).trim() || '你';
  const traits = persona.traits && typeof persona.traits === 'object' ? persona.traits : {};
  const traitLine = ['tsundere', 'clinginess', 'sassiness', 'curiosity', 'brevity']
    .map((k) => `${k}:${Number(traits[k]) || 50}`)
    .join(' ');
  const memBits = [];
  if (trusted) {
    for (const f of (memories.facts || []).slice(0, 2)) {
      if (str(f.topic).startsWith('[im:')) continue;
      memBits.push(`- ${clip(f.topic, 24)}：${clip(f.content, 80)}`);
    }
    for (const w of (memories.wiki || []).slice(0, 1)) {
      memBits.push(`- 小本本《${clip(w.title, 24)}》`);
    }
  }
  const mood = str(state.mood) || 'neutral';
  const platformLabel = platform === 'weixin' ? '微信' : platform;
  const sp = speaker && typeof speaker === 'object' ? speaker : null;
  const identityLine = sp?.isGroup
    ? sp.isOwner
      ? `场景：${platformLabel}群聊。刚说话的是主人（${sp.name || '他'}本人）。`
      : `场景：${platformLabel}群聊。刚说话的是群友「${sp.name || '陌生人'}」，不是主人。`
    : null;
  const groupRules = sp?.isGroup
    ? '群聊规则：回答简短自然，不要提任何私密记忆或只有主人知道的事，不要把对方认成主人。'
    : null;

  return [
    `你是「${name}」，自称「${me}」，称呼对方「${call}」。`,
    `性格刻度（0–100）：${traitLine}`,
    `当前心情：${mood}。`,
    memBits.length ? `可参考的记忆：\n${memBits.join('\n')}` : '暂无额外记忆。',
    identityLine,
    groupRules,
    `对方刚在${platformLabel}上说：「${clip(text.replace(/\s+/g, ' '), 200)}」`,
    '要求：只输出一段话（一两句口语），完全贴合人设与心情。',
    '禁止：分点、空行、小标题、「顺带一句」、解释规则、客服腔、「你说的「…」我收到了」、调用任何工具。',
    '只输出给对方看的正文，不要旁白。',
  ].filter(Boolean).join('\n');
}

export function extractImReplyText(out) {
  if (typeof out === 'string') return out.trim();
  if (!out || typeof out !== 'object') return '';
  for (const key of ['text', 'reply', 'message']) {
    const v = out[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  if (typeof out.content === 'string' && out.content.trim()) return out.content.trim();
  if (Array.isArray(out.content)) {
    const joined = out.content
      .map((p) => (typeof p === 'string' ? p : str(p?.text)))
      .filter(Boolean)
      .join('')
      .trim();
    if (joined) return joined;
  }
  // Host sometimes returns OpenAI-ish shapes
  const choice = out.choices?.[0]?.message?.content ?? out.choices?.[0]?.text;
  if (typeof choice === 'string' && choice.trim()) return choice.trim();
  return '';
}
