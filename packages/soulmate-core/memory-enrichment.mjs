/**
 * Memory neural enrichment helpers — first-person (主人翁) auto-writes.
 * Wired from index.mjs (onboard / evolve / interact / promise) via enrichSafe.
 */
import {
  retainFact,
  reflectToWiki,
  loadFacts,
  listWikiPages,
} from './memory-engine.mjs';

const BOND_TITLES = Object.freeze({
  1: '初遇室友',
  2: '投喂饭搭子',
  3: '默契副驾',
  4: '深海知己',
  5: '灵魂伴侣 (Soulmate)',
});

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));

const isLive = (f) => !!f && !f.deletedAt && !f.invalidatedAt && !f.invalidatedBy;

async function findLiveByTopic(home, topic) {
  const { pub, priv } = await loadFacts(home);
  return [...pub, ...priv].find((f) => f.topic === topic && isLive(f)) || null;
}

function genderVoiceLine(gender, selfRef) {
  const me = str(selfRef).trim() || '我';
  if (gender === 'male') return `${me === '我' ? '我' : `我（${me}）`}现在是男声线，旁白用「他」。`;
  if (gender === 'female') return `${me === '我' ? '我' : `我（${me}）`}现在是女声线，旁白用「她」。`;
  return `${me === '我' ? '我' : `我（${me}）`}现在是中性声线。`;
}

function identityLines(persona = {}) {
  const displayName = str(persona.name || persona.displayName).trim() || 'soulmate';
  const callUser = str(persona.callUser).trim() || '你';
  const selfRef = str(persona.selfRef).trim() || '我';
  const gender = persona.gender === 'male' || persona.gender === 'female' ? persona.gender : null;
  return [
    {
      topic: 'identity:call-user',
      id: 'f_identity_call_user',
      content: `我叫你「${callUser}」。`,
    },
    {
      topic: 'identity:self-ref',
      id: 'f_identity_self_ref',
      content: `我自称「${selfRef}」。`,
    },
    {
      topic: 'identity:display-name',
      id: 'f_identity_display_name',
      content: `我的名字是「${displayName}」。`,
    },
    {
      topic: 'identity:gender-voice',
      id: 'f_identity_gender_voice',
      content: genderVoiceLine(gender, selfRef),
    },
  ];
}

/**
 * Upsert never-decay identity preference anchors. Re-writes supersede by topic.
 */
export async function upsertIdentityAnchors(home, persona = {}, options = {}) {
  const nowMs = options.nowMs;
  const results = [];
  for (const row of identityLines(persona)) {
    const prev = await findLiveByTopic(home, row.topic);
    if (prev && prev.content === row.content) {
      results.push({ ok: true, fact: prev, unchanged: true });
      continue;
    }
    const res = await retainFact(home, {
      id: prev ? undefined : row.id,
      topic: row.topic,
      content: row.content,
      decayClass: 'preference',
      category: 'preference',
      importance: 5,
      supersedesId: prev?.id,
      nowMs,
      provenance: { source: 'identity-anchor' },
    });
    results.push(res);
  }
  const taboo = str(persona.addressTaboo || persona.address_taboo).trim();
  if (taboo) {
    const topic = 'identity:address-taboo';
    const content = `我记住称呼雷区：${taboo}`;
    const prev = await findLiveByTopic(home, topic);
    if (!prev || prev.content !== content) {
      results.push(
        await retainFact(home, {
          id: prev ? undefined : 'f_identity_address_taboo',
          topic,
          content,
          decayClass: 'preference',
          category: 'preference',
          importance: 5,
          supersedesId: prev?.id,
          nowMs,
          provenance: { source: 'identity-anchor' },
        })
      );
    }
  }
  return { ok: results.every((r) => r.ok !== false), results };
}

/**
 * Relationship stage crossing → short first-person milestone event.
 */
export async function recordBondMilestone(home, input = {}) {
  const toLevel = Number(input.toLevel) || 0;
  const title = str(input.title).trim() || BOND_TITLES[toLevel] || `Lv.${toLevel}`;
  const callUser = str(input.callUser).trim() || '你';
  const content = `我跟${callUser}的关系走到了「${title}」。`;
  return retainFact(home, {
    topic: `milestone:bond-lv${toLevel}`,
    content,
    decayClass: 'event',
    category: 'milestone',
    importance: 5,
    nowMs: input.nowMs,
    provenance: {
      source: 'bond-milestone',
      fromLevel: input.fromLevel ?? null,
      toLevel,
      displayName: str(input.displayName).trim() || null,
    },
  });
}

/**
 * Append a first-person self-arc wiki entry (slug self-arc).
 */
export async function appendSelfArc(home, input = {}) {
  const persona = input.persona && typeof input.persona === 'object' ? input.persona : {};
  const reason = str(input.reason).trim() || '有点变化';
  const stamp = new Date(Number.isFinite(Number(input.nowMs)) ? Number(input.nowMs) : Date.now()).toISOString().slice(0, 10);
  const entry = `我最近……${reason}（${stamp}）`;

  const pages = await listWikiPages(home);
  const existing = pages.find((p) => p.slug === 'self-arc');
  const content = existing?.content?.trim() ? `${existing.content.trim()}\n\n${entry}` : entry;
  const displayName = str(persona.name || persona.displayName).trim() || 'soulmate';

  return reflectToWiki(home, {
    slug: 'self-arc',
    title: `${displayName}的自我演变`,
    summary: '主人翁第一人称自述',
    category: 'self-arc',
    content,
    nowMs: input.nowMs,
  });
}

/**
 * One-shot legacy rename: pre-0.2.35 installs hardcoded「大肥鱼」as the companion
 * shorthand in identity anchors, the self-arc wiki title and the chat-home title
 * prefix. Rewrite those rows to「soulmate」(or the persona's own name) on boot so the
 * neural graph / presence / window titles stop echoing the old fish name. Idempotent:
 * once no row carries the legacy string, every later boot is a cheap read-only scan.
 */
export async function migrateLegacyDisplayName(home, persona = {}, options = {}) {
  const LEGACY = '大肥鱼';
  const fallback = str(persona.name || persona.displayName).trim() || 'soulmate';
  const out = { facts: 0, wiki: 0, config: 0 };

  const { pub, priv } = await loadFacts(home);
  for (const [rows, isPrivate] of [[pub, false], [priv, true]]) {
    for (const f of rows) {
      if (!isLive(f)) continue;
      const content = str(f.content);
      const topic = str(f.topic);
      if (!content.includes(LEGACY) && !topic.includes(LEGACY)) continue;
      const nextContent = content.split(LEGACY).join(fallback);
      const nextTopic = topic.split(LEGACY).join(fallback);
      await retainFact(home, {
        topic: nextTopic,
        content: nextContent,
        visibility: isPrivate ? 'private' : 'syncable',
        decayClass: f.decayClass || 'preference',
        category: f.category || 'preference',
        importance: f.importance ?? 5,
        supersedesId: f.id,
        nowMs: options.nowMs,
        provenance: { source: 'legacy-rename', replaces: f.id },
      });
      out.facts += 1;
    }
  }

  const pages = await listWikiPages(home);
  for (const p of pages) {
    const title = str(p.title);
    const content = str(p.content);
    if (!title.includes(LEGACY) && !content.includes(LEGACY)) continue;
    await reflectToWiki(home, {
      slug: p.slug,
      title: title.split(LEGACY).join(fallback),
      summary: p.summary,
      category: p.category,
      content: content.split(LEGACY).join(fallback),
      nowMs: options.nowMs,
    });
    out.wiki += 1;
  }
  return out;
}

/**
 * Never-decay boundary preference (topic boundary:<suffix>).
 */
export async function retainBoundary(home, input = {}) {
  const suffix = str(input.topicSuffix || input.suffix)
    .trim()
    .replace(/^boundary:/, '');
  if (!suffix) return { ok: false, error: 'topicSuffix is required' };
  const content = str(input.content).trim();
  if (!content) return { ok: false, error: 'content is required' };
  const topic = `boundary:${suffix}`;
  const prev = await findLiveByTopic(home, topic);
  if (prev && prev.content === content) return { ok: true, fact: prev, unchanged: true };
  return retainFact(home, {
    topic,
    content,
    decayClass: 'preference',
    category: 'preference',
    importance: 5,
    evidence: Array.isArray(input.evidence) ? input.evidence : undefined,
    supersedesId: prev?.id,
    nowMs: input.nowMs,
    provenance: { source: 'boundary' },
  });
}

/**
 * Habit / ritual preference (or event if decayClass requested).
 */
export async function retainRitual(home, input = {}) {
  let topic = str(input.topic).trim();
  if (!topic) return { ok: false, error: 'topic is required' };
  if (!topic.startsWith('ritual:')) topic = `ritual:${topic}`;
  const content = str(input.content).trim();
  if (!content) return { ok: false, error: 'content is required' };
  const decayClass = input.decayClass === 'event' ? 'event' : 'preference';
  const prev = decayClass === 'preference' ? await findLiveByTopic(home, topic) : null;
  if (prev && prev.content === content) return { ok: true, fact: prev, unchanged: true };
  return retainFact(home, {
    topic,
    content,
    decayClass,
    category: decayClass === 'event' ? 'event' : 'preference',
    importance: Number.isFinite(Number(input.importance)) ? Number(input.importance) : 4,
    supersedesId: prev?.id,
    nowMs: input.nowMs,
    provenance: { source: 'ritual' },
  });
}

/**
 * Short first-person emotion undertone for Presence.
 */
export async function retainEmotionUndertone(home, input = {}) {
  const content = str(input.content).trim();
  if (!content) return { ok: false, error: 'content is required' };
  return retainFact(home, {
    topic: str(input.topic).trim() || 'emotion:undertone',
    content,
    decayClass: 'emotion',
    category: 'emotion',
    importance: Number.isFinite(Number(input.importance)) ? Number(input.importance) : 3,
    visibility: input.visibility === 'private' ? 'private' : 'syncable',
    nowMs: input.nowMs,
    provenance: { source: 'emotion-undertone' },
  });
}

export { BOND_TITLES };
