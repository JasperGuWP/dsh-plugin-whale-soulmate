// 细看裁决：prompt 带人设与初扫结论；回执 JSON/口语解析；启发式兜底；深看二刷链路（mock 网络）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDeepJudgePrompt,
  parseDeepJudgeReply,
  heuristicDeepJudge,
  judgeDeepWatch,
} from '../packages/soulmate-bili/deep-judge.mjs';

test('buildDeepJudgePrompt carries persona, interests and first-pass facts; asks JSON only', () => {
  const p = buildDeepJudgePrompt({
    title: 'Anthropic崛起史', author: '硅谷101', durationSec: 2760, worthScore: 18,
    desc: '五年冲击万亿估值', takeaway: '讲了什么：估值曲线开头…', coverage: { report: '分镜 8 帧' },
  }, { persona: '戏谑、护短带刺。分寸：吐槽犀利', interests: ['AI', '科技'], callUser: '你' });
  assert.match(p, /细看裁决/);
  assert.match(p, /【你的性格】戏谑/);
  assert.match(p, /【你的兴趣关键词】AI、科技/);
  assert.match(p, /初扫评分：18\/20/);
  assert.match(p, /初扫结论：讲了什么/);
  assert.match(p, /"deep":true\|false/);
});

test('parseDeepJudgeReply: JSON in noise, fences, and spoken fallbacks', () => {
  assert.deepEqual(parseDeepJudgeReply('{"deep":true,"reason":"这期信息密度值得二刷"}'), { deep: true, reason: '这期信息密度值得二刷' });
  assert.deepEqual(parseDeepJudgeReply('好，我判：\n```json\n{"deep":false,"reason":"整活片，粗扫够了"}\n```'), { deep: false, reason: '整活片，粗扫够了' });
  assert.equal(parseDeepJudgeReply('这片子值得细看，硬核访谈').deep, true);
  assert.equal(parseDeepJudgeReply('不值得细看，水分大').deep, false);
  assert.equal(parseDeepJudgeReply('今天天气不错'), null);
  assert.equal(parseDeepJudgeReply(''), null);
});

test('heuristicDeepJudge: high-score long/informative videos go deep, short ones stay skim', () => {
  assert.equal(heuristicDeepJudge({ worthScore: 18, durationSec: 2760, transcript: 'x'.repeat(2000) }).deep, true);
  assert.equal(heuristicDeepJudge({ worthScore: 18, durationSec: 60, transcript: '' }).deep, false);
  assert.equal(heuristicDeepJudge({ worthScore: 6, durationSec: 3000, transcript: 'x'.repeat(3000) }).deep, false);
});

test('judgeDeepWatch: agent verdict wins; broken model falls back to heuristic', async () => {
  const digest = { worthScore: 18, durationSec: 2760, transcript: 'x'.repeat(2000), title: 'T' };
  const agent = await judgeDeepWatch(digest, {
    persona: 'p', interests: ['AI'],
    generateText: async () => '{"deep":false,"reason":"我看过了，粗扫够"}',
  });
  assert.deepEqual(agent, { deep: false, reason: '我看过了，粗扫够', via: 'agent' });
  const broken = await judgeDeepWatch(digest, { generateText: async () => { throw new Error('model down'); } });
  assert.equal(broken.via, 'heuristic');
  assert.equal(broken.deep, true);
  const garbage = await judgeDeepWatch(digest, { generateText: async () => '我不知道你在说什么' });
  assert.equal(garbage.via, 'heuristic');
});