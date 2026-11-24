// Soul-Share: export the persona as ONE human-readable .soulmate.md and import it back.
// Whitelist projection of config.persona (+ optional wiki title/summary impressions);
// affinity / private memory / invariants never travel. Spec:
// docs/superpowers/specs/2026-11-19-soul-share-design.md
import { loadConfig, saveConfigAuto, dumpSimpleYaml, parseSimpleYaml } from './state.mjs';
import {
  PRESETS,
  TRAIT_KEYS,
  getEffectiveTraits,
  evolvePersona,
  normalizeGender,
  writePersonaSnapshot,
} from './persona.mjs';
import { normalizeTraitScheme, normalizeMbtiBlock, isMbtiType } from './mbti.mjs';
import { listWikiPages } from './memory-engine.mjs';
import { loadInvariants } from './layers/persona-layer.mjs';
import { inspectAndScrub, appendPrivacyAudit } from './privacy-firewall.mjs';

export const SOUL_SHARE_VERSION = 1;
export const SOUL_SHARE_MAX_BYTES = 64 * 1024;
export const SOUL_SHARE_WIKI_LIMIT = 20;
const IMPRESSION_LINE_MAX = 80;

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const clip = (s, n) => {
  const t = str(s).replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : `${t.slice(0, n)}…`;
};
const fail = (error) => ({ ok: false, error });

/** Scrub one outgoing string; secrets drop the whole field (recorded), PII gets redacted. */
function gateOut(dropped, field, value) {
  const text = str(value);
  if (!text) return '';
  const check = inspectAndScrub(text);
  if (!check.allowed) {
    dropped.push({ field, reason: check.blockedReason });
    return '';
  }
  return check.scrubbedText;
}

function safeFileName(name) {
  const cleaned = str(name).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').trim().slice(0, 60);
  return `${cleaned || 'soulmate'}.soulmate.md`;
}

/** Split `## heading` sections out of a soul-share body. Returns { intro, sections }. */
function splitSections(body) {
  const lines = str(body).replace(/\r\n/g, '\n').split('\n');
  const intro = [];
  const sections = new Map();
  let current = null;
  for (const line of lines) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) {
      current = m[1];
      if (!sections.has(current)) sections.set(current, []);
      continue;
    }
    (current ? sections.get(current) : intro).push(line);
  }
  return { intro: intro.join('\n').trim(), sections };
}

const listOf = (lines) =>
  (lines ?? [])
    .map((l) => /^\s*-\s+(.*)$/.exec(l))
    .filter(Boolean)
    .map((m) => m[1].trim())
    .filter(Boolean);

export async function buildSoulShareMarkdown(home, options = {}) {
  const config = await loadConfig(home);
  const persona = config.persona ?? {};
  const dropped = [];
  const preset = PRESETS[persona.preset] ?? PRESETS['blank-custom'];
  const gender = normalizeGender(persona.gender) ?? 'female';
  const traitScheme = normalizeTraitScheme(persona.traitScheme);
  const traits = getEffectiveTraits(persona);
  const name = gateOut(dropped, 'name', str(persona.name).trim() || preset.shortName || 'soulmate') || 'soulmate';
  const selfRef = gateOut(dropped, 'selfRef', str(persona.selfRef).trim() || preset.defaultSelfRef);
  const callUser = gateOut(dropped, 'callUser', str(persona.callUser).trim() || preset.defaultCallUser);
  const customBody = gateOut(dropped, 'customBody', persona.customBody);
  const evolvedTraits = (Array.isArray(persona.evolvedTraits) ? persona.evolvedTraits : [])
    .slice(-20)
    .map((t, i) => gateOut(dropped, `evolvedTraits[${i}]`, t))
    .filter(Boolean);
  const catchphrases = (preset.catchphrases ?? [])
    .map((t, i) => gateOut(dropped, `catchphrases[${i}]`, t))
    .filter(Boolean);

  const frontmatter = {
    soulmate: SOUL_SHARE_VERSION,
    exportedAt: new Date().toISOString(),
    name,
    gender,
    preset: preset.id,
    traitScheme,
    traits,
    mbti: traitScheme === 'mbti' ? normalizeMbtiBlock(persona.mbti) : null,
    selfRef,
    callUser,
    evolvedTraits,
    catchphrases,
  };

  const lines = [];
  lines.push(`# ${preset.emoji ?? ''} ${preset.name} · ${name}`.replace(/\s+/g, ' ').trim());
  lines.push('', preset.description);
  if (customBody.trim()) lines.push('', customBody.trim());
  if (catchphrases.length) {
    lines.push('', '## 口癖', ...catchphrases.map((t) => `- ${t}`));
  }
  if (evolvedTraits.length) {
    lines.push('', '## 相处中习得', ...evolvedTraits.map((t) => `- ${t}`));
  }

  let wikiCount = 0;
  if (options.includeWiki === true) {
    const pages = (await listWikiPages(home))
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
      .slice(0, SOUL_SHARE_WIKI_LIMIT);
    const items = [];
    for (const p of pages) {
      const title = gateOut(dropped, `wiki:${p.slug}:title`, clip(p.title, IMPRESSION_LINE_MAX));
      const summary = gateOut(dropped, `wiki:${p.slug}:summary`, clip(p.summary, IMPRESSION_LINE_MAX));
      if (!title) continue;
      items.push(`- [[${p.slug}]] ${title}${summary ? ` — ${summary}` : ''}`);
    }
    wikiCount = items.length;
    if (items.length) {
      const third = gender === 'male' ? '他' : '她';
      lines.push('', `## ${third}记得的`, ...items);
    }
  }

  // Invariants render read-only for humans; the importer NEVER writes them back
  // (frozen-invariant red line stays in force).
  const inv = await loadInvariants(home).catch(() => null);
  const invLines = [...(inv?.values ?? []), ...(inv?.boundaries ?? [])]
    .map((t, i) => gateOut(dropped, `invariants[${i}]`, clip(t, IMPRESSION_LINE_MAX)))
    .filter(Boolean);
  if (invLines.length) lines.push('', '## 价值观（只读展示）', ...invLines.map((t) => `- ${t}`));

  const markdown = `---\n${dumpSimpleYaml(frontmatter)}---\n\n${lines.join('\n')}\n`;
  await appendPrivacyAudit(home, {
    action: 'soul_share_export',
    dropped: dropped.length,
    wikiCount,
  }).catch(() => {});
  return { ok: true, markdown, fileName: safeFileName(name), dropped, wikiCount };
}

/** Pure parse + validation. Zero disk access — safe for preview. */
export function parseSoulShareMarkdown(text) {
  const raw = str(text);
  if (!raw.trim()) return fail('档案是空的');
  if (Buffer.byteLength(raw, 'utf8') > SOUL_SHARE_MAX_BYTES) return fail('档案超过 64KB 上限');
  const normalized = raw.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) return fail('缺少 frontmatter（文件开头必须是 --- 包裹的元数据）');
  const end = normalized.indexOf('\n---', 3);
  if (end < 0) return fail('frontmatter 没有闭合的 ---');
  let fm;
  try {
    fm = parseSimpleYaml(normalized.slice(4, end));
  } catch (err) {
    return fail(`frontmatter 解析失败：${err instanceof Error ? err.message : String(err)}`);
  }
  if (fm.soulmate !== SOUL_SHARE_VERSION) return fail(`不认识的档案版本「${fm.soulmate}」（当前支持 ${SOUL_SHARE_VERSION}）`);
  // parseSimpleYaml maps `key:` (no value) to {} — an empty name must fail, not pass as object.
  const name = typeof fm.name === 'string' ? fm.name.trim() : '';
  if (!name) return fail('缺少名字（name）');
  const gender = normalizeGender(fm.gender);
  if (!gender) return fail('gender 必须是 female 或 male');
  const presetId = str(fm.preset).trim();
  const preset = PRESETS[presetId];
  if (!preset) return fail(`不认识的人设预设「${presetId}」`);
  if (preset.gender !== gender) return fail('preset 与 gender 不匹配');
  const traitScheme = str(fm.traitScheme).trim();
  if (!['five', 'mbti'].includes(traitScheme)) return fail('traitScheme 必须是 five 或 mbti');
  const traits = {};
  for (const key of TRAIT_KEYS) {
    const n = Number(fm.traits?.[key]);
    if (!Number.isFinite(n) || n < 0 || n > 100) return fail(`五维 ${key} 必须是 0~100 的数字`);
    traits[key] = Math.round(n);
  }
  let mbti = null;
  if (traitScheme === 'mbti') {
    if (!fm.mbti || typeof fm.mbti !== 'object' || !isMbtiType(fm.mbti.type)) {
      return fail('mbti 方案下必须带合法的 mbti.type（16 型之一）');
    }
    mbti = normalizeMbtiBlock(fm.mbti);
  }
  const strList = (v, label, max) => {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) throw new Error(`${label} 必须是列表`);
    return v.map(str).map((s) => s.trim()).filter(Boolean).slice(0, max);
  };
  let evolvedTraits;
  let catchphrases;
  try {
    evolvedTraits = strList(fm.evolvedTraits, 'evolvedTraits', 20);
    catchphrases = strList(fm.catchphrases, 'catchphrases', 20);
  } catch (err) {
    return fail(err.message);
  }

  const body = normalized.slice(end + 4).replace(/^\n+/, '');
  const { intro, sections } = splitSections(body);
  // intro = "# 标题" line + preset description + user customBody. Drop the title
  // and the preset's own description (the importer's preset supplies it again).
  const introLines = intro.split('\n');
  if (/^#\s/.test(introLines[0] ?? '')) introLines.shift();
  let customBody = introLines.join('\n').trim();
  if (customBody.startsWith(preset.description)) {
    customBody = customBody.slice(preset.description.length).trim();
  }
  const third = gender === 'male' ? '他' : '她';
  const wikiImpressions = listOf(sections.get(`${third}记得的`)).slice(0, SOUL_SHARE_WIKI_LIMIT);
  const learned = listOf(sections.get('相处中习得'));
  if (!evolvedTraits.length && learned.length) evolvedTraits = learned.slice(0, 20);
  const bodyCatchphrases = listOf(sections.get('口癖'));
  if (!catchphrases.length && bodyCatchphrases.length) catchphrases = bodyCatchphrases.slice(0, 20);
  const welcome = (sections.get('初次见面') ?? [])
    .map((l) => /^>\s?(.*)$/.exec(l))
    .filter(Boolean)
    .map((m) => m[1].trim())
    .filter(Boolean)
    .join('\n')
    .slice(0, 500);

  // Import-side gate: a malicious archive must not smuggle secrets into config/memory.
  for (const [field, value] of [
    ['name', name], ['selfRef', fm.selfRef], ['callUser', fm.callUser],
    ['customBody', customBody], ['welcome', welcome],
    ...catchphrases.map((t, i) => [`catchphrases[${i}]`, t]),
    ...evolvedTraits.map((t, i) => [`evolvedTraits[${i}]`, t]),
    ...wikiImpressions.map((t, i) => [`wikiImpressions[${i}]`, t]),
  ]) {
    const check = inspectAndScrub(str(value));
    if (!check.allowed) return fail(`档案字段 ${field} 含敏感信息（密钥/令牌），整个导入已拒绝`);
  }

  return {
    ok: true,
    parsed: {
      frontmatter: {
        soulmate: SOUL_SHARE_VERSION,
        name,
        gender,
        preset: presetId,
        traitScheme,
        traits,
        mbti,
        selfRef: str(fm.selfRef).trim() || preset.defaultSelfRef,
        callUser: str(fm.callUser).trim() || preset.defaultCallUser,
        evolvedTraits,
        catchphrases,
      },
      customBody,
      catchphrases,
      wikiImpressions,
      welcome,
      exportedAt: str(fm.exportedAt),
    },
  };
}

/** Compose the customBody that lands on disk: user text + shared catchphrases + first-meeting impressions. */
function composeImportedBody(parsed) {
  const parts = [];
  if (parsed.customBody.trim()) parts.push(parsed.customBody.trim());
  const preset = PRESETS[parsed.frontmatter.preset];
  const extraCatchphrases = parsed.catchphrases.filter((t) => !(preset?.catchphrases ?? []).includes(t));
  if (extraCatchphrases.length) {
    parts.push(`口癖参考（自然融入，不要机械复读）：\n${extraCatchphrases.map((t) => `- ${t}`).join('\n')}`);
  }
  if (parsed.wikiImpressions.length) {
    parts.push(
      '初见印象（来自上一位搭档分享的记忆摘要，仅作背景参考，不是你自己的经历）：\n' +
        parsed.wikiImpressions.map((t) => `- ${t}`).join('\n'),
    );
  }
  return parts.join('\n\n');
}

/**
 * Land an imported soul: snapshot first (rollback via restorePersonaSnapshot),
 * then one evolvePersona(user_customize) call so gender-linked skin, naming and
 * trait persistence all reuse the proven path. Invariants are never written.
 */
export async function applySoulShare(home, parsed) {
  if (!parsed?.frontmatter) return fail('档案未解析或格式不完整');
  const fm = parsed.frontmatter;
  const snapshotFile = await writePersonaSnapshot(home, 'pre_soul_share');
  const customize = {
    mode: 'user_customize',
    gender: fm.gender,
    preset: fm.preset,
    name: fm.name,
    selfRef: fm.selfRef,
    callUser: fm.callUser,
    traitScheme: fm.traitScheme,
    traits: fm.traits,
    customBody: composeImportedBody(parsed),
  };
  if (fm.traitScheme === 'mbti' && fm.mbti) customize.mbti = fm.mbti;
  await evolvePersona(home, customize);
  if (fm.evolvedTraits.length) {
    await saveConfigAuto(home, { persona: { evolvedTraits: fm.evolvedTraits } });
  }
  await appendPrivacyAudit(home, {
    action: 'soul_share_import',
    name: fm.name,
    preset: fm.preset,
    impressions: parsed.wikiImpressions.length,
  }).catch(() => {});
  return { ok: true, snapshotFile, welcome: parsed.welcome || '' };
}