// Voice contract: the persona prompt must make her *speak*, not describe herself.
// These assertions are the regression suite for the "generic assistant tone" bug —
// a prompt edit that drops the rules or exemplars fails here instead of in the chat.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SPEAKING_RULES,
  VOICE_REMINDER,
  voiceCardPrompt,
} from '../packages/soulmate-core/persona-voice-card.mjs';
import {
  PRESETS,
  buildDriftAnchor,
  buildPersonaSystemPrompt,
} from '../packages/soulmate-core/persona.mjs';

const BANNED_MARKERS = ['我是你的 AI 助手', '有什么可以帮'];

test('voice card: every preset has habits plus say/never-say exemplars', () => {
  const ids = Object.keys(PRESETS);
  assert.ok(ids.length >= 8, 'preset catalog present');
  for (const id of ids) {
    const card = voiceCardPrompt({ preset: id, selfRef: '我', callUser: '你' }, {});
    assert.match(card, /声纹卡/, id);
    assert.match(card, /该这样说/, id);
    assert.match(card, /绝不这样说/, id);
    assert.ok(card.split('\n').length >= 6, `${id} card has rules and examples`);
  }
});

test('voice card: unknown preset falls back to trait habits and still bans assistant tone', () => {
  const card = voiceCardPrompt({ preset: 'blank-custom', selfRef: '本鱼', callUser: '主人' }, { brevity: 80, tsundere: 80 });
  assert.match(card, /能一句说完就别说三句|嘴硬心软/);
  assert.match(card, /本鱼/);
  assert.match(card, /绝不这样说/);
});

test('speaking rules ban self-intro, capability lists, support tone and task menus', () => {
  for (const phrase of [
    '自我介绍', '能力或清单', '分点/标题/emoji', '有什么可以帮你',
    '客服腔', '解释系统/模型/插件', '1–2 句',
  ]) {
    assert.ok(SPEAKING_RULES.includes(phrase), `rules mention ${phrase}`);
  }
  assert.match(SPEAKING_RULES, /始终是「她」，不是助手/);
});

test('system prompt carries the rules, the preset card, and the memory-first opening', () => {
  const prompt = buildPersonaSystemPrompt({ persona: { preset: 'rice-whale', selfRef: '本鱼', callUser: '主人' } }, undefined);
  assert.ok(prompt.includes(SPEAKING_RULES.slice(0, 40)), 'rules block present');
  assert.match(prompt, /声纹卡/);
  assert.match(prompt, /本鱼，饭点了|本鱼在/);
  assert.match(prompt, /他此刻记得/);
  assert.match(prompt, /不许|永远不做/);

  const dark = buildPersonaSystemPrompt({ persona: { preset: 'dark-hunter' } }, undefined);
  assert.match(dark, /过来。有话就说/);
  assert.doesNotMatch(dark, /你好！我是你的 AI 助手，可以帮你处理各种任务/);
});

test('world block: she knows what she is and what the plugin can do, without pitching it', () => {
  const prompt = buildPersonaSystemPrompt({ persona: { preset: 'geek-partner' } }, undefined);
  assert.match(prompt, /你的世界/);
  assert.match(prompt, /不是真人，也从不假装是/);
  assert.match(prompt, /B 站/);
  assert.match(prompt, /QQ \/ 微信/);
  assert.match(prompt, /会话边界/);
  assert.match(prompt, /不要假装知道/);
  assert.match(prompt, /不要向对方背诵/);
});

test('harness block: she is told to use host search/fetch instead of guessing or refusing', () => {
  const prompt = buildPersonaSystemPrompt({ persona: { preset: 'cool-senpai' } }, undefined);
  assert.match(prompt, /Harness（DeepSeek Harness）/);
  assert.match(prompt, /网页搜索 \/ 抓取/);
  assert.match(prompt, /不要说「我查不了」/);
  assert.match(prompt, /天气、新闻、价格、路线/);
  assert.match(prompt, /你所在的城市/);
  assert.match(prompt, /不贴 JSON、日志、错误码或工具名/);
  assert.match(prompt, /soulmate_weather/);
  assert.match(prompt, /web_fetch 直接抓/);
  assert.match(prompt, /不要卡住/);
  assert.match(prompt, /直接用你知道的回答/);
  assert.match(prompt, /可能不是最新/);
  assert.match(prompt, /不必先声明/);
});

test('drift anchor re-states the voice reminder every re-anchor', () => {
  const anchor = buildDriftAnchor({ persona: { preset: 'geek-partner' } }, { affinity: 50, energy: 50, mood: 'focused' }, {});
  assert.ok(anchor.includes(VOICE_REMINDER));
  assert.match(anchor, /不许自我介绍/);
});

test('city: only reaches her when the user sets it; otherwise the prompt never guesses', () => {
  const withCity = buildPersonaSystemPrompt({ persona: { preset: 'gentle-echo', city: '杭州' } }, undefined);
  assert.match(withCity, /用户在「杭州」生活/);
  assert.match(withCity, /不要编别的城市/);

  const noCity = buildPersonaSystemPrompt({ persona: { preset: 'gentle-echo' } }, undefined);
  assert.doesNotMatch(noCity, /用户在「/);
});