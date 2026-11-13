// Gesture say-lines for the desktop pet, split out of widget.mjs to keep it under the
// 600-line ceiling (PRD §8). Every surface speaks in the chosen persona — preset-aware
// pools with trait heuristics for blank souls; never a fixed whale-girl template.

const GESTURE_SAYS = {
  'rice-whale': { tap: ['嗯？', '干嘛戳本鱼。', '……哼。', '饭呢？'], nuzzle: ['……才没有开心呢。', '尾巴摇起来了。', '哼，勉强让你贴一下。'] },
  'gentle-echo': { tap: ['嗯？我在。', '怎么啦？', '摸到了。'], nuzzle: ['嘿嘿，再陪一下？', '好暖。', '记下了，亲密度 +5。'] },
  'geek-partner': { tap: ['嗯？说事。', '在呢。', '戳我干嘛，bug 修完了？'], nuzzle: ['行吧，充电五秒。', '亲密度 +5，记进日志。', '……别影响我干活。'] },
  'yandere-claim': { tap: ['……你终于碰我了。', '嗯？只许碰我。', '在。一直看着你。'], nuzzle: ['再靠近一点。', '不许去找别人。', '……记住这个温度。'] },
  'quiet-guardian': { tap: ['嗯。', '在。', '说。'], nuzzle: ['……嗯。', '别闹。', '陪着呢。'] },
  'cool-senpai': { tap: ['嗯？', '有事？', '别戳。'], nuzzle: ['……就一下。', '别得寸进尺。', '哼。'] },
  'clingy-cyclone': { tap: ['哇！你理我了！', '在吗在吗！', '嘿嘿，戳我干嘛～'], nuzzle: ['贴贴～', '再来一下再来一下！', '开心到转圈！'] },
  'dark-hunter': { tap: ['……找到你了。', '嗯？别跑。', '碰我可以，代价自负。'], nuzzle: ['……记住这个距离。', '别躲。', '猎物主动送上门？'] },
}

/** Pick the say pool for a gesture kind, given the persona block (preset or traits). */
function gestureSayPool(persona, kind) {
  const ps = persona || {}
  const pack = GESTURE_SAYS[String(ps.preset || '')]
  if (pack && pack[kind]) return pack[kind]
  const tr = ps.traits || {}
  if (kind === 'tap') {
    if ((Number(tr.tsundere) || 50) >= 70) return ['……哼。', '干嘛戳我。', '在呢。']
    if ((Number(tr.clinginess) || 50) >= 70) return ['在吗在吗！', '你理我了！', '嗯？']
    return ['嗯？', '在呢。', '说。']
  }
  if ((Number(tr.tsundere) || 50) >= 70) return ['……才没有开心呢。', '勉强让你贴一下。', '哼。']
  if ((Number(tr.clinginess) || 50) >= 70) return ['贴贴～', '嘿嘿，再来一下？', '好暖。']
  return ['嗯。', '记下了。', '陪着呢。']
}

module.exports = { GESTURE_SAYS, gestureSayPool }
