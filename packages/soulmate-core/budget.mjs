// Cognitive budget: the panel has always shown "Identity 15% / Relationship 10% /
// Memory 45%" as a picture of a promise. These helpers turn that picture into a
// measurement of the prompt actually being sent, so at least the part that can grow
// without bound is enforced instead of merely displayed.
//
// Why only `memory` is treated as a hard ceiling: identity (persona body, traits, the
// co-pilot protocol) and relationship (bond stage, invariants) are *authored constants* —
// they have a fixed size that does not depend on how long the user has been talking. A
// fixed 15% cut of an arbitrary prompt is therefore not a target anyone can hit, and
// flagging it would be noise. Recall hits are the one block that grows forever as facts
// accumulate, so that is where a budget can actually change behaviour.
//
// Dependency-free on purpose: `status.mjs` and `index.mjs` both import it, and it must
// not drag the prompt builders (persona.mjs) into that cycle.

/** Percent of the context the design §4 allocates to each block. */
export const CONTEXT_BUDGET = Object.freeze({
  identity: 15,
  relationship: 10,
  memory: 45,
  reserved: 30,
});

/** Blocks that are reported, in display order. */
const SHARE_KEYS = Object.freeze(['identity', 'relationship', 'memory']);

/** Blocks whose overflow is worth flagging (see the note at the top of this file). */
const ENFORCED_KEYS = Object.freeze(['memory']);

/** A very rough but stable token estimate: CJK chars are ~1 token each, latin ~4 chars. */
export function estimateTokens(text) {
  const s = String(text ?? '');
  if (!s) return 0;
  let cjk = 0;
  let latin = 0;
  // Iterate code points, not UTF-16 units, so an emoji is not counted twice.
  for (const ch of s) {
    if (ch.codePointAt(0) >= 0x2e80) cjk += 1;
    else latin += 1;
  }
  return Math.ceil(cjk + latin / 4);
}

/** Which budget bucket a markdown heading belongs to. */
export function classifyHeading(title) {
  const h = String(title ?? '');
  if (/记忆|memory|小本本|wiki|召回|知识/i.test(h)) return 'memory';
  // 关系/羁绊类标题：「当前状态」本身是身份+关系混合，其下的关系读数由 classifyLine 逐行接管，
  // 所以这里只把明确讲羁绊的标题归到 relationship。
  if (/关系|relationship|亲密度|bond|默契|不变量|危机|承诺/i.test(h)) return 'relationship';
  return 'identity';
}

/** Which bucket a single non-heading line belongs to, refined line by line. */
function classifyLine(line, inherited) {
  // A relationship *reading* can sit under a plain "当前状态" heading, e.g.
  // "关系阶段：Lv.3 亲密", "亲密度 42", "- 心情：…；精力：80/100". Only a line that
  // *opens* with such a field is a reading; a sentence that merely mentions 亲密度 in
  // passing (the diary blurb) must stay where its heading put it.
  const t = line.trim().replace(/^[-*]\s*/, '');
  if (/^(关系阶段|亲密度|bond\s*stage|warmth|trust)\s*[:：]/.test(t)) return 'relationship';
  if (/^关系\s*[:：]/.test(t)) return 'relationship';
  return inherited;
}

/**
 * Split a built prompt into the three budgeted blocks.
 *
 * The prompt is assembled as flat markdown, so the split follows its headings (with a
 * per-line override for relationship readings) rather than byte offsets: that keeps the
 * measurement honest when sections are added or reordered.
 *
 * @param {string} prompt the full system prompt text
 * @returns {{identity:string, relationship:string, memory:string, other:string}}
 */
export function splitPromptBlocks(prompt) {
  const text = String(prompt ?? '');
  const blocks = { identity: [], relationship: [], memory: [], other: [] };
  let inherited = 'identity';
  for (const line of text.split(/\r?\n/)) {
    const heading = /^#{1,3}\s*(.+)$/.exec(line.trim());
    if (heading) inherited = classifyHeading(heading[1]);
    blocks[classifyLine(line, inherited)].push(line);
  }
  const join = (list) => list.join('\n').trim();
  return {
    identity: join(blocks.identity),
    relationship: join(blocks.relationship),
    memory: join(blocks.memory),
    other: join(blocks.other),
  };
}

/**
 * Measure a built prompt against the budget.
 *
 * Percentages are of the prompt itself (not of an unknown model window), so the number
 * is always meaningful: "memory takes 62% of what we send" is a fact, while "memory uses
 * 28K of a 128K window" depends on a guess about the host.
 *
 * @param {string} prompt
 * @param {{budget?:object}} [options]
 */
export function measurePromptBudget(prompt, options = {}) {
  const blocks = splitPromptBlocks(prompt);
  const budget = { ...CONTEXT_BUDGET, ...(options.budget ?? {}) };
  const tokens = {
    identity: estimateTokens(blocks.identity),
    relationship: estimateTokens(blocks.relationship),
    memory: estimateTokens(blocks.memory),
    other: estimateTokens(blocks.other),
  };
  const total = tokens.identity + tokens.relationship + tokens.memory + tokens.other;
  const share = (n) => (total > 0 ? Math.round((n / total) * 1000) / 10 : 0);

  const measured = {};
  const over = [];
  for (const key of SHARE_KEYS) {
    measured[key] = { tokens: tokens[key], share: share(tokens[key]), budget: budget[key] };
  }
  measured.other = { tokens: tokens.other, share: share(tokens.other) };
  for (const key of ENFORCED_KEYS) {
    if (measured[key].share > budget[key]) over.push(key);
  }

  const labelOf = { identity: '身份', relationship: '关系', memory: '记忆' };
  return {
    ok: true,
    totalTokens: total,
    chars: String(prompt ?? '').length,
    measured,
    overBudget: over,
    withinBudget: over.length === 0,
    note:
      total === 0
        ? '还没有可统计的对话内容。'
        : over.length === 0
          ? '记忆占比正常。'
          : `记忆占比偏高：${over.map((k) => `${labelOf[k] || k} ${measured[k].share}%（目标 ${budget[k]}%）`).join('、')}`,
  };
}

function defaultRender(items) {
  return items.map((it) => `- ${it?.text ?? it?.topic ?? ''}`).join('\n');
}

/**
 * Rank recall hits for trimming (v3 §11).
 *
 * The old contract said "callers pass hits already sorted by score desc" — nobody did, and
 * the loop kept whatever came first. Trimming then dropped the *tail* of an unordered list,
 * which is exactly the memory a companion should protect: an old, deeply-bonded one sitting
 * behind three trivial fresh rows.
 *
 * So ranking lives here, next to the cut. Freshness still counts, but salience and the bond
 * class dominate, and presence-class memories (preferences, promises) are never the first to go.
 *
 * @param {object[]} items recall hits in arbitrary order
 * @param {{nowMs?:number}} [options] pass `nowMs` to enable ranking
 */
export function rankForTrim(items, options = {}) {
  const list = Array.isArray(items) ? items : [];
  const nowMs = Number(options.nowMs ?? 0);
  if (!nowMs) return list.slice();
  return list
    .map((item, index) => ({ item, index, score: trimScore(item, nowMs) }))
    .sort((a, b) => (b.score - a.score) || (a.index - b.index))
    .map((entry) => entry.item);
}

function trimScore(item, nowMs) {
  const salience = Number(item?.salience ?? item?.importance ?? 0.5) || 0;
  const cls = String(item?.decayClass ?? 'fact');
  const floor = trimFloor(cls);
  const t = Date.parse(String(item?.t ?? item?.at ?? ''));
  let recency = 0.5;
  if (Number.isFinite(t)) {
    const ageDays = Math.max(0, (nowMs - t) / 86400_000);
    recency = 1 / (1 + ageDays / 90);
  }
  return salience * 0.6 + recency * 0.25 + floor * 0.15;
}

/** Trim floors are deliberately *inverted* against decay trimRank: rank 1 = cheapest to drop. */
function trimFloor(cls) {
  switch (cls) {
    case 'promise': return 1;
    case 'preference': return 0.95;
    case 'fact': return 0.7;
    case 'event': return 0.5;
    case 'emotion': return 0.35;
    default: return 0.6;
  }
}

/**
 * Trim a memory digest so its share stays inside the budget.
 *
 * Recall results are the only block that grows without bound (facts accumulate forever),
 * so this is the one place where enforcement is actually possible: drop the lowest-scoring
 * items until the rendered block fits. Without a clock there is nothing to rank against, so
 * the historical keep-in-order behaviour stands.
 *
 * @param {object[]} items recall hits
 * @param {{maxChars?:number, render?:(items:object[])=>string, nowMs?:number}} [options]
 */
export function fitMemoryDigest(items, options = {}) {
  const render = typeof options.render === 'function' ? options.render : defaultRender;
  const maxChars = Math.max(0, Number(options.maxChars ?? 0)) || Infinity;
  const list = rankForTrim(items, options);
  const kept = [];
  for (const item of list) {
    kept.push(item);
    if (render(kept).length > maxChars) {
      kept.pop();
      break;
    }
  }
  return { items: kept, dropped: list.length - kept.length, chars: render(kept).length };
}

/** Human-readable snapshot for the engine panel (`contextBudget` in /api/state). */
export function describeBudget(prompt) {
  const m = measurePromptBudget(prompt);
  return {
    ...CONTEXT_BUDGET,
    measured: m.measured,
    totalTokens: m.totalTokens,
    overBudget: m.overBudget,
    withinBudget: m.withinBudget,
    note: m.totalTokens > 0 ? `${m.note}（约 ${m.totalTokens}）` : m.note,
  };
}