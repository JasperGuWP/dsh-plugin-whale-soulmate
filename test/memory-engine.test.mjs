import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveSoulmateHome } from '../packages/soulmate-core/state.mjs';
import { readPrivacyAudit } from '../packages/soulmate-core/privacy-firewall.mjs';
import {
  retainFact,
  recordEpisode,
  recallMemory,
  reflectToWiki,
  buildSyncableSnapshot,
  applyRemoteSyncDelta,
  reinforceMemoryNode,
  toggleMemoryPrivacy,
  forgetMemory,
  buildNeuralGraph,
  sanitizeSlug,
  extractWikiLinks,
  tokenizeQuery,
  updatePromise,
  resolveConflict,
  composePresenceDigest,
  polarityOpposite,
  shouldAutoResolveConflict,
  isSystemNoiseText,
  autoResolveNoiseConflicts,
  listTrustItems,
  parseTimeWindow,
  backfillEventsIndex,
  upsertSessionEpisode,
  listSessionEpisodes,
} from '../packages/soulmate-core/memory-engine.mjs';

const T0 = Date.parse('2026-11-06T08:00:00.000Z');
const DAY = 86_400_000;

async function withHome(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'soulmate-mem-'));
  try {
    return await fn(resolveSoulmateHome(dir), dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const readJsonl = async (path) =>
  (await readFile(path, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));

test('memory-engine: Hindsight retain, supersede invalidation, decay recall, Wiki reflect & private isolation', async () => {
  await withHome(async (home) => {
    const f1 = await retainFact(home, {
      topic: '饮品偏好',
      content: '主人正在戒咖啡，只喝温水',
      importance: 3,
    });
    assert.equal(f1.ok, true);

    // Supersede old fact with new fact
    const f2 = await retainFact(home, {
      topic: '饮品偏好',
      content: '主人戒咖啡结束了，现在每天早上一杯冰美式',
      importance: 4,
      supersedesId: f1.fact.id,
    });
    assert.equal(f2.ok, true);

    // Private fact should never enter syncable snapshot
    const fPriv = await retainFact(home, {
      topic: '本地服务器口令备忘',
      content: '内网测试机别名是 box-7',
      visibility: 'private',
    });
    assert.equal(fPriv.ok, true);

    await reflectToWiki(home, {
      slug: 'owner-profile',
      title: '主人画像',
      summary: '作息与饮品习惯',
      content: '喜欢早起喝冰美式，详见 [[coding-habits]]。',
    });
    await reflectToWiki(home, {
      slug: 'coding-habits',
      title: '编程习惯',
      summary: '偏爱纯 Node 与零依赖测试',
      content: '写代码坚持 TDD。',
    });

    await recordEpisode(home, {
      date: '2026-11-06',
      kind: 'inner',
      content: '今天他提醒我把小本本名字改成按角色名动态显示，还挺细心的。',
    });

    const recalled = await recallMemory(home, '美式 习惯');
    assert.equal(recalled.ok, true);
    // Superseded fact f1 must NOT be returned in active facts
    assert.ok(recalled.facts.some((x) => x.id === f2.fact.id));
    assert.ok(!recalled.facts.some((x) => x.id === f1.fact.id));
    // Wiki 1-hop link [[coding-habits]] should be expanded
    assert.ok(recalled.wiki.some((w) => w.slug === 'owner-profile'));
    assert.ok(recalled.linkedWiki.some((w) => w.slug === 'coding-habits'));

    // Sync snapshot must exclude private memories
    const snap = await buildSyncableSnapshot(home, 0);
    assert.ok(!JSON.stringify(snap).includes('box-7'));
  });
});

test('memory-engine: privacy gate blocks secrets on every write, audits, and scrubs syncable text', async () => {
  await withHome(async (home) => {
    const secret = 'sk-testonly-privacy-firewall-sample-key02';

    const rf = await retainFact(home, { topic: '接口', content: `我的 key 是 ${secret}` });
    assert.equal(rf.ok, false);
    assert.match(rf.blockedReason, /secret/i);

    const rp = await retainFact(home, { topic: '接口', content: `key ${secret}`, visibility: 'private' });
    assert.equal(rp.ok, false, 'private writes are gated too');

    const re = await recordEpisode(home, { date: '2026-11-06', content: `password=hunter2abc` });
    assert.equal(re.ok, false);
    assert.ok(re.blockedReason);

    const rw = await reflectToWiki(home, { slug: 'leak', title: 't', summary: 's', content: `token ${secret}` });
    assert.equal(rw.ok, false);

    // nothing persisted
    await assert.rejects(readFile(home.factsPath, 'utf8'), { code: 'ENOENT' });
    await assert.rejects(readFile(join(home.wikiDir, 'leak.md'), 'utf8'), { code: 'ENOENT' });
    await assert.rejects(readdir(home.episodesDir), { code: 'ENOENT' });

    // audit ledger records the 4 blocked attempts without leaking the secret
    const audit = await readPrivacyAudit(home, 20);
    assert.equal(audit.filter((r) => r.action === 'memory_write_blocked').length, 4);
    assert.deepEqual(
      audit.map((r) => r.op),
      ['retainFact', 'retainFact', 'recordEpisode', 'reflectToWiki']
    );
    assert.ok(!(await readFile(home.auditLogPath, 'utf8')).includes(secret));

    // syncable text is scrubbed; private text is kept verbatim locally
    const syncable = await retainFact(home, { topic: '联系方式', content: '邮箱 someone@example.com' });
    assert.equal(syncable.ok, true);
    assert.ok(syncable.fact.content.includes('<EMAIL>'));
    assert.ok(!syncable.fact.content.includes('someone@example.com'));
    const priv = await retainFact(home, { topic: '联系方式', content: '邮箱 me@example.com', visibility: 'private' });
    assert.ok(priv.fact.content.includes('me@example.com'));
  });
});

test('memory-engine: retainFact defaults, clamping, supersede markers, and private storage isolation', async () => {
  await withHome(async (home) => {
    const a = await retainFact(home, { topic: 't', content: 'c1', importance: 99, nowMs: T0 });
    assert.equal(a.storedIn, 'facts');
    assert.match(a.fact.id, /^f_/);
    assert.equal(a.fact.importance, 5);
    assert.equal(a.fact.visibility, 'syncable');
    assert.equal(a.fact.category, 'general');
    assert.equal(a.fact.halfLifeDays, 180, 'v2 §1: the "fact" decay class defaults to 180 days');
    assert.equal(a.fact.recallCount, 0);
    assert.equal(a.fact.invalidatedBy, null);
    assert.equal(a.fact.deletedAt, null);
    assert.equal(a.fact.createdAt, new Date(T0).toISOString());
    assert.equal(a.fact.lastRecalledAt, new Date(T0).toISOString());

    // Memory contract fields (§5)
    assert.equal(a.fact.kind, 'semantic');
    assert.equal(a.fact.text, 't：c1');
    assert.equal(a.fact.t, new Date(T0).toISOString());
    assert.equal(a.fact.salience, 1, 'importance 5 → salience 1.0');
    assert.equal(a.fact.confidence, 0.6);
    assert.deepEqual(a.fact.evidence, []);

    assert.equal((await retainFact(home, { topic: 't', content: 'low', importance: -3 })).fact.importance, 1);

    const b = await retainFact(home, { id: 'fixed-id', topic: 't', content: 'c2', supersedesId: a.fact.id, nowMs: T0 + 1000 });
    assert.equal(b.fact.id, 'fixed-id');
    const rows = await readJsonl(home.factsPath);
    const old = rows.find((r) => r.id === a.fact.id);
    assert.equal(old.invalidatedBy, 'fixed-id');
    assert.equal(old.invalidatedAt, new Date(T0 + 1000).toISOString());

    const p = await retainFact(home, { topic: '私密', content: '只存本机 zebra-77', visibility: 'private' });
    assert.equal(p.storedIn, 'private');
    assert.equal(p.fact.visibility, 'private');
    assert.ok(!(await readFile(home.factsPath, 'utf8')).includes('zebra-77'));
    const privRows = await readJsonl(join(home.privateDir, 'private-facts.jsonl'));
    assert.equal(privRows.length, 1);
    assert.equal(privRows[0].content, '只存本机 zebra-77');
    const notes = await readFile(home.privateNotesPath, 'utf8');
    assert.ok(notes.includes('zebra-77') && notes.includes('私密'));

    assert.equal((await retainFact(home, { topic: '', content: 'x' })).ok, false);
  });
});

test('memory-engine: recordEpisode appends per day/kind, honors private visibility', async () => {
  await withHome(async (home) => {
    const r1 = await recordEpisode(home, { date: '2026-11-06', kind: 'to-you', title: '早安', content: '今天也要加油', notebookTitle: '小汐的信' });
    assert.equal(r1.ok, true);
    assert.equal(r1.file, join(home.episodesDir, '2026-11-06-to-you.md'));
    assert.equal(r1.kind, 'to-you');
    assert.ok(!Number.isNaN(Date.parse(r1.updatedAt)));
    await recordEpisode(home, { date: '2026-11-06', kind: 'to-you', content: '第二条' });
    const text = await readFile(r1.file, 'utf8');
    assert.ok(text.includes('小汐的信'));
    assert.ok(!/^# /m.test(text), 'diary body must not use markdown # headings');
    assert.ok(text.includes('早安') && text.includes('今天也要加油') && text.includes('第二条'));
    assert.equal((text.match(/^\d{2}:\d{2}/gm) ?? []).length, 2);

    const today = await recordEpisode(home, { content: '默认日期', nowMs: new Date(2030, 0, 15, 10, 30).getTime() });
    assert.equal(today.date, '2030-01-15');
    assert.equal(today.kind, 'to-you');
    assert.match((await recordEpisode(home, { content: '真实今天', kind: 'inner', visibility: 'private' })).date, /^\d{4}-\d{2}-\d{2}$/);

    const priv = await recordEpisode(home, { date: '2026-11-06', kind: 'inner', content: '私密日记 giraffe-42', visibility: 'private' });
    assert.equal(priv.file, join(home.privateDir, '2026-11-06-inner.md'));
    assert.deepEqual((await readdir(home.episodesDir)).sort(), ['2026-11-06-to-you.md', '2030-01-15-to-you.md']);

    assert.equal((await recordEpisode(home, { date: 'bad', content: 'x' })).ok, false);
    assert.equal((await recordEpisode(home, { kind: 'weird', content: 'x' })).ok, false);

    const snap = await buildSyncableSnapshot(home, 0);
    assert.equal(snap.episodeUpserts.length, 2);
    assert.ok(!JSON.stringify(snap).includes('giraffe-42'));
  });
});

test('memory-engine: reflectToWiki sanitizes slug, extracts links, maintains INDEX.md', async () => {
  await withHome(async (home) => {
    assert.equal(sanitizeSlug('../Evil Page!'), 'evil-page');
    assert.equal(sanitizeSlug('index'), 'index-page');
    assert.deepEqual(extractWikiLinks('见 [[A b]] 与 [[c|别名]]，再 [[a-b]]'), ['a-b', 'c']);

    const r = await reflectToWiki(home, {
      slug: '../Evil Page',
      title: '邪恶页面',
      summary: '摘要',
      content: '关联 [[other-page]] 以及自身 [[evil-page]]',
      sourceFactIds: ['f_1'],
      nowMs: T0,
    });
    assert.equal(r.ok, true);
    assert.deepEqual(r.page, {
      slug: 'evil-page',
      title: '邪恶页面',
      summary: '摘要',
      category: 'mental-model',
      links: ['other-page'],
      updatedAt: new Date(T0).toISOString(),
    });
    const file = await readFile(join(home.wikiDir, 'evil-page.md'), 'utf8');
    assert.ok(file.startsWith('---\n'));
    assert.match(file, /^title: "邪恶页面"$/m);
    assert.match(file, /^category: "mental-model"$/m);
    assert.match(file, /^links: \["other-page"\]$/m);
    assert.match(file, /^updatedAt: "2026-11-06T08:00:00.000Z"$/m);

    await reflectToWiki(home, { slug: 'a-page', title: 'A', summary: 'sa', content: 'x' });
    const index = await readFile(home.wikiIndexPath, 'utf8');
    assert.ok(index.includes('[[a-page]]') && index.includes('[[evil-page]]') && index.includes('邪恶页面'));

    // rewrite replaces rather than duplicates
    await reflectToWiki(home, { slug: 'a-page', title: 'A2', summary: 'sa2', content: 'y' });
    const index2 = await readFile(home.wikiIndexPath, 'utf8');
    assert.equal((index2.match(/\[\[a-page\]\]/g) ?? []).length, 1);
    assert.ok(index2.includes('A2'));

    assert.equal((await reflectToWiki(home, { slug: '!!!', title: 't', content: 'x' })).ok, false);
  });
});

test('memory-engine: tokenizer yields ASCII words, Chinese chars and bigrams', () => {
  const t = tokenizeQuery('Node 美式咖啡 a');
  assert.deepEqual(t.words, ['node']);
  assert.deepEqual(t.bigrams, ['美式', '式咖', '咖啡']);
  assert.deepEqual(t.chars, ['美', '式', '咖', '啡']);
});

test('memory-engine: recall ranks by half-life decay, reinforces recallCount, respects includePrivate', async () => {
  await withHome(async (home) => {
    const oldF = await retainFact(home, { topic: 'espresso old', content: 'espresso beans from 2026', nowMs: T0 - 200 * DAY });
    const newF = await retainFact(home, { topic: 'espresso new', content: 'espresso machine at home', nowMs: T0 });
    const privF = await retainFact(home, { topic: 'espresso secret stash', content: 'espresso hidden', visibility: 'private', nowMs: T0 });
    await retainFact(home, { topic: 'unrelated', content: 'nothing relevant here', importance: 5, nowMs: T0 });

    const peek = await recallMemory(home, 'espresso', { nowMs: T0, reinforce: false, includePrivate: false });
    assert.deepEqual(
      peek.facts.map((f) => f.id),
      [newF.fact.id, oldF.fact.id]
    );
    assert.ok(peek.facts[0].score > peek.facts[1].score);
    assert.ok(!peek.facts.some((f) => f.id === privF.fact.id));
    assert.ok(!peek.facts.some((f) => f.topic === 'unrelated'));
    let rows = await readJsonl(home.factsPath);
    assert.ok(rows.every((r) => r.recallCount === 0), 'reinforce:false must not touch recallCount');

    const withPriv = await recallMemory(home, 'espresso', { nowMs: T0, reinforce: false });
    assert.ok(withPriv.facts.some((f) => f.id === privF.fact.id));

    const limited = await recallMemory(home, 'espresso', { nowMs: T0 + 1000, limit: 1, reinforce: true });
    assert.equal(limited.facts.length, 1);
    assert.equal(limited.facts[0].id, newF.fact.id);
    assert.equal(limited.facts[0].recallCount, 1);
    rows = await readJsonl(home.factsPath);
    const reinforced = rows.find((r) => r.id === newF.fact.id);
    assert.equal(reinforced.recallCount, 1);
    assert.equal(reinforced.lastRecalledAt, new Date(T0 + 1000).toISOString());
    assert.equal(rows.find((r) => r.id === oldF.fact.id).recallCount, 0);

    // recallCount stretches the effective half-life (decays slower)
    const slow = { halfLifeDays: 30, recallCount: 10 };
    const fast = { halfLifeDays: 30, recallCount: 0 };
    assert.ok(2 ** (-30 / (slow.halfLifeDays * (1 + 0.3 * slow.recallCount))) > 2 ** (-30 / fast.halfLifeDays));

    const none = await recallMemory(home, 'zzzzqqq', { nowMs: T0, reinforce: false });
    assert.deepEqual([none.facts, none.wiki, none.linkedWiki, none.episodes], [[], [], [], []]);
  });
});

test('memory-engine: recall finds recent episodes and Wiki 1-hop links', async () => {
  await withHome(async (home) => {
    await recordEpisode(home, { date: '2026-11-05', kind: 'to-you', content: '一起调试了 websocket 断线问题' });
    await recordEpisode(home, { date: '2026-11-06', kind: 'inner', content: '他今天煮了咖啡', visibility: 'private' });
    await reflectToWiki(home, { slug: 'a', title: '页面甲', summary: '关于咖啡', content: '咖啡 见 [[b]] 和 [[ghost]]' });
    await reflectToWiki(home, { slug: 'b', title: '页面乙', summary: '无关', content: '被链接的页面' });

    const r = await recallMemory(home, 'websocket 咖啡', { reinforce: false });
    assert.ok(r.episodes.some((e) => e.date === '2026-11-05' && e.snippet.includes('websocket')));
    assert.ok(r.episodes.some((e) => e.visibility === 'private'));
    assert.deepEqual(r.wiki.map((w) => w.slug), ['a']);
    assert.deepEqual(r.linkedWiki.map((w) => w.slug), ['b'], 'dangling [[ghost]] is ignored');
    assert.deepEqual(r.linkedWiki[0].linkedFrom, ['a']);

    const noPriv = await recallMemory(home, '咖啡', { reinforce: false, includePrivate: false });
    assert.ok(!noPriv.episodes.some((e) => e.visibility === 'private'));
  });
});

test('memory-engine: reinforceMemoryNode boosts recallCount by 2 and refreshes timestamps', async () => {
  await withHome(async (home) => {
    const f = await retainFact(home, { topic: 'x', content: 'y', nowMs: T0 });
    const p = await retainFact(home, { topic: 'px', content: 'py', visibility: 'private', nowMs: T0 });
    const r = await reinforceMemoryNode(home, f.fact.id, { nowMs: T0 + DAY });
    assert.equal(r.ok, true);
    assert.equal(r.fact.recallCount, 2);
    assert.equal(r.fact.lastRecalledAt, new Date(T0 + DAY).toISOString());
    assert.equal(r.fact.updatedAt, new Date(T0 + DAY).toISOString());
    assert.equal((await reinforceMemoryNode(home, f.fact.id)).fact.recallCount, 4);
    assert.equal((await reinforceMemoryNode(home, p.fact.id)).fact.recallCount, 2);
    assert.equal((await readJsonl(home.factsPath))[0].recallCount, 4);
    assert.equal((await reinforceMemoryNode(home, 'nope')).ok, false);
  });
});

test('memory-engine: toggleMemoryPrivacy moves facts between facts.jsonl and private-facts.jsonl', async () => {
  await withHome(async (home) => {
    const f = await retainFact(home, { topic: '爱好', content: '喜欢 marmot-9 观察', nowMs: T0 });
    const privPath = join(home.privateDir, 'private-facts.jsonl');

    const toPriv = await toggleMemoryPrivacy(home, f.fact.id);
    assert.equal(toPriv.ok, true);
    assert.equal(toPriv.fact.visibility, 'private');
    assert.equal(toPriv.storedIn, 'private');
    assert.equal((await readJsonl(home.factsPath)).length, 0);
    assert.equal((await readJsonl(privPath))[0].id, f.fact.id);
    assert.ok((await readFile(home.privateNotesPath, 'utf8')).includes('marmot-9'));

    // snapshot hides the content but tells the cloud to drop its stale copy
    const snap = await buildSyncableSnapshot(home, 0);
    assert.ok(!JSON.stringify(snap).includes('marmot-9'));
    assert.deepEqual(snap.tombstones.map((t) => [t.kind, t.id]), [['fact', f.fact.id]]);

    const back = await toggleMemoryPrivacy(home, f.fact.id);
    assert.equal(back.ok, true);
    assert.equal(back.fact.visibility, 'syncable');
    assert.equal(back.storedIn, 'facts');
    assert.equal((await readJsonl(privPath)).length, 0);
    assert.equal((await readJsonl(home.factsPath))[0].id, f.fact.id);
    const snap2 = await buildSyncableSnapshot(home, 0);
    assert.equal(snap2.factUpserts.length, 1);
    assert.equal(snap2.tombstones.length, 0);

    assert.equal((await toggleMemoryPrivacy(home, 'missing')).ok, false);
  });
});

test('memory-engine: forgetMemory tombstones facts/wiki/episodes and removes active entries', async () => {
  await withHome(async (home) => {
    const f = await retainFact(home, { topic: '要忘记', content: '临时的事', nowMs: T0 });
    const p = await retainFact(home, { topic: '私密忘记', content: '私密的事', visibility: 'private' });
    await reflectToWiki(home, { slug: 'doomed', title: '将被遗忘', summary: 's', content: 'bye' });
    await reflectToWiki(home, { slug: 'keeper', title: '保留', summary: 's', content: 'stay' });
    const ep = await recordEpisode(home, { date: '2026-11-06', kind: 'to-you', content: 'ep-gone' });

    const rf = await forgetMemory(home, f.fact.id, { nowMs: T0 + 5 });
    assert.equal(rf.ok, true);
    assert.equal(rf.kind, 'fact');
    assert.equal(rf.deletedAt, new Date(T0 + 5).toISOString());
    assert.equal((await readJsonl(home.factsPath)).length, 0);

    const rw = await forgetMemory(home, 'wiki:doomed');
    assert.deepEqual([rw.ok, rw.kind, rw.id], [true, 'wiki', 'doomed']);
    await assert.rejects(readFile(join(home.wikiDir, 'doomed.md'), 'utf8'), { code: 'ENOENT' });
    assert.ok(!(await readFile(home.wikiIndexPath, 'utf8')).includes('doomed'));
    assert.ok((await readFile(home.wikiIndexPath, 'utf8')).includes('keeper'));

    assert.equal((await forgetMemory(home, 'keeper')).kind, 'wiki', 'bare slug works too');
    assert.equal((await forgetMemory(home, 'episode:2026-11-06-to-you')).kind, 'episode');
    await assert.rejects(readFile(ep.file, 'utf8'), { code: 'ENOENT' });

    const rp = await forgetMemory(home, p.fact.id);
    assert.equal(rp.ok, true);
    assert.equal((await readJsonl(join(home.privateDir, 'private-facts.jsonl'))).length, 0);

    const tombs = await readJsonl(join(home.memoryDir, 'tombstones.jsonl'));
    assert.deepEqual(
      tombs.map((t) => `${t.kind}:${t.id}`).sort(),
      [`fact:${f.fact.id}`, `fact:${p.fact.id}`, 'wiki:doomed', 'wiki:keeper', 'episode:2026-11-06-to-you'].sort()
    );
    assert.ok(tombs.every((t) => t.deletedAt));

    // forgotten memories never come back through recall; private tombstone never syncs
    const r = await recallMemory(home, '忘记 将被遗忘 私密', { reinforce: false });
    assert.equal(r.facts.length + r.wiki.length, 0);
    const snap = await buildSyncableSnapshot(home, 0);
    assert.ok(snap.tombstones.some((t) => t.id === f.fact.id));
    assert.ok(!snap.tombstones.some((t) => t.id === p.fact.id));
    assert.ok(snap.tombstones.every((t) => !('visibility' in t)));

    assert.equal((await forgetMemory(home, 'not-there')).ok, false);
    assert.equal((await forgetMemory(home, 'remote:whatever')).ok, false);
  });
});

test('memory-engine: buildSyncableSnapshot honors sinceCursor and never reads private dir', async () => {
  await withHome(async (home) => {
    await retainFact(home, { id: 'f_old', topic: 'a', content: 'old fact', nowMs: T0 });
    await reflectToWiki(home, { slug: 'pg', title: 'P', summary: 's', content: 'wiki body', nowMs: T0 });
    await recordEpisode(home, { date: '2026-11-06', kind: 'to-you', content: 'ep body', nowMs: T0 });
    await retainFact(home, { topic: 'priv', content: 'quokka-5', visibility: 'private', nowMs: T0 });
    await recordEpisode(home, { date: '2026-11-06', kind: 'inner', content: 'quokka-6', visibility: 'private', nowMs: T0 });

    const s1 = await buildSyncableSnapshot(home, 0);
    assert.deepEqual(
      [s1.wikiUpserts.length, s1.factUpserts.length, s1.episodeUpserts.length, s1.tombstones.length],
      [1, 1, 1, 0]
    );
    assert.equal(s1.cursor, T0);
    assert.ok(!JSON.stringify(s1).includes('quokka'));

    const s2 = await buildSyncableSnapshot(home, s1.cursor);
    assert.deepEqual([s2.wikiUpserts, s2.factUpserts, s2.episodeUpserts, s2.tombstones], [[], [], [], []]);
    assert.equal(s2.cursor, s1.cursor);

    await retainFact(home, { id: 'f_new', topic: 'b', content: 'new fact', nowMs: T0 + 10 });
    const s3 = await buildSyncableSnapshot(home, s1.cursor);
    assert.deepEqual(s3.factUpserts.map((f) => f.id), ['f_new']);
    assert.equal(s3.cursor, T0 + 10);
  });
});

test('memory-engine: applyRemoteSyncDelta merges with LWW, tombstones, and never imports private facts', async () => {
  await withHome(async (home) => {
    const iso = (ms) => new Date(ms).toISOString();
    await retainFact(home, { id: 'f_local', topic: 't', content: 'local v1', nowMs: T0 });
    await retainFact(home, { id: 'f_newer_local', topic: 't', content: 'local wins', nowMs: T0 + 100 });
    await retainFact(home, { id: 'f_priv', topic: 'p', content: 'private local', visibility: 'private', nowMs: T0 });
    await retainFact(home, { id: 'f_doomed', topic: 't', content: 'will be deleted', nowMs: T0 });
    await retainFact(home, { id: 'f_survivor', topic: 't', content: 'newer than tombstone', nowMs: T0 + 500 });
    await reflectToWiki(home, { slug: 'pg', title: 'local page', summary: '', content: 'local body', nowMs: T0 });

    const res = await applyRemoteSyncDelta(home, {
      remoteFactUpserts: [
        { id: 'f_local', topic: 't', content: 'remote v2', importance: 4, updatedAt: iso(T0 + 600_000) }, // >60s apart: plain LWW
        { id: 'f_newer_local', topic: 't', content: 'stale remote', updatedAt: iso(T0 + 10) },
        { id: 'f_priv', topic: 'p', content: 'remote clobber', updatedAt: iso(T0 + 999) },
        { id: 'f_fresh', topic: 'r', content: 'brand new', visibility: 'private', updatedAt: iso(T0 + 1) },
        { id: '', content: 'bad' },
      ],
      remoteWikiUpserts: [
        { slug: 'pg', title: 'remote page', summary: 'rs', content: 'remote body [[new-page]]', updatedAt: iso(T0 + 20) },
        { slug: '../New Page', title: 'new', summary: '', content: 'hello', updatedAt: iso(T0 + 20) },
      ],
      remoteEpisodeUpserts: [{ date: '2026-11-04', kind: 'to-you', content: '# 信\n\n远端的一天', updatedAt: iso(T0 + 30) }],
      remoteTombstones: [
        { kind: 'fact', id: 'f_doomed', deletedAt: iso(T0 + 40) },
        { kind: 'fact', id: 'f_survivor', deletedAt: iso(T0 + 40) },
        { kind: 'fact', id: 'f_priv', deletedAt: iso(T0 + 2000) },
        { kind: 'bogus', id: 'x', deletedAt: iso(T0) },
      ],
    });
    assert.equal(res.ok, true);

    const rows = await readJsonl(home.factsPath);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    assert.equal(byId.f_local.content, 'remote v2');
    assert.equal(byId.f_local.importance, 4);
    assert.equal(byId.f_newer_local.content, 'local wins');
    assert.equal(byId.f_fresh.visibility, 'syncable', 'remote cannot inject private visibility');
    assert.equal(byId.f_doomed, undefined);
    assert.equal(byId.f_survivor.content, 'newer than tombstone');
    const priv = await readJsonl(join(home.privateDir, 'private-facts.jsonl'));
    assert.deepEqual(priv.map((p) => p.content), ['private local'], 'local private fact untouched by remote');

    const wiki = await buildSyncableSnapshot(home, 0);
    assert.equal(wiki.wikiUpserts.find((w) => w.slug === 'pg').title, 'remote page');
    assert.deepEqual(wiki.wikiUpserts.find((w) => w.slug === 'pg').links, ['new-page']);
    assert.ok(wiki.wikiUpserts.some((w) => w.slug === 'new-page'));
    assert.ok((await readFile(home.wikiIndexPath, 'utf8')).includes('[[new-page]]'));
    assert.ok(wiki.episodeUpserts.some((e) => e.date === '2026-11-04' && e.content.includes('远端的一天')));
    assert.ok(wiki.tombstones.some((t) => t.id === 'f_doomed'));

    // a stale remote upsert cannot resurrect a tombstoned fact
    const again = await applyRemoteSyncDelta(home, {
      remoteFactUpserts: [{ id: 'f_doomed', topic: 't', content: 'zombie', updatedAt: iso(T0 + 30) }],
      remoteTombstones: [{ kind: 'wiki', id: 'new-page', deletedAt: iso(T0 + 60) }],
    });
    assert.equal(again.applied.facts, 0);
    assert.ok(!(await readJsonl(home.factsPath)).some((r) => r.id === 'f_doomed'));
    await assert.rejects(readFile(join(home.wikiDir, 'new-page.md'), 'utf8'), { code: 'ENOENT' });
    assert.ok(!(await readFile(home.wikiIndexPath, 'utf8')).includes('[[new-page]]'));

    assert.deepEqual((await applyRemoteSyncDelta(home, {})).applied, { wiki: 0, facts: 0, episodes: 0, tombstones: 0, conflicts: 0, ops: 0 });
  });
});

async function seedGraph(home) {
  await reflectToWiki(home, { slug: 'owner-profile', title: '主人画像', summary: '画像', content: '见 [[coding-habits]]', nowMs: T0 });
  await reflectToWiki(home, { slug: 'coding-habits', title: '编程习惯', summary: '习惯', content: 'TDD', nowMs: T0 });
  const hi = await retainFact(home, { id: 'f_hi', topic: '主人画像', content: '重要事实', importance: 5, nowMs: T0 });
  const lo = await retainFact(home, { id: 'f_lo', topic: 'owner-profile', content: '次要事实', importance: 1, nowMs: T0 - 120 * DAY });
  const orphan = await retainFact(home, { id: 'f_orphan', topic: '随便聊聊', content: '孤立事实', nowMs: T0 });
  const priv = await retainFact(home, { id: 'f_priv', topic: '保险箱', content: '私密事实', visibility: 'private', nowMs: T0 });
  await recordEpisode(home, { date: '2026-11-05', kind: 'to-you', content: '昨天', nowMs: T0 });
  await recordEpisode(home, { date: '2026-11-06', kind: 'to-you', content: '今天', nowMs: T0 });
  await recordEpisode(home, { date: '2026-11-06', kind: 'inner', content: '私密日记', visibility: 'private', nowMs: T0 });
  return { hi, lo, orphan, priv };
}

test('memory-engine: buildNeuralGraph produces local cortex, shielded vault, remote nebula, and synapses', async () => {
  await withHome(async (home) => {
    await seedGraph(home);
    const g = await buildNeuralGraph(home, {
      nowMs: T0,
      remoteCapabilities: [{ id: 'weather', title: '天气', description: '查询天气' }],
    });
    assert.equal(g.ok, true);
    const byId = new Map(g.nodes.map((n) => [n.id, n]));
    assert.equal(byId.size, g.nodes.length, 'node ids unique');

    // wiki stars
    for (const slug of ['owner-profile', 'coding-habits']) {
      const n = byId.get(`wiki:${slug}`);
      assert.equal(n.kind, 'wiki_star');
      assert.equal(n.zone, 'local_cortex');
      assert.equal(n.color, '#00f2fe');
      assert.equal(n.shielded, false);
      assert.ok(n.size > byId.get('f_hi').size);
    }
    // fact neurons: color, size scaled by importance, energy by freshness
    const hi = byId.get('f_hi');
    const lo = byId.get('f_lo');
    assert.equal(hi.kind, 'fact_neuron');
    assert.equal(hi.color, '#4facfe');
    assert.ok(hi.size > lo.size);
    assert.ok(hi.energy > lo.energy);
    assert.ok(hi.energy <= 1 && lo.energy >= 0.1);
    assert.equal(hi.importance, 5);
    assert.equal(hi.synced, true);
    // fact orbits its wiki star
    const star = byId.get('wiki:owner-profile').position;
    const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
    assert.ok(d(hi.position, star) < 8);
    assert.ok(d(byId.get('f_orphan').position, star) > 8);

    // private shielded
    const priv = byId.get('f_priv');
    assert.equal(priv.kind, 'private_shielded');
    assert.equal(priv.shielded, true);
    assert.equal(priv.color, '#ffd700');
    assert.equal(priv.zone, 'private_vault');
    assert.equal(priv.synced, false);
    assert.ok(!byId.has('remote:f_priv'), 'private nodes have no cloud counterpart');

    // episodes
    const eps = g.nodes.filter((n) => n.kind === 'episode_crystal');
    assert.equal(eps.length, 3);
    assert.equal(eps.filter((n) => n.shielded).length, 1);

    // remote ring
    const remotes = g.nodes.filter((n) => n.kind === 'remote_cloud');
    assert.equal(remotes.length, 7);
    assert.ok(remotes.every((n) => n.color === '#b721ff' && n.zone === 'remote_nebula'));
    const cap = byId.get('capability:weather');
    assert.equal(cap.kind, 'remote_capability');
    assert.equal(cap.color, '#ff2a85');
    assert.equal(cap.label, '天气');
    const core = Math.hypot(star.x, star.y, star.z);
    const ring = byId.get('remote:wiki:owner-profile').position;
    assert.ok(Math.hypot(ring.x, ring.y, ring.z) > core * 3);

    // required node shape
    const keys = ['id', 'label', 'kind', 'zone', 'color', 'size', 'energy', 'importance', 'recallCount', 'halfLifeDays', 'shielded', 'synced', 'summary', 'content', 'updatedAt', 'position'];
    for (const n of g.nodes) {
      for (const k of keys) assert.ok(k in n, `${n.id} missing ${k}`);
      assert.ok(['x', 'y', 'z'].every((a) => Number.isFinite(n.position[a])));
      assert.ok(n.energy >= 0.1 && n.energy <= 1);
    }

    // synapses
    const kinds = (k) => g.synapses.filter((s) => s.kind === k);
    assert.deepEqual(
      kinds('wiki_link').map((s) => [s.source, s.target]),
      [['wiki:owner-profile', 'wiki:coding-habits']]
    );
    assert.deepEqual(
      kinds('topic_cluster').map((s) => [s.source, s.target]).sort(),
      [['f_hi', 'wiki:owner-profile'], ['f_lo', 'wiki:owner-profile']]
    );
    assert.equal(kinds('warp_sync_beam').length, 7);
    assert.ok(kinds('warp_sync_beam').every((s) => byId.has(s.source) && byId.get(s.target).kind === 'remote_cloud'));
    assert.equal(kinds('episode_chain').length, 1);
    assert.ok(g.synapses.every((s) => byId.has(s.source) && byId.has(s.target) && s.pulseColor && s.strength > 0 && s.id));
    assert.equal(new Set(g.synapses.map((s) => s.id)).size, g.synapses.length);

    // stats
    assert.equal(g.stats.localCount, 7);
    assert.equal(g.stats.privateShieldedCount, 2);
    assert.equal(g.stats.remoteCloudCount, 8);
    assert.equal(g.stats.synapseCount, g.synapses.length);
    const avg = g.nodes.reduce((s, n) => s + n.energy, 0) / g.nodes.length;
    assert.ok(Math.abs(g.stats.averageEnergy - avg) < 0.001);

    // deterministic layout
    assert.deepEqual(await buildNeuralGraph(home, { nowMs: T0, remoteCapabilities: [{ id: 'weather', title: '天气', description: '查询天气' }] }), g);
  });
});

test('memory-engine: buildNeuralGraph options (cloudSynced / syncedIds) and empty home', async () => {
  await withHome(async (home) => {
    const empty = await buildNeuralGraph(home, { nowMs: T0 });
    assert.deepEqual(empty.nodes, []);
    assert.deepEqual(empty.stats, { localCount: 0, privateShieldedCount: 0, remoteCloudCount: 0, synapseCount: 0, averageEnergy: 0 });

    await seedGraph(home);
    const offline = await buildNeuralGraph(home, { nowMs: T0, cloudSynced: false });
    assert.equal(offline.stats.remoteCloudCount, 0);
    assert.ok(offline.nodes.every((n) => n.kind !== 'remote_cloud' && n.synced === false));
    assert.equal(offline.synapses.filter((s) => s.kind === 'warp_sync_beam').length, 0);

    const caps = await buildNeuralGraph(home, { nowMs: T0, cloudSynced: false, remoteCapabilities: ['calendar'] });
    assert.equal(caps.nodes.filter((n) => n.kind === 'remote_capability').length, 1);

    const partial = await buildNeuralGraph(home, { nowMs: T0, syncedIds: ['f_hi'] });
    assert.deepEqual(partial.nodes.filter((n) => n.kind === 'remote_cloud').map((n) => n.id), ['remote:f_hi']);
    assert.equal(partial.nodes.find((n) => n.id === 'f_orphan').synced, false);
  });
});

test('memory-engine: 3D HUD actions (reinforce / shield / forget) are reflected in the neural graph', async () => {
  await withHome(async (home) => {
    const { lo } = await seedGraph(home);
    const id = lo.fact.id;
    const find = (g, nid) => g.nodes.find((n) => n.id === nid);

    const before = find(await buildNeuralGraph(home, { nowMs: T0 }), id);
    await reinforceMemoryNode(home, id, { nowMs: T0 });
    const afterReinforce = find(await buildNeuralGraph(home, { nowMs: T0 }), id);
    assert.equal(afterReinforce.recallCount, 2);
    assert.ok(afterReinforce.energy > before.energy);

    await toggleMemoryPrivacy(home, id);
    const shielded = find(await buildNeuralGraph(home, { nowMs: T0 }), id);
    assert.equal(shielded.kind, 'private_shielded');
    assert.equal(shielded.shielded, true);
    assert.equal(shielded.color, '#ffd700');

    await toggleMemoryPrivacy(home, id);
    assert.equal(find(await buildNeuralGraph(home, { nowMs: T0 }), id).kind, 'fact_neuron');

    assert.equal((await forgetMemory(home, id)).ok, true);
    assert.equal(find(await buildNeuralGraph(home, { nowMs: T0 }), id), undefined);
    assert.equal((await forgetMemory(home, 'wiki:coding-habits')).ok, true);
    const g = await buildNeuralGraph(home, { nowMs: T0 });
    assert.equal(find(g, 'wiki:coding-habits'), undefined);
    assert.equal(g.synapses.filter((s) => s.kind === 'wiki_link').length, 0, 'dangling links are dropped');
  });
});

test('memory-engine: concurrent writers are serialized without losing facts', async () => {
  await withHome(async (home) => {
    await Promise.all(Array.from({ length: 12 }, (_, i) => retainFact(home, { id: `f_${i}`, topic: 't', content: `c${i}` })));
    assert.equal((await readJsonl(home.factsPath)).length, 12);
  });
});

// ---------------------------------------------------------------------------
// v3 engine (design 2026-11-09 §3.4 / §9.2 / §1)
// ---------------------------------------------------------------------------

test('memory-engine v3: a secret passed via text alone is refused', async () => {
  await withHome(async (home) => {
    const res = await retainFact(home, { text: 'reset token sk-testonly-privacy-firewall-sample-key05', nowMs: T0 });
    assert.equal(res.ok, false);
    assert.ok(res.blockedReason, 'the firewall must name the reason');
    const rows = await readJsonl(home.factsPath).catch(() => []);
    assert.equal(rows.length, 0, 'nothing may be stored');
  });
});

test('memory-engine v3: stored text is built from scrubbed fields', async () => {
  await withHome(async (home) => {
    const res = await retainFact(home, {
      topic: 'contact',
      content: 'mail me at alice@example.com please',
      nowMs: T0,
    });
    assert.equal(res.ok, true);
    assert.ok(!res.fact.text.includes('alice@example.com'), 'raw email must not survive into text');
    assert.match(res.fact.text, /<EMAIL>/);
    const [row] = await readJsonl(home.factsPath);
    assert.ok(!row.text.includes('alice@example.com'));
    assert.ok(!row.content.includes('alice@example.com'));
  });
});

test('memory-engine v3: sync payload is whitelist-only and scrubbed at egress', async () => {
  await withHome(async (home, dir) => {
    // A legacy raw row that somehow carries an email in text (pre-v3 store).
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(join(home.memoryDir, 'facts'), { recursive: true });
    const raw = {
      id: 'f_raw', kind: 'semantic', decayClass: 'fact',
      text: 'ping bob@corp.internal before deploy', topic: 'deploy', content: 'ping bob@corp.internal',
      t: new Date(T0).toISOString(), salience: 0.5, confidence: 0.6, evidence: [],
      visibility: 'syncable', halfLifeDays: 180, recallCount: 0,
      createdAt: new Date(T0).toISOString(), updatedAt: new Date(T0).toISOString(),
    };
    await writeFile(home.factsPath, `${JSON.stringify(raw)}\n`, 'utf8');
    const snap = await buildSyncableSnapshot(home, 0);
    assert.equal(snap.factUpserts.length, 1);
    const [f] = snap.factUpserts;
    assert.ok(!f.text.includes('bob@corp.internal'), 'egress scrub must redact');
    assert.ok(!Object.prototype.hasOwnProperty.call(f, 'topic'), 'legacy views stay local');
    assert.ok(!Object.prototype.hasOwnProperty.call(f, 'content'));
    for (const key of ['id', 'kind', 'decayClass', 'text', 't', 'salience', 'confidence', 'evidence', 'provenance', 'updatedAt']) {
      assert.ok(Object.prototype.hasOwnProperty.call(f, key), `whitelist keeps ${key}`);
    }
    const audit = await readPrivacyAudit(home);
    assert.ok(audit.some((a) => a.action === 'sync_field_redacted' && a.id === 'f_raw'));
  });
});

test('memory-engine v3: recall no longer reinforces by default', async () => {
  await withHome(async (home) => {
    const f = await retainFact(home, { topic: 'lantern', content: 'the paper lantern by the door', nowMs: T0 });
    await recallMemory(home, 'lantern', { nowMs: T0 });
    let rows = await readJsonl(home.factsPath);
    assert.equal(rows[0].recallCount, 0, 'a passive read must not stretch the curve');
    await recallMemory(home, 'lantern', { nowMs: T0, reinforce: true });
    rows = await readJsonl(home.factsPath);
    assert.equal(rows.find((r) => r.id === f.fact.id).recallCount, 1);
  });
});

test('memory-engine v3: out-of-range half-lives fail loudly on write', async () => {
  await withHome(async (home) => {
    const bad = await retainFact(home, { topic: 'x', content: 'y', decayClass: 'fact', halfLifeDays: 30, nowMs: T0 });
    assert.equal(bad.ok, false);
    assert.match(bad.error, /outside/);
    const pref = await retainFact(home, { topic: 'x', content: 'y', category: 'preference', halfLifeDays: 30, nowMs: T0 });
    assert.equal(pref.ok, false, 'a preference must never be given a curve');
    const good = await retainFact(home, { topic: 'x', content: 'y', category: 'preference', nowMs: T0 });
    assert.equal(good.ok, true);
    assert.equal(good.fact.decayClass, 'preference');
    assert.equal(good.fact.halfLifeDays, 0);
  });
});

test('memory-engine v3: provenance is recorded automatically', async () => {
  await withHome(async (home) => {
    const res = await retainFact(home, { topic: 'tea', content: 'oolong after noon', sessionId: 'session-x', nowMs: T0 });
    assert.deepEqual(res.fact.provenance, { source: 'chat', sessionId: 'session-x', at: new Date(T0).toISOString() });
    const bili = await retainFact(home, { topic: 'v', content: 'w', source: 'bili', nowMs: T0 });
    assert.equal(bili.fact.provenance.source, 'bili');
    assert.equal(bili.fact.provenance.sessionId, null);
  });
});

// ---------------------------------------------------------------------------
// v3 trust layer (design 2026-11-09 §4–§6)
// ---------------------------------------------------------------------------

test('memory-engine v3: contradictions are parked as conflicts, not co-existing', async () => {
  await withHome(async (home) => {
    const old = await retainFact(home, { topic: '咖啡', content: '搭档不喝咖啡', confidence: 0.9, nowMs: T0 });
    const neu = await retainFact(home, { topic: '咖啡', content: '搭档喝咖啡', confidence: 0.9, nowMs: T0 + 1000 });
    assert.equal(neu.ok, true);
    assert.equal(neu.fact.conflictWith, old.fact.id, 'the new fact must point at the old one');
    assert.equal(neu.fact.confidence, 0.55, 'both sides drop to the hold floor');
    const rows = await readJsonl(home.factsPath);
    const oldRow = rows.find((r) => r.id === old.fact.id);
    assert.equal(oldRow.conflictWith, neu.fact.id);
    assert.equal(oldRow.confidence, 0.55);
    assert.equal(oldRow.invalidatedAt, null, 'parked, not deleted');
    const recall = await recallMemory(home, '咖啡', { nowMs: T0 + 2000, reinforce: false });
    assert.equal(recall.facts.find((f) => f.id === neu.fact.id).confidenceBand, 'conflict');

    // an unrelated fact does not trip the detector
    const other = await retainFact(home, { topic: '茶', content: '搭档不喝浓茶', nowMs: T0 + 3000 });
    assert.equal(other.fact.conflictWith, null);
  });
});

test('memory-engine v3: resolving a conflict restores the winner and retires the loser', async () => {
  await withHome(async (home) => {
    const old = await retainFact(home, { topic: '咖啡', content: '搭档不喝咖啡', confidence: 0.9, nowMs: T0 });
    const neu = await retainFact(home, { topic: '咖啡', content: '搭档喝咖啡', confidence: 0.9, nowMs: T0 + 1000 });
    const res = await resolveConflict(home, { keepId: neu.fact.id, dropId: old.fact.id, reason: '他亲口说的', nowMs: T0 + 2000 });
    assert.equal(res.ok, true);
    const rows = await readJsonl(home.factsPath);
    const winner = rows.find((r) => r.id === neu.fact.id);
    const loser = rows.find((r) => r.id === old.fact.id);
    assert.equal(winner.confidence, 0.9, 'the winner regains its confidence');
    assert.equal(winner.conflictWith, null);
    assert.equal(loser.invalidatedBy, neu.fact.id, 'history kept, not erased');
    assert.equal(loser.conflictWith, null);
    const diary = await readFile(join(home.privateDir, '2026-11-06-inner.md'), 'utf8');
    assert.match(diary, /改口/);
    const again = await resolveConflict(home, { keepId: neu.fact.id, dropId: old.fact.id });
    assert.equal(again.ok, false, 'a resolved pair cannot be resolved twice');
  });
});

test('memory-engine v3: promises run a made → kept/broken/released lifecycle', async () => {
  await withHome(async (home) => {
    const p = await retainFact(home, { kind: 'promise', text: '周五陪你看电影', dueAt: '2026-11-13T12:00:00Z', confidence: 0.9, nowMs: T0 });
    assert.deepEqual(p.fact.promise, { status: 'made', dueAt: '2026-11-13T12:00:00Z', note: null });
    const bad = await updatePromise(home, { id: p.fact.id, action: 'vaporize' });
    assert.equal(bad.ok, false);
    const kept = await updatePromise(home, { id: p.fact.id, action: 'keep', note: '爆米花我买', nowMs: T0 + DAY });
    assert.equal(kept.ok, true);
    assert.equal(kept.status, 'kept');
    const rows = await readJsonl(home.factsPath);
    assert.equal(rows[0].promise.status, 'kept');
    assert.equal(rows[0].promise.note, '爆米花我买');
    const twice = await updatePromise(home, { id: p.fact.id, action: 'break' });
    assert.equal(twice.ok, false, 'a kept promise cannot be un-kept');
    const notPromise = await retainFact(home, { topic: 'x', content: 'y', nowMs: T0 });
    assert.equal((await updatePromise(home, { id: notPromise.fact.id, action: 'keep' })).ok, false);
  });
});

test('memory-engine v3: the presence digest carries promises, conflicts and preferences', async () => {
  await withHome(async (home) => {
    await retainFact(home, { topic: '咖啡', content: '搭档不喝咖啡', nowMs: T0 });
    await retainFact(home, { topic: '咖啡', content: '搭档喝咖啡', nowMs: T0 + 1000 });
    await retainFact(home, { category: 'preference', topic: '冰美式', content: '夏天只喝冰美式', nowMs: T0 + 2000 });
    await retainFact(home, { kind: 'promise', text: '周日一起复盘网关方案', dueAt: '2026-11-01T00:00:00Z', nowMs: T0 + 3000 });
    await recordEpisode(home, { content: '今天一起调通了星云渲染', nowMs: T0 + 4000 });
    const d = await composePresenceDigest(home, { nowMs: T0 + 5000 });
    assert.equal(d.ok, true);
    assert.match(d.text, /承诺/);
    assert.match(d.text, /逾期/);
    assert.match(d.text, /冲突/);
    assert.match(d.text, /偏好：.*冰美式/);
    assert.match(d.text, /最近经历/);
    assert.equal(d.promises, 1);
    assert.equal(d.conflictsOpen, 2);
    assert.ok(d.chars <= 900);
    const tiny = await composePresenceDigest(home, { nowMs: T0 + 5000, maxChars: 160 });
    assert.ok(tiny.chars <= 160, 'the digest honours its ceiling');
    assert.match(tiny.text, /承诺/, 'promises are trimmed last');
  });
});

test('memory-engine v3: polarityOpposite is conservative', async () => {
  assert.equal(polarityOpposite('搭档不喝咖啡', '搭档喝咖啡'), true);
  assert.equal(polarityOpposite('每周三review', '每周四review'), true, 'numbers disagree');
  assert.equal(polarityOpposite('喜欢海', '喜欢山'), false, 'no signal, no guess');
  assert.equal(polarityOpposite('取消了订阅', '取消了订阅'), false);
});

test('memory-engine: handoff / system-noise conflicts auto-resolve (keep newer)', async () => {
  assert.equal(isSystemNoiseText('专属窗交接：专属对话窗写满，交接给下一扇窗。近聊摘录：\n- 你：<system-reminder> cwd'), true);
  assert.equal(shouldAutoResolveConflict(
    { topic: '专属窗交接', text: '专属窗交接：旧摘录 2026-11-13' },
    { topic: '专属窗交接', text: '专属窗交接：新摘录 2026-11-16' },
  ), true);
  assert.equal(shouldAutoResolveConflict(
    { topic: '咖啡', text: '不喝咖啡' },
    { topic: '咖啡', text: '喝咖啡' },
  ), false);

  await withHome(async (home) => {
    // Real preference conflict still parks for the user.
    const prefOld = await retainFact(home, { topic: '咖啡', content: '搭档不喝咖啡', nowMs: T0 });
    const prefNew = await retainFact(home, { topic: '咖啡', content: '搭档喝咖啡', nowMs: T0 + 1000 });
    assert.equal(prefNew.fact.conflictWith, prefOld.fact.id);

    // Handoff noise: incoming row retires the old one instead of parking.
    const h1 = await retainFact(home, {
      topic: '专属窗交接',
      content: '专属对话窗写满，交接给下一扇窗。近聊摘录：\n- 你：<system-reminder> old cwd plugin-sessions 2026-11-13',
      nowMs: T0 + 2000,
    });
    const h2 = await retainFact(home, {
      topic: '专属窗交接',
      content: '专属对话窗写满，交接给下一扇窗。近聊摘录：\n- 你：<system-reminder> new cwd plugin-sessions soulmate-wake 2026-11-16',
      nowMs: T0 + 3000,
    });
    assert.equal(h2.ok, true);
    assert.equal(h2.fact.conflictWith, null, 'noise pair must not park');
    const rows = await readJsonl(home.factsPath);
    const oldHandoff = rows.find((r) => r.id === h1.fact.id);
    assert.equal(oldHandoff.invalidatedBy, h2.fact.id);
    assert.equal(oldHandoff.conflictWith, null);

    const swept = await autoResolveNoiseConflicts(home, { silent: true, nowMs: T0 + 4000 });
    assert.equal(swept.ok, true);
    assert.equal(swept.resolved, 0, 'preference conflicts are not auto-swept');
    const trustAfter = await listTrustItems(home);
    const stillParked = trustAfter.conflicts.some(
      (c) => c.newer?.id === prefNew.fact.id || c.older?.id === prefNew.fact.id
        || c.newer?.id === prefOld.fact.id || c.older?.id === prefOld.fact.id,
    );
    assert.ok(stillParked, 'real preference conflict remains');
  });
});

// ---------------------------------------------------------------------------
// v3 temporal layer (design 2026-11-09 §1.1 / §3.3)
// ---------------------------------------------------------------------------

test('memory-engine v3: recordEpisode mirrors prose into events.jsonl', async () => {
  await withHome(async (home) => {
    const first = await recordEpisode(home, { content: '一起看了 BV1EX4G6zEfC 的视频', title: '看视频', nowMs: T0 });
    assert.equal(first.ok, true);
    const rows = await readJsonl(join(home.memoryDir, 'events.jsonl'));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, `ev_${new Date(T0).toISOString().slice(0, 10)}-to-you`);
    assert.ok(rows[0].tags.includes('video') && rows[0].tags.includes('bili'), 'auto tags from content');
    assert.equal(rows[0].summary, '看视频');
    // a second entry the same day replaces the row, not duplicates it
    await recordEpisode(home, { content: '后来又聊了星云', title: '聊星云', nowMs: T0 + 3600_000 });
    const after = await readJsonl(join(home.memoryDir, 'events.jsonl'));
    assert.equal(after.length, 1);
    assert.equal(after[0].summary, '聊星云');
  });
});

test('memory-engine v3: the temporal channel answers without keyword overlap', async () => {
  await withHome(async (home) => {
    const oct = T0 - 20 * DAY;
    const nov = T0 - 2 * DAY;
    await recordEpisode(home, { content: '在老城墙下走了很久', title: '城墙', date: new Date(oct).toISOString().slice(0, 10), nowMs: oct });
    await recordEpisode(home, { content: '调试渲染到深夜', title: '渲染', date: new Date(nov).toISOString().slice(0, 10), nowMs: nov });
    const out = await recallMemory(home, '上个月我们一起干嘛了', { nowMs: T0, reinforce: false });
    assert.equal(out.temporalWindow, 'last-month');
    const dates = out.episodes.map((e) => e.date);
    assert.ok(dates.includes(new Date(oct).toISOString().slice(0, 10)), 'the October walk is recalled');
    assert.ok(!dates.includes(new Date(nov).toISOString().slice(0, 10)), 'November stays out of the window');
    assert.equal(out.episodes.find((e) => e.via === 'temporal').snippet, '城墙');
    const plain = await recallMemory(home, '城墙', { nowMs: T0, reinforce: false });
    assert.equal(plain.temporalWindow, null);
  });
});

test('memory-engine v3: open promises travel with every recall', async () => {
  await withHome(async (home) => {
    const p = await retainFact(home, { kind: 'promise', text: '周五陪你看电影', nowMs: T0 });
    const out = await recallMemory(home, '完全无关的话题 zzz', { nowMs: T0, reinforce: false });
    assert.deepEqual(out.promises.map((x) => x.id), [p.fact.id]);
    await updatePromise(home, { id: p.fact.id, action: 'keep', nowMs: T0 + 1000 });
    const after = await recallMemory(home, 'zzz', { nowMs: T0 + 2000, reinforce: false });
    assert.deepEqual(after.promises, []);
  });
});

test('memory-engine v3: backfillEventsIndex mirrors legacy diaries once', async () => {
  await withHome(async (home) => {
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(home.episodesDir, { recursive: true });
    await writeFile(
      join(home.episodesDir, '2026-10-01-to-you.md'),
      `---\ndate: 2026-10-01\nkind: to-you\n---\n# 2026-10-01 给你的信\n\n## 10:00 · 第一次一起做饭\n\n糊了但开心。\n`,
      'utf8'
    );
    const first = await backfillEventsIndex(home);
    assert.equal(first.backfilled, true);
    assert.equal(first.events, 1);
    const rows = await readJsonl(join(home.memoryDir, 'events.jsonl'));
    assert.equal(rows[0].summary, '10:00 · 第一次一起做饭');
    const second = await backfillEventsIndex(home);
    assert.equal(second.backfilled, false);
  });
});

test('memory-engine v3: parseTimeWindow maps Chinese time words to local day windows', () => {
  const now = Date.parse('2026-11-10T08:00:00.000Z');
  assert.equal(parseTimeWindow('今天怎么样', now).label, 'today');
  assert.equal(parseTimeWindow('昨天呢', now).label, 'yesterday');
  assert.equal(parseTimeWindow('上周的事', now).label, 'last-week');
  const lm = parseTimeWindow('上个月我们一起干嘛了', now);
  assert.equal(lm.label, 'last-month');
  assert.equal(new Date(lm.fromMs).getDate(), 1, 'windows are local-day aligned');
  assert.equal(parseTimeWindow('2026年3月看过什么', now).label, '2026-3');
  assert.equal(parseTimeWindow('咖啡', now), null);
});

test('memory-engine: upsertSessionEpisode one file per session, overwrite summary', async () => {
  await withHome(async (home) => {
    const a = await upsertSessionEpisode(home, {
      sessionId: 'session-aaa',
      title: '小海海',
      content: '第一版摘要',
      nowMs: T0,
    });
    assert.equal(a.ok, true);
    assert.equal(a.id, 'session:session-aaa');
    const names = await readdir(home.episodesDir);
    assert.ok(names.includes('session__session-aaa.md'));
    assert.equal(names.filter((n) => n.startsWith('session__')).length, 1);

    const b = await upsertSessionEpisode(home, {
      sessionId: 'session-aaa',
      title: '小海海',
      content: '第二版摘要·继续聊插件',
      nowMs: T0 + 1000,
    });
    assert.equal(b.ok, true);
    assert.equal(b.id, 'session:session-aaa');
    assert.equal((await readdir(home.episodesDir)).filter((n) => n.startsWith('session__')).length, 1);

    const eps = await listSessionEpisodes(home);
    const hit = eps.find((e) => e.sessionId === 'session-aaa' || e.id === 'session:session-aaa');
    assert.ok(hit);
    assert.match(hit.body, /第二版摘要/);
    assert.ok(!hit.body.includes('第一版摘要'));
    assert.equal(hit.kind, 'session');
  });
});

test('memory-engine: session star appears in neural graph; forget removes only via forgetMemory', async () => {
  await withHome(async (home) => {
    await upsertSessionEpisode(home, {
      sessionId: 'session-bbb',
      title: '小海海 · 2',
      content: '窗星内容',
      nowMs: T0,
    });
    const g = await buildNeuralGraph(home, { nowMs: T0, cloudSynced: false });
    const node = g.nodes.find((n) => n.id === 'episode:session:session-bbb');
    assert.ok(node);
    assert.equal(node.kind, 'session_star');
    assert.match(node.label, /小海海/);

    // 模拟「删对话框」：不调用 forget → 节点仍在
    const g2 = await buildNeuralGraph(home, { nowMs: T0, cloudSynced: false });
    assert.ok(g2.nodes.some((n) => n.id === 'episode:session:session-bbb'));

    const forgot = await forgetMemory(home, 'episode:session:session-bbb');
    assert.equal(forgot.ok, true);
    const g3 = await buildNeuralGraph(home, { nowMs: T0, cloudSynced: false });
    assert.ok(!g3.nodes.some((n) => n.id === 'episode:session:session-bbb'));
  });
});

test('memory-engine: transcript and IM conversations surface as their own stars', async () => {
  await (async () => {
    const { upsertSessionEpisode } = await import('../packages/soulmate-core/memory-engine.mjs');
    const dir = await mkdtemp(join(tmpdir(), 'sm-transcript-'));
    const home = resolveSoulmateHome(join(dir, 'home'));
    try {
      const { mkdir } = await import('node:fs/promises');
      await mkdir(home.rootDir, { recursive: true });
      await upsertSessionEpisode(home, {
        sessionId: 'transcript:sess-1',
        title: '原文 · 大海',
        kind: 'transcript',
        content: '主人：今天装机翻车了\n我：第几分钟？',
        nowMs: T0,
      });
      await upsertSessionEpisode(home, {
        sessionId: 'im:qq:10001',
        title: 'QQ · 主人',
        kind: 'im',
        content: '对方：晚上吃什么\n我：先别饿着',
        nowMs: T0,
      });
      const g = await buildNeuralGraph(home, { nowMs: T0, cloudSynced: false });
      const transcript = g.nodes.find((n) => n.kind === 'transcript_star');
      const im = g.nodes.find((n) => n.kind === 'session_star');
      assert.ok(transcript, 'transcript star present');
      assert.match(transcript.label, /^原文 · /);
      assert.match(transcript.content, /装机翻车/);
      assert.ok(im, 'im thread becomes a session star');
      assert.match(im.label, /QQ · 主人/);
      assert.match(im.content, /晚上吃什么/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  })();
});
