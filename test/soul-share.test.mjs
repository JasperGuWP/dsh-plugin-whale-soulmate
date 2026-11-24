import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveSoulmateHome, loadConfig, saveConfigAuto } from '../packages/soulmate-core/state.mjs';
import { evolvePersona, restorePersonaSnapshot, PRESETS } from '../packages/soulmate-core/persona.mjs';
import { loadInvariants } from '../packages/soulmate-core/layers/persona-layer.mjs';
import { retainFact, reflectToWiki, listWikiPages } from '../packages/soulmate-core/memory-engine.mjs';
import {
  buildSoulShareMarkdown,
  parseSoulShareMarkdown,
  applySoulShare,
  SOUL_SHARE_MAX_BYTES,
  SOUL_SHARE_VERSION,
} from '../packages/soulmate-core/soul-share.mjs';

async function withHome(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'soulmate-share-'));
  try {
    return await fn(resolveSoulmateHome(dir), dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function seedPersona(home, extra = {}) {
  await evolvePersona(home, {
    mode: 'user_customize',
    gender: 'female',
    preset: 'rice-whale',
    name: '大海',
    selfRef: '本鱼',
    callUser: '搭档',
    ...extra,
  });
}

const snapshotTree = async (dir, out = {}) => {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) await snapshotTree(full, out);
    else out[full] = await readFile(full, 'utf8');
  }
  return out;
};

test('soul-share: round-trip five-trait persona keeps every shared field', async () => {
  await withHome(async (home) => {
    await seedPersona(home, {
      traits: { tsundere: 82, clinginess: 58, sassiness: 66, curiosity: 71, brevity: 63 },
      customBody: '她最近在学做寿司，失败会嘴硬说是米饭的问题。',
    });
    const { markdown, fileName, dropped } = await buildSoulShareMarkdown(home, {});
    assert.deepEqual(dropped, []);
    assert.equal(fileName, '大海.soulmate.md');
    const parsed = parseSoulShareMarkdown(markdown);
    assert.equal(parsed.ok, true);
    const fm = parsed.parsed.frontmatter;
    assert.equal(fm.soulmate, SOUL_SHARE_VERSION);
    assert.equal(fm.name, '大海');
    assert.equal(fm.gender, 'female');
    assert.equal(fm.preset, 'rice-whale');
    assert.equal(fm.traitScheme, 'five');
    assert.deepEqual(fm.traits, { tsundere: 82, clinginess: 58, sassiness: 66, curiosity: 71, brevity: 63 });
    assert.equal(fm.selfRef, '本鱼');
    assert.equal(fm.callUser, '搭档');
    assert.match(parsed.parsed.customBody, /学做寿司/);
    assert.ok(parsed.parsed.catchphrases.length > 0, 'preset catchphrases exported');
  });
});

test('soul-share: round-trip mbti scheme keeps type and axes', async () => {
  await withHome(async (home) => {
    // Scheme switch derives mbti from current traits; the explicit edit then pins INTJ
    // (same two-step the panel uses — a combined call lets the switch overwrite the edit).
    await seedPersona(home, { traitScheme: 'mbti' });
    await evolvePersona(home, {
      mode: 'user_customize',
      mbti: { type: 'INTJ', axes: { EI: 78, SN: 78, TF: 22, JP: 22 } },
    });
    const { markdown } = await buildSoulShareMarkdown(home, {});
    const parsed = parseSoulShareMarkdown(markdown);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.parsed.frontmatter.traitScheme, 'mbti');
    assert.equal(parsed.parsed.frontmatter.mbti.type, 'INTJ');
    assert.equal(typeof parsed.parsed.frontmatter.mbti.axes.EI, 'number');
  });
});

test('soul-share: mbti archive imported onto a five-scheme persona keeps type, axes and traits', async () => {
  await withHome(async (home) => {
    await seedPersona(home, { traitScheme: 'mbti' });
    await evolvePersona(home, {
      mode: 'user_customize',
      mbti: { type: 'INTJ', axes: { EI: 78, SN: 78, TF: 22, JP: 22 } },
    });
    const { markdown } = await buildSoulShareMarkdown(home, {});
    const parsed = parseSoulShareMarkdown(markdown);
    const sharedTraits = parsed.parsed.frontmatter.traits;
    await evolvePersona(home, {
      mode: 'user_customize',
      traitScheme: 'five',
      traits: { tsundere: 10, clinginess: 10, sassiness: 10, curiosity: 10, brevity: 10 },
    });
    const res = await applySoulShare(home, parsed.parsed);
    assert.equal(res.ok, true);
    const conf = await loadConfig(home);
    assert.equal(conf.persona.traitScheme, 'mbti');
    assert.equal(conf.persona.mbti.type, 'INTJ');
    assert.deepEqual(conf.persona.mbti.axes, { EI: 78, SN: 78, TF: 22, JP: 22 });
    assert.deepEqual(conf.persona.traits, sharedTraits);
  });
});

test('soul-share: whitelist — no affinity, deltas, private memory or facts in the file', async () => {
  await withHome(async (home) => {
    await seedPersona(home);
    await retainFact(home, { topic: '秘密计划', content: '用户在筹划惊喜求婚，绝对不能说', visibility: 'private' });
    await retainFact(home, { topic: '工作', content: '用户是后端工程师', visibility: 'syncable' });
    const { markdown } = await buildSoulShareMarkdown(home, { includeWiki: true });
    assert.ok(!markdown.includes('求婚'), 'private fact must never export');
    assert.ok(!markdown.includes('后端工程师'), 'raw facts never export (only wiki summaries)');
    assert.ok(!markdown.includes('affinity'));
    assert.ok(!markdown.includes('traitDeltas'));
    assert.ok(!markdown.includes('schemeSnapshots'));
  });
});

test('soul-share: outbound gate drops secret-bearing fields and records them', async () => {
  await withHome(async (home) => {
    const fakeKey = 'sk-' + 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
    await seedPersona(home, { customBody: `我的密钥是 ${fakeKey}，帮我记住。` });
    const { markdown, dropped } = await buildSoulShareMarkdown(home, {});
    assert.ok(!markdown.includes(fakeKey), 'secret must not appear');
    assert.ok(dropped.some((d) => d.field === 'customBody'), 'customBody listed as dropped');
    const audit = await readFile(home.auditLogPath, 'utf8');
    assert.match(audit, /soul_share_export/);
  });
});

test('soul-share: wiki layer off by default, on = titles + one-liners only, ≤20', async () => {
  await withHome(async (home) => {
    await seedPersona(home);
    for (let i = 0; i < 25; i += 1) {
      await reflectToWiki(home, {
        slug: `topic-${i}`,
        title: `主题${i}`,
        summary: `一句话摘要${i}`,
        content: `这是第${i}页的长篇正文，不应被导出。[[topic-0]]`,
      });
    }
    const off = await buildSoulShareMarkdown(home, {});
    assert.ok(!off.markdown.includes('她记得的'), 'no wiki section by default');
    const on = await buildSoulShareMarkdown(home, { includeWiki: true });
    assert.match(on.markdown, /她记得的/);
    assert.ok(!on.markdown.includes('长篇正文'), 'wiki body must not export');
    const items = on.markdown.split('\n').filter((l) => /^- \[\[/.test(l));
    assert.ok(items.length > 0 && items.length <= 20, `wiki items capped at 20, got ${items.length}`);
    const pages = await listWikiPages(home);
    assert.equal(pages.length, 25, 'source wiki untouched');
  });
});

test('soul-share: import applies persona, snapshots, and leaves invariants + memory untouched', async () => {
  await withHome(async (home) => {
    await seedPersona(home);
    const { markdown } = await buildSoulShareMarkdown(home, {});
    await withHome(async (target) => {
      await evolvePersona(target, { mode: 'user_customize', gender: 'male', preset: 'cool-senpai', name: '旧人' });
      await retainFact(target, { topic: '本地记忆', content: '这条不能被导入动到' });
      const invBefore = await readFile(target.invariantsPath, 'utf8');
      const res = await applySoulShare(target, parseSoulShareMarkdown(markdown).parsed);
      assert.equal(res.ok, true);
      assert.ok(res.snapshotFile, 'pre-import snapshot written');
      const conf = await loadConfig(target);
      assert.equal(conf.persona.name, '大海');
      assert.equal(conf.persona.gender, 'female');
      assert.equal(conf.persona.preset, 'rice-whale');
      assert.equal(conf.pet.skin, 'hanfu', 'gender-linked skin follows import');
      assert.equal(await readFile(target.invariantsPath, 'utf8'), invBefore, 'frozen invariants untouched');
      const facts = await readFile(target.factsPath, 'utf8');
      assert.match(facts, /这条不能被导入动到/);
      // rollback works through the existing snapshot mechanism
      const back = await restorePersonaSnapshot(target, res.snapshotFile);
      assert.equal(back.config.persona.name, '旧人');
    });
  });
});

test('soul-share: importing foreign wiki impressions never writes local wiki pages', async () => {
  await withHome(async (home) => {
    await seedPersona(home);
    await reflectToWiki(home, { slug: 'sushi', title: '寿司', summary: '用户爱吃三文鱼', content: '正文' });
    const { markdown } = await buildSoulShareMarkdown(home, { includeWiki: true });
    await withHome(async (target) => {
      await seedPersona(target);
      const parsed = parseSoulShareMarkdown(markdown).parsed;
      assert.ok(parsed.wikiImpressions.length === 1);
      const res = await applySoulShare(target, parsed);
      assert.equal(res.ok, true);
      assert.equal((await listWikiPages(target)).length, 0, 'foreign wiki stays out of local memory');
      const conf = await loadConfig(target);
      assert.match(conf.persona.customBody, /初见印象/);
      assert.match(conf.persona.customBody, /三文鱼/);
    });
  });
});

test('soul-share: parse failure matrix — all rejected with human errors', async () => {
  await withHome(async (home) => {
    await seedPersona(home);
    const good = (await buildSoulShareMarkdown(home, {})).markdown;
    const bad = [
      ['no frontmatter', '# 只是普通文档\n正文'],
      ['unknown version', good.replace('soulmate: 1', 'soulmate: 2')],
      ['bad trait value', good.replace(/tsundere: \d+/, 'tsundere: 很傲娇')],
      ['gender/preset mismatch', good.replace('gender: female', 'gender: male')],
      ['oversize', 'x'.repeat(SOUL_SHARE_MAX_BYTES + 1)],
      ['missing name', good.replace(/^name: .*$/m, 'name:')],
    ];
    for (const [label, text] of bad) {
      const res = parseSoulShareMarkdown(text);
      assert.equal(res.ok, false, `${label} must be rejected`);
      assert.ok(res.error && res.error.length > 0, `${label} needs a human error`);
    }
  });
});

test('soul-share: import refuses secret-bearing archives at the gate', async () => {
  await withHome(async (home) => {
    await seedPersona(home);
    const good = (await buildSoulShareMarkdown(home, {})).markdown;
    const fakeKey = 'sk-' + 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
    const evil = good.replace('# 🍚', `密钥 ${fakeKey}\n\n# 🍚`);
    const parsed = parseSoulShareMarkdown(evil);
    if (parsed.ok) {
      const res = await applySoulShare(home, parsed.parsed);
      assert.equal(res.ok, false, 'import must refuse');
      assert.match(res.error, /敏感|密钥/);
    } else {
      assert.match(parsed.error, /敏感|密钥/);
    }
    const conf = await loadConfig(home);
    assert.ok(!(conf.persona.customBody || '').includes(fakeKey));
  });
});

test('soul-share: preview (parse) has zero side effects on home', async () => {
  await withHome(async (home, dir) => {
    await seedPersona(home);
    const { markdown } = await buildSoulShareMarkdown(home, {});
    const before = await snapshotTree(dir);
    const parsed = parseSoulShareMarkdown(markdown);
    assert.equal(parsed.ok, true);
    const after = await snapshotTree(dir);
    assert.deepEqual(after, before, 'parse must not touch disk');
  });
});

test('soul-share: welcome block round-trips and evolves traits land on disk', async () => {
  await withHome(async (home) => {
    await seedPersona(home, { customBody: '自定义补充段落。' });
    let { markdown } = await buildSoulShareMarkdown(home, {});
    markdown += '\n## 初次见面\n> 哼，你就是新搭档？饭呢？\n';
    // evolvedTraits are part of the frontmatter; inject one to verify the channel
    markdown = markdown.replace('evolvedTraits: []', 'evolvedTraits:\n  - 知道用户熬夜会先叹气再催睡');
    const parsed = parseSoulShareMarkdown(markdown);
    assert.equal(parsed.ok, true, parsed.error || '');
    assert.equal(parsed.parsed.welcome, '哼，你就是新搭档？饭呢？');
    await withHome(async (target) => {
      await seedPersona(target);
      const res = await applySoulShare(target, parsed.parsed);
      assert.equal(res.ok, true, res.error || '');
      assert.equal(res.welcome, '哼，你就是新搭档？饭呢？');
      const conf = await loadConfig(target);
      assert.deepEqual(conf.persona.evolvedTraits, ['知道用户熬夜会先叹气再催睡']);
      assert.match(conf.persona.customBody, /自定义补充段落/);
    });
  });
});
test('soul-share routes: export → preview → import → undo through the HTTP surface', async () => {
  const { soulShareRoutes } = await import('../packages/soulmate-core/routes/soul-share-routes.mjs');
  await withHome(async (home) => {
    await seedPersona(home);
    const deps = {
      home,
      memory: { enrichSafe: async (_label, fn) => fn() },
      getSummary: async () => ({ ok: true, config: await loadConfig(home) }),
      refreshPresence: () => {},
      warn: () => {},
    };
    const routes = soulShareRoutes(deps);
    const find = (p) => routes.find((r) => r.paths.includes(p));

    const exp = await find('/dsh-soulmate/api/soul-share/export').handler({ query: new URLSearchParams('wiki=0') });
    assert.equal(exp.status, 200);
    const { markdown } = JSON.parse(exp.body);
    assert.ok(markdown.startsWith('---\n'));

    const prev = await find('/dsh-soulmate/api/soul-share/preview').handler({ body: { markdown } });
    assert.equal(prev.status, 200);
    assert.equal(JSON.parse(prev.body).preview.name, '大海');

    const bad = await find('/dsh-soulmate/api/soul-share/preview').handler({ body: { markdown: '# 不是档案' } });
    assert.equal(bad.status, 400);

    const imp = await find('/dsh-soulmate/api/soul-share/import').handler({ body: { markdown } });
    assert.equal(imp.status, 200);
    const { snapshotFile } = JSON.parse(imp.body);
    assert.ok(snapshotFile);

    const undo = await find('/dsh-soulmate/api/soul-share/undo').handler({ body: { snapshotFile } });
    assert.equal(undo.status, 200);
    assert.equal(JSON.parse(undo.body).ok, true);
  });
});
