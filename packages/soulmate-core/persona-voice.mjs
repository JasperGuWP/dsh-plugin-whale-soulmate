// 人设一句话小传：给「主动开口」与「看片观感」共用，保证台词/评价带当前性格，
// 而不是滑回中性助手腔。只读预设与五维/心情，不碰隐私字段。
import { PRESETS } from './persona.mjs';

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));

const MOOD_SHORT = {
  happy: '开心',
  focused: '专注',
  hungry: '饿了',
  sleepy: '犯困',
  sulking: '有点小委屈',
};

/**
 * @param {object} persona config.persona
 * @param {object} [state] soulmate state（取 mood）
 * @returns {string} 一两句人设小传；无预设信息时返回空串。
 */
export function personaVoiceBrief(persona = {}, state = {}) {
  const preset = PRESETS[str(persona.preset).trim()];
  const bits = [];
  if (preset?.description) bits.push(str(preset.description).replace(/\s+/g, '').replace(/[。；;]+$/, ''));
  const t = persona.traits || preset?.traits || {};
  const notes = [];
  if (Number(t.sassiness) >= 70) notes.push('吐槽犀利');
  if (Number(t.tsundere) >= 70) notes.push('嘴硬心软');
  else if (Number(t.tsundere) <= 30) notes.push('有话直说');
  if (Number(t.clinginess) >= 70) notes.push('黏人');
  else if (Number(t.clinginess) <= 30) notes.push('有距离感');
  if (Number(t.brevity) >= 70) notes.push('话短');
  else if (Number(t.brevity) <= 30) notes.push('可以写细');
  if (notes.length) bits.push(`分寸：${notes.join('、')}`);
  const catchphrases = (preset?.catchphrases ?? []).slice(0, 2).map((s) => `「${str(s)}」`).join(' ');
  if (catchphrases) bits.push(`口吻参考：${catchphrases}`);
  const mood = MOOD_SHORT[str(state?.mood).trim()];
  if (mood) bits.push(`当下心情：${mood}`);
  return bits.join('。');
}