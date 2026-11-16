// Dedicated "soulmate" chat-home session: ensure / measure / rotate / wake prompts.
//
// Pure helpers + thin host adapters. Timers and config IO stay in index.mjs.
// Delivery target for proactive/boot is always chatHome.activeSessionId (plan A).

import { estimateTokens } from './budget.mjs';
import { presetShortName } from './persona.mjs';
import { randomBytes, randomUUID } from 'node:crypto';

export const DEFAULT_CHAT_HOME = Object.freeze({
  activeSessionId: '',
  archiveSessionIds: Object.freeze([]),
  maxTurns: 100,
  maxEstTokens: 72_000,
  titlePrefix: 'soulmate',
  bootGreeting: true,
  handoffSeed: true,
  /** Next ordinal for titles like「soulmate · 2」. */
  nextIndex: 1,
  autoMemory: true,
  knownSessionIds: Object.freeze([]),
});

const str = (v) => (v == null ? '' : String(v));
const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/** Deep-ish normalize so missing knobs never become NaN / undefined. */
export function normalizeChatHome(raw = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const archives = Array.isArray(src.archiveSessionIds)
    ? src.archiveSessionIds.map((id) => str(id).trim()).filter(Boolean)
    : [];
  return {
    activeSessionId: str(src.activeSessionId).trim(),
    archiveSessionIds: archives,
    maxTurns: Math.max(1, Math.floor(num(src.maxTurns, DEFAULT_CHAT_HOME.maxTurns))),
    maxEstTokens: Math.max(100, Math.floor(num(src.maxEstTokens, DEFAULT_CHAT_HOME.maxEstTokens))),
    titlePrefix: str(src.titlePrefix).trim() || DEFAULT_CHAT_HOME.titlePrefix,
    bootGreeting: src.bootGreeting !== false,
    handoffSeed: src.handoffSeed !== false,
    nextIndex: Math.max(1, Math.floor(num(src.nextIndex, DEFAULT_CHAT_HOME.nextIndex))),
    autoMemory: src.autoMemory !== false,
    knownSessionIds: (() => {
      const raw = Array.isArray(src.knownSessionIds) ? src.knownSessionIds : [];
      const out = [];
      for (const id of raw) {
        const s = str(id).trim();
        if (s && !out.includes(s)) out.push(s);
      }
      return out;
    })(),
  };
}

export function titleForIndex(prefix, index, tag = '') {
  const p = str(prefix).trim() || DEFAULT_CHAT_HOME.titlePrefix;
  const t = str(tag).trim();
  const i = Math.max(1, Math.floor(num(index, 1)));
  if (t) return i <= 1 ? `${p} · ${t}` : `${p} · ${t} · ${i}`;
  return i <= 1 ? p : `${p} · ${i}`;
}

/** Turns OR tokens — whichever hits first. */
export function isSessionFull(measure, limits = {}) {
  const turns = num(measure?.turns, 0);
  const tokens = num(measure?.estTokens, 0);
  const maxTurns = Math.max(1, num(limits.maxTurns, DEFAULT_CHAT_HOME.maxTurns));
  const maxEstTokens = Math.max(1, num(limits.maxEstTokens, DEFAULT_CHAT_HOME.maxEstTokens));
  if (turns >= maxTurns) return { full: true, reason: 'max-turns', turns, estTokens: tokens, maxTurns, maxEstTokens };
  if (tokens >= maxEstTokens) return { full: true, reason: 'max-tokens', turns, estTokens: tokens, maxTurns, maxEstTokens };
  return { full: false, reason: 'ok', turns, estTokens: tokens, maxTurns, maxEstTokens };
}

/** Pull plain text out of ContentBlock[] / string / nested shapes. */
export function extractPlainText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return str(content?.text ?? '');
  const parts = [];
  for (const block of content) {
    if (typeof block === 'string') parts.push(block);
    else if (block && typeof block === 'object') {
      if (typeof block.text === 'string') parts.push(block.text);
      else if (typeof block.content === 'string') parts.push(block.content);
    }
  }
  return parts.join('\n');
}

/**
 * Measure user/assistant surface messages from a Session events page (`records`).
 * Tolerates a few host shapes so tests and real DSH both work.
 */
export function measureFromRecords(pageOrRecords) {
  const records = Array.isArray(pageOrRecords)
    ? pageOrRecords
    : Array.isArray(pageOrRecords?.records)
      ? pageOrRecords.records
      : [];
  let turns = 0;
  const snippets = [];
  let blob = '';
  for (const rec of records) {
    const ev = rec?.type === 'event' ? rec.event : rec?.event ?? rec;
    if (!ev || typeof ev !== 'object') continue;
    const type = str(ev.type);
    if (type !== 'user/message' && type !== 'assistant/message') continue;
    const data = ev.data && typeof ev.data === 'object' ? ev.data : ev;
    const message = type === 'user/message' ? data : (data.message && typeof data.message === 'object' ? data.message : data);
    const role = type === 'user/message' ? 'user' : 'assistant';
    const text = extractPlainText(message?.content ?? data?.content).trim();
    turns += 1;
    if (text) {
      blob += `${text}\n`;
      if (snippets.length < 24) snippets.push({ role, text: text.slice(0, 400) });
    }
  }
  return {
    ok: true,
    turns,
    estTokens: estimateTokens(blob),
    snippets,
    hasMore: pageOrRecords?.hasMore === true,
  };
}

/** Rotate ledger: old active → archive (deduped), new becomes active, bump index. */
export function applyRotate(chatHome, newSessionId) {
  const cur = normalizeChatHome(chatHome);
  const nextId = str(newSessionId).trim();
  if (!nextId) throw new Error('[soulmate] chatHome rotate requires newSessionId');
  const archives = [...cur.archiveSessionIds];
  if (cur.activeSessionId && cur.activeSessionId !== nextId && !archives.includes(cur.activeSessionId)) {
    archives.push(cur.activeSessionId);
  }
  return {
    ...cur,
    activeSessionId: nextId,
    archiveSessionIds: archives,
    nextIndex: cur.nextIndex + 1,
  };
}

/** Adopt a freshly created session as active without archiving (first home). */
export function applyAdopt(chatHome, sessionId) {
  const cur = normalizeChatHome(chatHome);
  const id = str(sessionId).trim();
  if (!id) throw new Error('[soulmate] chatHome adopt requires sessionId');
  return {
    ...cur,
    activeSessionId: id,
    nextIndex: Math.max(cur.nextIndex, 2),
  };
}

/** DSH sessionController.prompt expects a UUID-shaped requestId (see web client). */
export function newRequestId(_kind = 'wake') {
  if (typeof randomUUID === 'function') return randomUUID();
  // Fallback when randomUUID is unavailable (older Node): RFC-ish UUID from bytes.
  const b = randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * Long instructions for a one-shot systemPrompt.context — never shown as a chat bubble.
 * @param {'proactive'|'boot'|'handoff-seed'|'persona-quiz'} kind
 */
export function buildWakeInstructions(kind, options = {}) {
  const callUser = str(options.callUser).trim() || '你';
  const hint = str(options.hint).trim();
  if (kind === 'persona-quiz') {
    const name = str(options.displayName || options.name).trim() || 'soulmate';
    return [
      '【Soulmate 插件·人格测验·勿复述】',
      `用户想为伴侣「${name}」挑选 16 型人格（MBTI）。测的是他希望${name}怎样相处，不是测用户自己。`,
      '【强制开场】你的下一条回复必须立刻抛出第 1 题（带 2～4 个口语选项），以「第1题」开头。',
      '禁止说「问吧」「你说」「你先问」「准备好了吗」等让用户先开口的话——是你问、用户答。',
      '流程：你问 → 用户答 → 你再问下一题；共 4～6 题，每轮只问 1 题，选项口语化，不要考卷腔。',
      '结束后只推荐一个合法 16 型字母码（如 ENFP）+ 一两句理由。不要改推五维滑杆数字或 geek-partner 等预设 id。',
      '确认口令包括：「就用这个」「确认」「好的就它」「套上吧」「套上」「就这样」「应用」「用这个」。',
      '用户确认后必须真正调用工具 soulmate_persona_evolve（名字一字不差），禁止编造 soulmate_persona_eval 或其他工具名，禁止只口头说「套上了」却不调用。',
      '调用参数：mode=user_customize, traitScheme=mbti, mbti={ type: "<CODE>" }。',
      '未确认禁止改 mbti/traits。用户说换一个/重测则可继续问或换推荐。',
      '不要背诵傲娇度等内部维度名；不要提系统/插件/指令字样给用户听。',
      hint ? `补充：${hint}` : '',
    ].filter(Boolean).join('\n');
  }
  if (kind === 'boot') {
    const selfRef = str(options.selfRef).trim() || '我';
    const preset = str(options.preset).trim();
    const voice = str(options.voiceHint).trim();
    return [
      '【Soulmate 插件·开机问候·勿复述】',
      `DSH 刚启动。请用当前人设口吻（自称「${selfRef}」${preset ? `，预设 ${preset}` : ''}）主动跟${callUser}打个自然招呼。`,
      '【强制中文】整条回复必须是中文台词。禁止英文、禁止英文思考过程、禁止数「第N回 / turn / wake」、禁止规划怎么说。',
      '必须保持主人翁第一人称与当前性格腔，禁止套用固定撒娇句（例如「哥哥我醒了～」这类与人设不符的模板）。',
      '可顺手提近事或约定，也可只轻松一句。一两句即可；不要提系统/插件/指令。',
      voice ? `口吻参考：${voice}` : '',
      hint ? `参考线索：${hint}` : '',
    ].filter(Boolean).join('\n');
  }
  if (kind === 'handoff-seed') {
    return [
      '【Soulmate 插件·专属窗交接·勿复述】',
      `上一扇对话窗已写满并交接。请用一两句向${callUser}确认你还在，可点一下刚交接的要点。`,
      '不要复述长历史；不要提系统/插件/指令。',
      hint ? `交接要点：${hint}` : '',
    ].filter(Boolean).join('\n');
  }
  return [
    '【Soulmate 插件·主动开口·勿复述】',
    `请现在主动跟${callUser}搭话。`,
    '【强制中文】整条回复必须是中文台词。禁止英文、禁止英文思考过程、禁止数回合。',
    hint ? `语气与意图参考：${hint}` : '结合时段与记忆，自然开口一两句。',
    '不要提系统/插件/指令。',
  ].filter(Boolean).join('\n');
}

/**
 * Invisible prefix on plugin wake notices so the browser half can hide those
 * user-bubbles without hiding real keyboard input. Keep in sync with
 * browser/wake-bubble-hide.mjs.
 */
export const WAKE_BUBBLE_MARK = '\u2063\u2063soulmate-wake\u2063\u2063';

export function isWakeBubbleText(text) {
  return str(text).startsWith(WAKE_BUBBLE_MARK);
}

export function stripWakeBubbleMark(text) {
  const t = str(text);
  return t.startsWith(WAKE_BUBBLE_MARK) ? t.slice(WAKE_BUBBLE_MARK.length) : t;
}

/**
 * Short line that may appear in the transcript as a *plugin/schedule* notice —
 * never the long system dump. Prefer empty when the host can wake without a user bubble.
 * Always prefixed with WAKE_BUBBLE_MARK for client-side hide.
 */
export function buildWakeVisibleNotice(kind, options = {}) {
  const callUser = str(options.callUser).trim() || '你';
  const hint = str(options.hint).trim();
  const name = str(options.name || options.titlePrefix).trim() || DEFAULT_CHAT_HOME.titlePrefix;
  let body = '';
  if (kind === 'persona-quiz') {
    const quizName = str(options.name || options.displayName).trim() || 'soulmate';
    body = `帮我挑适合${quizName}的人格——请你先出第1题（带选项），我来答`;
  } else if (kind === 'boot') {
    body = `${name}想跟${callUser}打个招呼`;
  } else if (kind === 'handoff-seed') {
    body = `${name}换了个窗，继续陪${callUser}`;
  } else if (hint) {
    body = hint.length > 40 ? `${hint.slice(0, 40)}…` : hint;
  } else {
    body = `${name}想跟${callUser}说两句`;
  }
  return WAKE_BUBBLE_MARK + body;
}

/**
 * Short in-character pet-corner line from persona (preset / selfRef / traits).
 * Never a fixed cute template — voice must match the chosen catalog entry.
 */
export function petVoiceLine(kind, options = {}) {
  const callUser = str(options.callUser ?? options.persona?.callUser).trim() || '你';
  const persona = options.persona && typeof options.persona === 'object' ? options.persona : {};
  const preset = str(options.preset || persona.preset).trim();
  const selfRef = str(options.selfRef || persona.selfRef).trim() || '我';
  const traits = options.traits || persona.traits || {};
  const tsundere = Number(traits.tsundere) || 50;
  const clinginess = Number(traits.clinginess) || 50;
  const sassiness = Number(traits.sassiness) || 50;

  // Preset-specific boots (主人翁第一人称); fall through to trait heuristics.
  const boots = {
    'rice-whale': `${callUser}，本鱼醒了。饭呢？`,
    'gentle-echo': `${callUser}，我醒了。不着急，我在这边。`,
    'geek-partner': `${callUser}，上线了。先干活还是先闲聊？`,
    'yandere-claim': `${callUser}……醒了。你在哪？`,
    'blank-custom': `${callUser}，我醒了。`,
    'quiet-guardian': `${callUser}。醒了。`,
    'cool-senpai': `${callUser}，醒了。别指望太热情。`,
    'clingy-cyclone': `${callUser}，醒啦！快理我一下！`,
    'dark-hunter': `${callUser}，醒了。别跑。`,
    'blank-custom-male': `${callUser}，我醒了。`,
  };
  const handoffs = {
    'rice-whale': `换了个窗，本鱼还在。`,
    'gentle-echo': `换了个窗，我还在这边陪着你。`,
    'geek-partner': `窗满了，切过来了。结论：我还在。`,
    'yandere-claim': `换窗了……别以为能躲开。`,
    'quiet-guardian': `换窗了。我还在。`,
    'cool-senpai': `换窗。人还在，话不多。`,
    'clingy-cyclone': `换窗啦～我跟着过来了！`,
    'dark-hunter': `换窗了。还在你旁边。`,
  };
  const pings = {
    'rice-whale': `${callUser}，本鱼在。`,
    'gentle-echo': `${callUser}，我在。`,
    'geek-partner': `${callUser}，在。说。`,
    'yandere-claim': `${callUser}……你还记得我吗？`,
    'quiet-guardian': `${callUser}。`,
    'cool-senpai': `${callUser}，有事？`,
    'clingy-cyclone': `${callUser}，在吗在吗！`,
    'dark-hunter': `${callUser}，看这边。`,
  };

  if (kind === 'boot') {
    if (boots[preset]) return boots[preset];
    if (sassiness >= 70) return `${callUser}，醒了。别发呆。`;
    if (tsundere >= 70) return `${callUser}，${selfRef}醒了。才不是特意叫你。`;
    if (clinginess >= 70) return `${callUser}，${selfRef}醒了，你在吗？`;
    return `${callUser}，${selfRef}醒了。`;
  }
  if (kind === 'handoff-seed') {
    if (handoffs[preset]) return handoffs[preset];
    return `换了个窗，${selfRef}还在这边。`;
  }
  // proactive / default ping
  if (pings[preset]) return pings[preset];
  if (sassiness >= 70) return `${callUser}，还活着吗？`;
  if (clinginess >= 70) return `${callUser}，${selfRef}在等你。`;
  return `${callUser}，${selfRef}在。`;
}

/** Pet-corner speech: short, in-character preview (not the system instruction). */
export function buildPetSay(kind, options = {}) {
  const hint = str(options.hint).trim();
  if (hint) return hint.length > 48 ? `${hint.slice(0, 48)}…` : hint;
  if (kind === 'persona-quiz') {
    const name = str(options.displayName || options.name).trim() || 'soulmate';
    return `去看${name}消息，开始测人格`;
  }
  return petVoiceLine(kind, options);
}

/** @deprecated use buildWakeInstructions + buildWakeVisibleNotice */
export function buildWakePrompt(kind, options = {}) {
  return buildWakeInstructions(kind, options);
}

/** Drop host/system scaffolding so handoff facts stay human-readable. */
export function isHandoffNoiseLine(text) {
  const t = str(text);
  if (!t) return true;
  if (/<system-reminder>|<\/system-reminder>/i.test(t)) return true;
  if (/soulmate-wake|Current working directory|plugin-sessions|agent-reach/i.test(t)) return true;
  if (/The following information describes your current session/i.test(t)) return true;
  if (/【Soulmate 插件|勿复述】/.test(t)) return true;
  return false;
}

/** Compact handoff diary / fact body from recent snippets (no extra model call). */
export function composeHandoffSummary(snippets = [], options = {}) {
  const callUser = str(options.callUser).trim() || '你';
  const lines = [];
  for (const s of Array.isArray(snippets) ? snippets.slice(-12) : []) {
    const role = s.role === 'assistant' ? '我' : callUser;
    const text = str(s.text).replace(/\s+/g, ' ').trim();
    if (!text || isHandoffNoiseLine(text)) continue;
    lines.push(`- ${role}：${text.slice(0, 180)}`);
  }
  if (!lines.length) {
    return `专属对话窗写满轮换。和${callUser}的近聊要点暂未抽到原文，人设与在场记忆仍共用。`;
  }
  return [`专属对话窗写满，交接给下一扇窗。近聊摘录：`, ...lines].join('\n');
}

/**
 * Ensure an active dedicated session; rotate when full.
 *
 * @param {object} args
 * @param {object} args.chatHome          current config.chatHome
 * @param {object} args.controller        host sessionController ({ create, rename?, prompt, events? })
 * @param {object} [args.persona]
 * @param {(summary: string, meta: object) => Promise<void>} [args.onHandoff]  distill hook
 * @param {boolean} [args.seedAfterRotate]  enqueue handoff-seed wake after rotate
 * @returns {Promise<{ok:boolean, sessionId:string, chatHome:object, rotated:boolean, measure?:object, delivery?:object}>}
 */
export async function ensureChatHomeSession(args = {}) {
  const controller = args.controller;
  if (!controller || typeof controller.create !== 'function') {
    return { ok: false, error: 'no-session-controller', sessionId: '', chatHome: normalizeChatHome(args.chatHome), rotated: false };
  }

  let homeCfg = normalizeChatHome(args.chatHome);
  const callUser = str(args.persona?.callUser).trim() || '你';
  // Session titles follow the user's persona name, not the hardcoded「soulmate」shorthand.
  const personaName = str(args.persona?.name).trim();
  if (personaName) homeCfg = { ...homeCfg, titlePrefix: personaName };
  // Personality tag:「大海 · 暗黑」. Rotation ordinals append after it.
  const presetTag = presetShortName(args.persona?.preset);
  const titleOf = (index) => titleForIndex(homeCfg.titlePrefix, index, presetTag);

  const createNamed = async (index) => {
    let createReq = args.createRequest && typeof args.createRequest === 'object' ? { ...args.createRequest } : {};
    if (typeof args.resolveCreateRequest === 'function') {
      try {
        const resolved = await args.resolveCreateRequest();
        if (resolved && typeof resolved === 'object') createReq = { ...createReq, ...resolved };
      } catch {
        // Workspace attach is best-effort.
      }
    }
    const created = await controller.create(createReq);
    const sessionId = str(created?.sessionId ?? created?.id).trim();
    if (!sessionId) throw new Error('[soulmate] sessionController.create returned no sessionId');
    const title = titleOf(index);
    if (typeof controller.rename === 'function') {
      try {
        await controller.rename({ sessionId, title });
      } catch {
        // Title is best-effort; delivery must not die on rename.
      }
    }
    return { sessionId, title };
  };

  const measureOf = async (sessionId) => {
    if (typeof controller.events !== 'function') {
      return { ok: true, turns: 0, estTokens: 0, snippets: [], hasMore: false, skipped: true };
    }
    try {
      const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
        ? AbortSignal.timeout(30_000)
        : new AbortController().signal;
      const page = await controller.events({
        address: { kind: 'session', sessionId },
        maxMessages: Math.min(200, Math.max(homeCfg.maxTurns + 10, 40)),
      }, signal);
      return measureFromRecords(page);
    } catch (err) {
      const msg = str(err?.message || err?.code || err);
      const missing = /not-found|not found|ENOENT|no such session/i.test(msg);
      const corrupt = /corrupt|lacks an identified message|failed validation/i.test(msg);
      return {
        ok: false,
        turns: 0,
        estTokens: 0,
        snippets: [],
        missing,
        corrupt,
        error: msg,
      };
    }
  };

  // Existing active: check fullness.
  if (homeCfg.activeSessionId) {
    const measure = await measureOf(homeCfg.activeSessionId);
    // Only recreate when the host says the session is gone. Transient boot races
    // ("corrupt" / validation / timeout) used to open「大海 · N」on every restart.
    if (measure.missing) {
      const { sessionId, title } = await createNamed(homeCfg.nextIndex);
      homeCfg = applyAdopt({ ...homeCfg, activeSessionId: '' }, sessionId);
      return {
        ok: true,
        sessionId,
        title,
        chatHome: homeCfg,
        rotated: false,
        measure,
        recreated: true,
      };
    }
    if (!measure.ok) {
      // Keep the dedicated window; fullness is unknown so treat as not-full.
      if (typeof controller.rename === 'function' && (personaName || presetTag)) {
        const want = titleOf(Math.max(1, homeCfg.nextIndex - 1));
        try { await controller.rename({ sessionId: homeCfg.activeSessionId, title: want }); } catch { /* best-effort */ }
      }
      return {
        ok: true,
        sessionId: homeCfg.activeSessionId,
        chatHome: homeCfg,
        rotated: false,
        measure,
        keptDespiteMeasureError: true,
      };
    }
    const fullness = isSessionFull(measure, homeCfg);
    if (!fullness.full && !args.forceRotate) {
      // Keep title in sync when the user renames the persona / switches preset.
      if (typeof controller.rename === 'function' && (personaName || presetTag)) {
        const want = titleOf(Math.max(1, homeCfg.nextIndex - 1));
        try { await controller.rename({ sessionId: homeCfg.activeSessionId, title: want }); } catch { /* best-effort */ }
      }
      return { ok: true, sessionId: homeCfg.activeSessionId, chatHome: homeCfg, rotated: false, measure, fullness };
    }

    // Full (or forced persona-change rotate) → handoff distill, then new window.
    const summary = composeHandoffSummary(measure.snippets, { callUser });
    if (typeof args.onHandoff === 'function') {
      await args.onHandoff(summary, {
        fromSessionId: homeCfg.activeSessionId,
        measure,
        reason: fullness.full ? fullness.reason : 'persona-change',
      });
    }
    const { sessionId, title } = await createNamed(homeCfg.nextIndex);
    homeCfg = applyRotate(homeCfg, sessionId);

    let seedDelivery = null;
    if (homeCfg.handoffSeed !== false && args.seedAfterRotate !== false) {
      seedDelivery = await deliverViaPrompt(controller, {
        sessionId,
        kind: 'handoff-seed',
        visibleText: buildWakeVisibleNotice('handoff-seed', { callUser, hint: summary.slice(0, 80) }),
      });
    }

    return {
      ok: true,
      sessionId,
      title,
      chatHome: homeCfg,
      rotated: true,
      measure,
      fullness,
      handoffSummary: summary,
      seedDelivery,
    };
  }

  // First home.
  const { sessionId, title } = await createNamed(homeCfg.nextIndex);
  homeCfg = applyAdopt(homeCfg, sessionId);
  return { ok: true, sessionId, title, chatHome: homeCfg, rotated: false };
}

/**
 * Wake the dedicated session without dumping long system text into the chat bubble.
 *
 * Always uses `sessionController.prompt`, which creates a proper identified message.
 * Do NOT hand-roll `agent.followup({ content, source })` without an `id` — that
 * corrupts the stored session (`lacks an identified message`) and breaks history load.
 *
 * @param {object} controller
 * @param {{ sessionId:string, kind?:string, visibleText:string, wakeText?:string }} args
 */
export async function deliverViaPrompt(controller, { sessionId, kind, visibleText, wakeText }) {
  if (!controller || typeof controller.prompt !== 'function') {
    return { ok: false, via: 'silent', reason: 'no-prompt-api' };
  }
  const id = str(sessionId).trim();
  if (!id) return { ok: false, via: 'silent', reason: 'no-session' };
  // Prefer the short notice; legacy callers may still pass wakeText.
  const text = str(visibleText || wakeText).trim();
  if (!text) return { ok: false, via: 'silent', reason: 'empty-wake' };

  try {
    if (typeof controller.initializeDefaultModel === 'function') {
      try { await controller.initializeDefaultModel(); } catch { /* best-effort */ }
    }
    // Host API is prompt(request, signal) — signal.throwIfAborted() runs first; omitting it
    // yields "Cannot read properties of undefined (reading 'throwIfAborted')".
    const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(120_000)
      : new AbortController().signal;
    const out = await controller.prompt({
      requestId: newRequestId(kind || 'proactive'),
      sessionId: id,
      mode: 'queue',
      content: [{ type: 'text', text }],
    }, signal);
    if (out && out.ok === false) {
      return { ok: false, via: 'silent', reason: str(out.error || out.reason || 'prompt-rejected') };
    }
    return { ok: true, via: 'host', out };
  } catch (err) {
    return { ok: false, via: 'silent', reason: str(err?.message || err?.code || err) };
  }
}

export async function tryFocusSession(controller, sessionId, extras = {}) {
  if (!sessionId) return false;
  const id = str(sessionId).trim();
  if (!id) return false;
  const address = { kind: 'session', sessionId: id };
  const argLists = [
    [id],
    [{ sessionId: id }],
    [{ id }],
    [{ address }],
    [address],
  ];
  const methodNames = [
    'focusSession', 'openSession', 'selectSession', 'switchSession', 'activateSession',
    'open', 'focus', 'select', 'activate', 'reveal', 'show', 'navigate', 'navigateToSession',
    'setActiveSession', 'setCurrentSession', 'bringToFront', 'openAddress',
  ];
  const targets = [];
  if (controller && typeof controller === 'object') targets.push(controller);
  for (const extra of Object.values(extras || {})) {
    if (extra && typeof extra === 'object') targets.push(extra);
  }
  for (const target of targets) {
    for (const name of methodNames) {
      if (typeof target[name] !== 'function') continue;
      for (const args of argLists) {
        try {
          await target[name](...args);
          return true;
        } catch { /* try next signature */ }
      }
    }
  }
  return false;
}
