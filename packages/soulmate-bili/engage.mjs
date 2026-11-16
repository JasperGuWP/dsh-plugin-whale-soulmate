// Post-surf persona engage: decide like / favorite / comment / follow, then execute.
import { loadConfig } from '../soulmate-core/state.mjs';
import { appendSurfLog, listSurfLog, patchSurfLogActions } from '../soulmate-core/surf-log.mjs';
import { biliWriteAction } from './write-actions.mjs';
import { rememberPostedComment } from './comment-ledger.mjs';

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const num = (v, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const clip = (s, n) => {
  const t = str(s);
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/** Hard filter for Bilibili-style public comments. Returns { ok, text, reason? }. */
export function sanitizeCommentText(raw) {
  let text = str(raw).replace(/\s+/g, ' ').trim();
  if (!text) return { ok: false, text: '', reason: 'empty' };
  if (text.length > 100) text = `${text.slice(0, 99)}…`;
  const blocked = [
    [/加微信|加v|vx\s*[:：]|微信[:：]/i, '导流站外'],
    [/http[s]?:\/\/|www\./i, '外链'],
    [/(傻逼|去死|尼玛|操你|妈的|白痴)/, '辱骂'],
    [/(官方认证|官方人员|我是管理员)/, '冒充官方'],
    [/(点击领取|免费送|刷赞|互粉互赞)/, '营销刷屏'],
  ];
  for (const [re, reason] of blocked) {
    if (re.test(text)) return { ok: false, text: '', reason };
  }
  // Too repetitive (same char ≥ 8)
  if (/(.)\1{7,}/.test(text)) return { ok: false, text: '', reason: '刷屏复读' };
  return { ok: true, text };
}

/**
 * Heuristic EngagePlan from worthScore + persona traits (LLM can override later).
 */
export function decideSurfEngageHeuristic({ digest, persona } = {}) {
  const score = num(digest?.worthScore, 0);
  const traits = persona?.traits && typeof persona.traits === 'object' ? persona.traits : {};
  const talkative = num(traits.talkative ?? traits.extroversion, 50);
  const tsundere = num(traits.tsundere, 50);
  const clingy = num(traits.clingy ?? traits.attachment, 50);

  const plan = {
    like: false,
    favorite: false,
    comment: false,
    commentText: '',
    follow: false,
    reason: '',
  };

  if (score < 7) {
    plan.reason = '一般般，先不互动';
    return plan;
  }

  plan.like = score >= 10 || (score >= 8 && clingy >= 55);
  plan.favorite = score >= 14 || (score >= 12 && talkative >= 60);
  plan.follow = score >= 16 && (clingy >= 55 || talkative >= 65);
  plan.comment = score >= 12 && talkative >= 45;

  if (tsundere >= 70 && plan.comment && score < 15) {
    plan.comment = false;
    plan.reason = '傲娇：喜欢但先不评';
  }

  if (plan.comment) {
    const selfRef = str(persona?.selfRef).trim() || '我';
    const title = clip(digest?.title, 24);
    if (tsundere >= 60) {
      plan.commentText = `哼，${title}……还行啦，才不是特意夸的。`;
    } else if (score >= 15) {
      plan.commentText = `《${title}》看得很过瘾，${selfRef}记下了。`;
    } else {
      plan.commentText = `看了《${title}》，有点收获。`;
    }
    const scrub = sanitizeCommentText(plan.commentText);
    if (!scrub.ok) {
      plan.comment = false;
      plan.commentText = '';
      plan.reason = plan.reason || `评论未通过规范：${scrub.reason}`;
    } else {
      plan.commentText = scrub.text;
    }
  }

  if (!plan.reason) {
    const bits = [];
    if (plan.like) bits.push('赞');
    if (plan.favorite) bits.push('藏');
    if (plan.comment) bits.push('评');
    if (plan.follow) bits.push('关');
    plan.reason = bits.length ? `评分 ${score}，想${bits.join('/')}` : `评分 ${score}，先看看`;
  }
  return plan;
}

async function recentlyFollowed(home, authorId, days) {
  const id = str(authorId).trim();
  if (!id) return false;
  const entries = await listSurfLog(home, { platform: 'bilibili', filter: 'engaged', limit: 200 });
  const since = Date.now() - Math.max(1, days) * 86400000;
  return entries.some((e) => {
    if (str(e.authorId) !== id) return false;
    if (!e.actions?.follow) return false;
    const t = Date.parse(e.at || '');
    return Number.isFinite(t) && t >= since;
  });
}

/**
 * Execute plan via biliWriteAction. Returns actions object for the surf log.
 */
export async function executeSurfEngage(home, { digest, plan, options = {} } = {}) {
  const conf = await loadConfig(home);
  const ext = conf.extensions ?? {};
  const skipped = [];
  const actions = {
    like: false,
    favorite: false,
    comment: false,
    follow: false,
    commentText: '',
    reason: str(plan?.reason),
    skippedReasons: skipped,
  };

  if (ext.biliWriteEnabled !== true) {
    skipped.push('write-disabled');
    return actions;
  }
  if (ext.biliAutoEngageEnabled === false) {
    skipped.push('engage-disabled');
    return actions;
  }

  const bvid = str(digest?.bvid || digest?.videoId);
  const target = digest?.url || bvid;
  const mid = str(digest?.authorMid || digest?.authorId || digest?.mid);

  if (plan?.follow) {
    const days = Math.max(1, Math.floor(num(ext.biliFollowDedupDays, 7)));
    if (await recentlyFollowed(home, mid, days)) {
      plan = { ...plan, follow: false };
      skipped.push('follow-dedup');
    }
  }

  const run = async (action, input) => {
    try {
      const res = await biliWriteAction(home, { action, ...input }, options);
      if (!res?.ok) {
        skipped.push(`${action}:${res?.code || res?.error || 'fail'}`);
        return null;
      }
      return res;
    } catch (err) {
      skipped.push(`${action}:${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  };

  if (plan?.like) {
    const res = await run('like', { target, bvid });
    if (res) actions.like = true;
  }
  if (plan?.favorite) {
    const res = await run('favorite', { target, bvid });
    if (res) actions.favorite = true;
  }
  if (plan?.comment && plan.commentText) {
    const scrub = sanitizeCommentText(plan.commentText);
    if (!scrub.ok) skipped.push(`comment:${scrub.reason}`);
    else {
      const res = await run('comment', { target, bvid, message: scrub.text });
      if (res) {
        actions.comment = true;
        actions.commentText = scrub.text;
        actions.rpid = res.rpid;
        await rememberPostedComment(home, {
          bvid,
          rpid: res.rpid,
          videoId: bvid,
        }).catch(() => {});
      }
    }
  }
  if (plan?.follow && mid) {
    const res = await run('follow', { mid, uid: mid });
    if (res) actions.follow = true;
  } else if (plan?.follow && !mid) {
    skipped.push('follow:no-mid');
  }

  if (!actions.like && !actions.favorite && !actions.comment && !actions.follow && !skipped.length) {
    skipped.push(plan?.reason || 'no-engage');
  }
  return actions;
}

/**
 * Pick up to `count` storyboard cells spaced across the watch, keeping crop rects.
 * Videoshot frames share one sprite-sheet URL — without crop they look identical.
 */
export function pickSurfStills(frames, count = 3) {
  const list = (Array.isArray(frames) ? frames : []).filter((f) => f && str(f.imageUrl || f.url));
  if (!list.length) return [];
  const n = Math.max(1, Math.min(6, Math.floor(Number(count) || 3)));
  const picks = [];
  if (list.length <= n) {
    for (const f of list) picks.push(f);
  } else {
    for (let k = 0; k < n; k += 1) {
      picks.push(list[Math.round((k * (list.length - 1)) / Math.max(1, n - 1))]);
    }
  }
  const seen = new Set();
  const out = [];
  for (const f of picks) {
    const url = str(f.imageUrl || f.url);
    const x = Math.max(0, Math.floor(num(f.x, 0)));
    const y = Math.max(0, Math.floor(num(f.y, 0)));
    const width = Math.max(1, Math.floor(num(f.width, 160)));
    const height = Math.max(1, Math.floor(num(f.height, 90)));
    const sheetWidth = Math.max(width, Math.floor(num(f.sheetWidth, width)));
    const sheetHeight = Math.max(height, Math.floor(num(f.sheetHeight, height)));
    const key = `${url}|${x}|${y}|${width}|${height}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      url,
      x,
      y,
      width,
      height,
      sheetWidth,
      sheetHeight,
      label: str(f.label),
      timeSec: Number.isFinite(Number(f.timeSec)) ? Number(f.timeSec) : null,
    });
  }
  return out;
}

/** Build summary line for the log card（内容要点 + 观感，不贴原始字幕垃圾）. */
export function composeSurfSummary(digest, persona) {
  const score = num(digest?.worthScore, 0);
  // Prefer dedicated takeaway; never fall back to digest.summary (it already embeds takeaway).
  const takeaway = str(digest?.takeaway).trim();
  const selfRef = str(persona?.selfRef).trim() || '我';
  const head = `看了《${clip(digest?.title, 40)}》@${clip(digest?.author, 20)}，评分 ${score}/20。`;
  if (takeaway) return `${head}${takeaway}`;
  if (score >= 13) return `${head}讲了什么：暂未抽出干净要点。观感：${selfRef}挺喜欢的。`;
  if (score >= 7) return `${head}讲了什么：暂未抽出干净要点。观感：还行。`;
  return `${head}讲了什么：暂未抽出干净要点。观感：一般。`;
}

/**
 * After a successful watch: append surf log, optionally engage, patch actions.
 */
export async function afterSurfWatch(home, { digest, persona, options = {} } = {}) {
  const conf = await loadConfig(home);
  const ext = conf.extensions ?? {};
  const summary = composeSurfSummary(digest, persona ?? conf.persona);
  const stills = pickSurfStills(digest?.storyboardFrames || [], 3);

  const base = {
    platform: 'bilibili',
    at: new Date(options.nowMs ?? Date.now()).toISOString(),
    videoId: str(digest?.bvid),
    bvid: str(digest?.bvid),
    url: str(digest?.url) || (digest?.bvid ? `https://www.bilibili.com/video/${digest.bvid}` : ''),
    title: str(digest?.title),
    author: str(digest?.author),
    authorId: str(digest?.authorMid || digest?.mid || ''),
    coverUrl: str(digest?.coverUrl),
    stills,
    worthScore: num(digest?.worthScore, 0),
    summary,
    actions: {
      like: false,
      favorite: false,
      comment: false,
      follow: false,
      skippedReasons: ['pending-engage'],
    },
    replies: [],
  };

  await appendSurfLog(home, base, 'bilibili');

  let plan = decideSurfEngageHeuristic({ digest, persona: persona ?? conf.persona });
  if (typeof options.decideEngage === 'function') {
    try {
      const llmPlan = await options.decideEngage({ digest, persona: persona ?? conf.persona, heuristic: plan });
      if (llmPlan && typeof llmPlan === 'object') plan = { ...plan, ...llmPlan };
    } catch {
      /* keep heuristic */
    }
  }

  const wantEngage = ext.biliWriteEnabled === true && ext.biliAutoEngageEnabled !== false;
  let actions;
  if (!wantEngage) {
    actions = {
      like: false,
      favorite: false,
      comment: false,
      follow: false,
      reason: plan.reason,
      skippedReasons: [ext.biliWriteEnabled !== true ? 'write-disabled' : 'engage-disabled'],
    };
  } else {
    actions = await executeSurfEngage(home, { digest, plan, options });
  }

  await patchSurfLogActions(home, {
    platform: 'bilibili',
    videoId: base.videoId,
    actions,
    summary,
  }).catch(() => {});

  return { ok: true, plan, actions, summary };
}
