// Video genre → what the「观感」must actually talk about.
//
// User rule (2026-11-26): the opinion is not one generic "值不值得看" paragraph.
// A drama should be judged on its story, a funny edit on which bits are funny, a news
// clip on the events it reports, and so on. Classification is local and keyword-based
// (title / tags / partition / description) so it costs nothing and never hits a model.

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));

/**
 * Each rule: `patterns` score against title (×4), tags (×3), partition (×3), desc (×1).
 * `opinion` is pasted into the vision prompt as the required focus of 观感.
 * `timeline` tells the model how to chapter this kind of video.
 */
export const GENRE_RULES = Object.freeze([
  {
    id: 'drama',
    label: '剧情/短剧',
    patterns: [
      /剧情/, /短剧/, /合集/, /完整版/, /全集/, /第[一二三四五六七八九十\d]+季/, /大结局/, /番剧/, /动漫/, /动画/, /电视剧/, /电影/, /小说改编/, /穿越/, /重生/, /末日/, /丧尸/, /赘婿/, /战神/, /爽文/, /逆袭/, /AI全民制作人/,
    ],
    opinion: '重点讲剧情本身：主线是什么、主角的目标和阻力、人物动机与关系立不立得住、哪几段冲突或反转最有戏、结局收得怎么样；有没有注水、降智、重复套路或烂尾。必须落到具体情节和人物，不许只写「好看/一般」。',
    timeline: '按剧情节点切章：世界观/开端、第一次转折、关键冲突、高潮、结局；合集或分季的按季、按单元分段，不要按「第几分钟出现了什么画面」切。',
  },
  {
    id: 'funny',
    label: '搞笑/整活',
    patterns: [
      /搞笑/, /沙雕/, /整活/, /爆笑/, /笑死/, /鬼畜/, /名场面/, /离谱/, /抽象/, /梗/, /段子/, /翻车/, /社死/, /挑战/,
    ],
    opinion: '点名具体笑点：哪几个桥段、哪句台词、哪个梗最好笑，笑点来自反差、误会、夸张还是鬼畜；哪些段子尬、重复、拖节奏；当下饭/睡前视频值不值。不要笼统说「很搞笑」。',
    timeline: '按笑点段落切章：每个梗/整活/翻车单元一段，标出最好笑的那几段；不要按时间平均切。',
  },
  {
    id: 'news',
    label: '新闻/时事',
    patterns: [
      /新闻/, /时事/, /通报/, /记者/, /央视/, /人民日报/, /新华社/, /国际局势/, /政策/, /突发/, /事件进展/, /发布会/, /外交部/, /国务院/, /大选/, /战争/, /停火/, /制裁/,
    ],
    opinion: '讲清楚片子里真正重要的时事：发生了什么、涉及哪些主体/时间/地点、关键数字与后续影响；区分事实报道与评论立场，指出信息缺口或明显偏向；不要只复述标题，也不要加自己的政治判断。',
    timeline: '按新闻条目或事件阶段切章：一件事一段，标出起因、进展、各方回应、后续影响；多条新闻按重要性排序。',
  },
  {
    id: 'knowledge',
    label: '知识科普',
    patterns: [
      /科普/, /讲解/, /原理/, /知识/, /课程/, /教程/, /入门/, /数学/, /物理/, /化学/, /历史/, /哲学/, /心理学/, /经济学/, /法律/, /编程/, /算法/, /一口气.*(吃透|讲透|搞懂|看懂)/, /底层逻辑/, /硬核/,
    ],
    opinion: '说清它把哪个概念讲明白了：核心结论、关键类比或例子、论证是否站得住、哪段信息密度最高、哪里跳跃或过时；适合什么基础的人看。不要只说「干货满满」。',
    timeline: '按概念或论证步骤切章：一个问题一段，标出定义、例子、推论、结论；不要按画面切换切。',
  },
  {
    id: 'review',
    label: '评测/开箱',
    patterns: [
      /评测/, /测评/, /实测/, /开箱/, /上手/, /体验/, /对比/, /值不值/, /推荐/, /装机/, /手机/, /相机/, /耳机/, /键盘/, /显卡/, /笔记本/,
    ],
    opinion: '给结论：值不值得买/用；说清实测条件、优点缺点、对比对象、价格和适用人群；哪些是厂商话术或样片，哪些是真实体验。不要只念参数。',
    timeline: '按评测环节切章：外观/配置、实测项目、对比、优缺点、购买建议；每个结论要有数据或体验支撑。',
  },
  {
    id: 'game',
    label: '游戏',
    patterns: [
      /游戏/, /实况/, /攻略/, /速通/, /王者/, /原神/, /我的世界/, /Steam/, /主机/, /手游/, /电竞/, /开黑/, /通关/, /版本更新/,
    ],
    opinion: '说玩法与体验：核心循环、难度曲线、亮点关卡或机制、bug/逼氪/重复劳动、适合谁；不要只报流程或战绩。',
    timeline: '按关卡/版本/关键战斗切章：玩法展示、难点、胜负手、版本改动；不要按分钟平均分。',
  },
  {
    id: 'food',
    label: '美食',
    patterns: [
      /美食/, /探店/, /做饭/, /食谱/, /厨/, /吃播/, /餐厅/, /味道/, /料理/, /烧烤/, /火锅/, /甜品/, /夜宵/,
    ],
    opinion: '说吃的：菜品或店、味道口感、价格分量、值不值得去吃/做；哪道最惊喜、哪道翻车；别只报菜名。',
    timeline: '按菜品或探店环节切章：一道菜/一家店一段，标出味道、价格、推荐度。',
  },
  {
    id: 'vlog',
    label: '生活/vlog',
    patterns: [
      /vlog/i, /日常/, /记录/, /旅行/, /一天/, /生活/, /独居/, /搬家/, /装修/, /周末/, /治愈/,
    ],
    opinion: '说人和事：这期记录了什么、最有生活感的片段、情绪落点在哪；不用逐段报流水账，挑真正有意思的两三件事。',
    timeline: '按地点/事件/时间阶段切章：早上/路上/目的地或一件事一段，标出情绪转折。',
  },
  {
    id: 'music',
    label: '音乐',
    patterns: [
      /音乐/, /MV/i, /翻唱/, /演奏/, /钢琴/, /吉他/, /歌曲/, /现场/, /演唱会/, /编曲/, /原创曲/, /DJ/i,
    ],
    opinion: '说作品：编曲/演唱/演奏的亮点、情绪走向、最抓耳的一段、现场或录音质量；别只报歌名和歌手。',
    timeline: '按歌曲结构或曲目切章：前奏/主歌/副歌/桥段/尾声，或一首歌一段；标出最出彩的位置。',
  },
  {
    id: 'commentary',
    label: '影视解说',
    patterns: [
      /解说/, /影评/, /盘点/, /高分/, /剧集/, /原著/, /细节/, /彩蛋/, /拉片/, /十分钟看完/, /一口气看完/,
    ],
    opinion: '说解说本身：覆盖了哪些剧情、观点有没有新意、是否剧透、和原作差在哪、值不值得去看原片；不要只复述剧情。',
    timeline: '按原作章节或解说论点切章：铺垫、转折、高潮、结论；标出解说者新增的观点。',
  },
  {
    id: 'interview',
    label: '访谈/播客',
    patterns: [
      /访谈/, /播客/, /对话/, /圆桌/, /对谈/, /采访/, /连线/, /直播回放/, /大佬/, /创始人/,
    ],
    opinion: '说观点：嘉宾是谁、聊出了哪些有价值的判断或故事、有哪些分歧、哪段值得回听；不要只报话题列表。',
    timeline: '按话题或嘉宾观点切章：一个问题/一个观点一段，标出最有信息量的回答。',
  },
  {
    id: 'sports',
    label: '运动/比赛',
    patterns: [
      /健身/, /篮球/, /足球/, /跑步/, /比赛/, /NBA/i, /世界杯/, /奥运/, /训练/, /球赛/, /集锦/,
    ],
    opinion: '说比赛或训练：关键回合、胜负手、数据或动作亮点、争议判罚；别只报比分和结果。',
    timeline: '按节次/回合/关键事件切章：开局、转折、决胜、赛后；标出改变走势的那一下。',
  },
  {
    id: 'finance',
    label: '财经/商业',
    patterns: [
      /财经/, /股票/, /基金/, /投资/, /商业/, /资本/, /经济/, /财报/, /公司/, /创业/, /赚钱/, /行业/, /估值/,
    ],
    opinion: '说钱和生意：核心标的或行业、关键数字与逻辑、风险和反面观点、适合谁参考；明确这不是投资建议，别把预测当事实。',
    timeline: '按论点或事件切章：背景、关键数据、推演、风险、结论；每个判断标出依据。',
  },
  {
    id: 'tech',
    label: '科技/数码',
    patterns: [
      /科技/, /\bAI\b/i, /人工智能/, /芯片/, /数码/, /大模型/, /算力/, /机器人/, /互联网/, /软件/, /硬件/, /数据中心/,
    ],
    opinion: '说技术与产品：解决了什么问题、关键指标或对比、真实体验与槽点、值不值得关注或购买；区分发布话术与实测结果。',
    timeline: '按技术/产品模块切章：问题、方案、指标、对比、结论；不要按发布会流程报幕。',
  },
]);

const GENERIC = Object.freeze({
  id: 'other',
  label: '综合',
  opinion: '说清这片子到底讲了什么、哪一段最有价值、哪里注水或跑题、适合谁看；评价要落在具体内容上，不要空泛地说「不错/一般」。',
  timeline: '按内容本身的阶段切章：开头、展开、重点、结尾；每一章给一句具体要点。',
});

function scoreRule(rule, meta) {
  let score = 0;
  for (const re of rule.patterns || []) {
    if (!(re instanceof RegExp)) continue;
    if (re.test(meta.title)) score += 4;
    if (re.test(meta.tags)) score += 3;
    if (re.test(meta.tname)) score += 3;
    if (re.test(meta.desc)) score += 1;
  }
  return score;
}

/**
 * Classify a video from cheap local metadata.
 * @param {{title?:string, desc?:string, tags?:string[]|string, tname?:string, partition?:string}} meta
 * @returns {{ id:string, label:string, opinion:string, timeline:string, score:number, source:'keyword'|'fallback' }}
 */
export function classifyVideoGenre(meta = {}) {
  const input = meta && typeof meta === 'object' ? meta : {};
  const tags = Array.isArray(input.tags) ? input.tags.map(str).join(' ') : str(input.tags);
  const view = {
    title: str(input.title),
    desc: str(input.desc),
    tags,
    tname: str(input.tname || input.partition),
  };
  let best = null;
  for (const rule of GENRE_RULES) {
    const score = scoreRule(rule, view);
    if (score > 0 && (!best || score > best.score)) best = { rule, score };
  }
  if (!best) return { ...GENERIC, score: 0, source: 'fallback' };
  return {
    id: best.rule.id,
    label: best.rule.label,
    opinion: best.rule.opinion,
    timeline: best.rule.timeline,
    score: best.score,
    source: 'keyword',
  };
}

/** The「观感」line inserted into vision prompts. Exported for tests and docs. */
export function opinionInstruction(genre, { voice = '', maxChars = 500 } = {}) {
  const g = genre && genre.opinion ? genre : GENERIC;
  const persona = str(voice).trim()
    ? '用你的口吻和当前性格的措辞与态度来写（可以嘴硬、护短、吐槽，但必须落在具体内容上），不要写成中性分析报告。'
    : '用自然口语写，不要中性分析报告。';
  return `观感：<不超过 ${maxChars} 字，3–6 句。必须覆盖全片（开头、中段、结尾），不能只评其中一段。按【类型：${g.label}】的侧重点写：${g.opinion} ${persona}不要复述时间线，不要编造画面外内容，不要评镜头/机位/剪辑/运镜（除非片子本身就是讲拍摄的）。>`;
}

/** The timeline chapter rule for a genre; long compilations get more chapters. */
export function timelineInstruction(genre, { long = false, segment = false } = {}) {
  const g = genre && genre.timeline ? genre : GENERIC;
  const count = segment ? '2–5 段，只写本批时间段' : long ? '8–16 段' : '3–6 段';
  return `时间线：按【类型：${g.label}】切章：${g.timeline}（${count}）。每一章给 mm:ss–mm:ss 和一句具体要点，不要写「讲了点东西」。`;
}

export const GENERIC_GENRE = GENERIC;