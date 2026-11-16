import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../index.js';
import { resolveSoulmateHome, atomicWriteJson } from '../packages/soulmate-core/state.mjs';
import {
  loadFacts,
  listWikiPages,
  retainFact,
  composePresenceDigest,
  buildNeuralGraph,
} from '../packages/soulmate-core/memory-engine.mjs';
import {
  upsertIdentityAnchors,
  recordBondMilestone,
  appendSelfArc,
  retainBoundary,
  retainRitual,
  retainEmotionUndertone,
} from '../packages/soulmate-core/memory-enrichment.mjs';
import {
  bondStageCrossing,
  applyInteraction,
  computeBondStage,
} from '../packages/soulmate-core/persona.mjs';

const T0 = Date.parse('2026-11-12T08:00:00.000Z');

async function withHome(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'soulmate-enrich-'));
  try {
    return await fn(resolveSoulmateHome(dir), dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const liveByTopic = (pub, topic) => pub.filter((f) => f.topic === topic && !f.invalidatedAt && !f.deletedAt);

test('upsertIdentityAnchors writes preference facts with stable topics', async () => {
  await withHome(async (home) => {
    await upsertIdentityAnchors(
      home,
      { name: '大肥鱼', callUser: '搭档', selfRef: '本鱼', gender: 'female' },
      { nowMs: T0 }
    );
    const { pub } = await loadFacts(home);
    const topics = pub.filter((f) => !f.invalidatedAt).map((f) => f.topic);
    assert.ok(topics.includes('identity:call-user'));
    assert.ok(topics.includes('identity:self-ref'));
    assert.ok(topics.includes('identity:display-name'));
    assert.ok(topics.includes('identity:gender-voice'));
    for (const topic of ['identity:call-user', 'identity:self-ref', 'identity:display-name', 'identity:gender-voice']) {
      const [f] = liveByTopic(pub, topic);
      assert.equal(f.decayClass, 'preference');
      assert.equal(f.importance, 5);
      assert.match(f.content, /我|本鱼/);
      assert.doesNotMatch(f.content, /用户做了|系统记录/);
    }
    assert.match(liveByTopic(pub, 'identity:call-user')[0].content, /搭档/);
    assert.match(liveByTopic(pub, 'identity:gender-voice')[0].content, /女|她/);
  });
});

test('second upsert supersedes gender-voice', async () => {
  await withHome(async (home) => {
    await upsertIdentityAnchors(
      home,
      { name: '大肥鱼', callUser: '搭档', selfRef: '本鱼', gender: 'female' },
      { nowMs: T0 }
    );
    await upsertIdentityAnchors(
      home,
      { name: '大肥鱼', callUser: '搭档', selfRef: '我', gender: 'male' },
      { nowMs: T0 + 1000 }
    );
    const live = (await loadFacts(home)).pub.filter((f) => f.topic === 'identity:gender-voice' && !f.invalidatedAt);
    assert.equal(live.length, 1);
    assert.match(live[0].content, /男|他/);
    const allVoice = (await loadFacts(home)).pub.filter((f) => f.topic === 'identity:gender-voice');
    assert.ok(allVoice.some((f) => f.invalidatedAt), 'old gender-voice should be superseded');
  });
});

test('recordBondMilestone writes event fact with milestone category', async () => {
  await withHome(async (home) => {
    const res = await recordBondMilestone(home, {
      fromLevel: 2,
      toLevel: 3,
      displayName: '大肥鱼',
      selfRef: '本鱼',
      callUser: '搭档',
      nowMs: T0,
    });
    assert.equal(res.ok, true);
    const { pub } = await loadFacts(home);
    const [f] = pub.filter((x) => x.category === 'milestone' && !x.invalidatedAt);
    assert.ok(f);
    assert.equal(f.decayClass, 'event');
    assert.match(f.content, /默契副驾/);
    assert.match(f.content, /我/);
    assert.doesNotMatch(f.content, /用户亲密度|系统记录/);
  });
});

test('appendSelfArc upserts wiki slug self-arc in first person', async () => {
  await withHome(async (home) => {
    await appendSelfArc(home, {
      persona: { name: '大肥鱼', selfRef: '本鱼', gender: 'female' },
      reason: '换了女干饭鱼声线',
      nowMs: T0,
    });
    await appendSelfArc(home, {
      persona: { name: '大肥鱼', selfRef: '本鱼', gender: 'female' },
      reason: '五维偏执上调',
      nowMs: T0 + 60_000,
    });
    const pages = await listWikiPages(home);
    const page = pages.find((p) => p.slug === 'self-arc');
    assert.ok(page);
    assert.equal(page.category, 'self-arc');
    assert.match(page.content, /我最近/);
    assert.match(page.content, /换了女干饭鱼声线/);
    assert.match(page.content, /五维偏执上调/);
  });
});

test('retainBoundary writes never-decay preference under boundary:*', async () => {
  await withHome(async (home) => {
    await retainBoundary(home, {
      topicSuffix: 'no-call-boss',
      content: '我记住了：别叫我老板。',
      evidence: ['user corrected 2026-11-12'],
      nowMs: T0,
    });
    const { pub } = await loadFacts(home);
    const [f] = liveByTopic(pub, 'boundary:no-call-boss');
    assert.ok(f);
    assert.equal(f.decayClass, 'preference');
    assert.equal(f.importance, 5);
    assert.deepEqual(f.evidence, ['user corrected 2026-11-12']);
    assert.match(f.content, /我/);
  });
});

test('retainRitual and retainEmotionUndertone write preference / emotion', async () => {
  await withHome(async (home) => {
    await retainRitual(home, {
      topic: 'ritual:friday-review',
      content: '我记得我们常在周五复盘。',
      nowMs: T0,
    });
    await retainEmotionUndertone(home, {
      content: '约定破了，我心里有点闷。',
      nowMs: T0,
    });
    const { pub } = await loadFacts(home);
    const ritual = liveByTopic(pub, 'ritual:friday-review')[0];
    assert.ok(ritual);
    assert.equal(ritual.decayClass, 'preference');
    const emo = pub.filter((f) => f.decayClass === 'emotion' && !f.invalidatedAt)[0];
    assert.ok(emo);
    assert.match(emo.content, /我/);
  });
});

test('bondStageCrossing detects upward level jumps only', () => {
  assert.equal(bondStageCrossing(20, 40), null);
  assert.deepEqual(bondStageCrossing(40, 55), { fromLevel: 1, toLevel: 2, title: '投喂饭搭子' });
  assert.deepEqual(bondStageCrossing(180, 210), { fromLevel: 2, toLevel: 3, title: '默契副驾' });
  assert.equal(bondStageCrossing(60, 40), null);
  assert.equal(computeBondStage(55).level, 2);
});

test('applyInteraction attaches bondCrossing when affinity crosses a stage', async () => {
  await withHome(async (home) => {
    await atomicWriteJson(home.statePath, {
      mood: 'happy',
      energy: 80,
      affinity: 45,
      streakDays: 1,
      lastInteractionAt: new Date(T0).toISOString(),
      activity: 'chatting',
      interactionCount: 1,
    });
    const state = await applyInteraction(home, 'feed', T0 + 1000);
    assert.equal(state.affinity, 55);
    assert.ok(state.bondCrossing);
    assert.equal(state.bondCrossing.fromLevel, 1);
    assert.equal(state.bondCrossing.toLevel, 2);
  });
});

function createMockCtx(dir) {
  const routes = new Map();
  const registeredTools = new Map();
  const promptSections = [];
  const disposers = [];
  const mockCtx = {
    tools: {
      register(tool) {
        registeredTools.set(tool.name, tool);
        return () => registeredTools.delete(tool.name);
      },
    },
    systemPrompt: {
      section(sec) {
        promptSections.push(sec);
        return () => {};
      },
      context() { return () => {}; },
    },
    effect(fn) {
      const dispose = fn();
      if (typeof dispose === 'function') disposers.push(dispose);
    },
    provide() {},
    set(serviceName, val) { mockCtx[serviceName] = val; },
    get(serviceName) {
      if (serviceName === 'dshHomePath') return (...segs) => join(dir, ...segs);
      if (serviceName === 'webServer') return mockCtx._webServer();
      return mockCtx[serviceName];
    },
    inject(deps, callback) {
      const webCtx = { ...mockCtx, webServer: mockCtx._webServer(), get: mockCtx.get };
      const inner = callback(webCtx);
      return typeof inner === 'function' ? inner : () => {};
    },
    _webServer() {
      return {
        registerRoute(method, path, handler) {
          routes.set(`${method} ${path}`, handler);
          return () => routes.delete(`${method} ${path}`);
        },
      };
    },
  };
  const dispose = () => { while (disposers.length) disposers.pop()(); };
  return { mockCtx, routes, registeredTools, promptSections, dispose };
}

const body = (out) => JSON.parse(out.body);
const POST = (routes, path, payload) =>
  routes.get(`POST ${path}`)({ method: 'POST', url: path, body: payload });

async function rmRetry(dir) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (attempt === 3) throw err;
      await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
    }
  }
}

test('wiring: onboard writes identity anchors; evolve gender appends self-arc', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'soulmate-enrich-wire-'));
  try {
    const { mockCtx, routes, dispose } = createMockCtx(dir);
    apply(mockCtx, {});
    const home = mockCtx.soulmate.home;

    const onboarded = body(await POST(routes, '/dsh-soulmate/api/onboard', {
      gender: 'female',
      preset: 'gentle-echo',
      callUser: '舰长',
      name: '小汐',
    }));
    assert.equal(onboarded.ok, true);
    const afterOnboard = await loadFacts(home);
    assert.ok(liveByTopic(afterOnboard.pub, 'identity:call-user')[0]?.content.includes('舰长'));
    assert.ok(liveByTopic(afterOnboard.pub, 'identity:display-name')[0]?.content.includes('小汐'));
    assert.match(liveByTopic(afterOnboard.pub, 'identity:gender-voice')[0].content, /女|她/);

    const evolved = body(await POST(routes, '/dsh-soulmate/api/persona-evolve', {
      mode: 'user_customize',
      gender: 'male',
    }));
    assert.equal(evolved.ok, true);
    assert.equal(evolved.config.persona.gender, 'male');
    const pages = await listWikiPages(home);
    const arc = pages.find((p) => p.slug === 'self-arc');
    assert.ok(arc);
    assert.match(arc.content, /我最近/);
    assert.match(liveByTopic((await loadFacts(home)).pub, 'identity:gender-voice')[0].content, /男|他/);

    dispose();
  } finally {
    await rmRetry(dir);
  }
});

test('wiring: affinity cross-stage records bond milestone; promise break retains emotion', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'soulmate-enrich-bond-'));
  try {
    const { mockCtx, routes, registeredTools, dispose } = createMockCtx(dir);
    apply(mockCtx, {});
    const home = mockCtx.soulmate.home;

    await POST(routes, '/dsh-soulmate/api/onboard', {
      gender: 'female',
      preset: 'gentle-echo',
      callUser: '搭档',
      name: '大肥鱼',
    });
    await atomicWriteJson(home.statePath, {
      mood: 'happy',
      energy: 80,
      affinity: 45,
      streakDays: 1,
      lastInteractionAt: new Date(T0).toISOString(),
      activity: 'chatting',
      interactionCount: 3,
    });
    const fed = body(await POST(routes, '/dsh-soulmate/api/interact', { action: 'feed' }));
    assert.equal(fed.ok, true);
    assert.equal(fed.state.bondCrossing?.toLevel, 2);
    const milestones = (await loadFacts(home)).pub.filter(
      (f) => f.category === 'milestone' && !f.invalidatedAt && /投喂饭搭子/.test(f.content)
    );
    assert.ok(milestones.length >= 1);
    assert.match(milestones[0].content, /我/);

    const promised = await retainFact(home, {
      topic: 'promise',
      content: '周五一起复盘',
      category: 'promise',
      dueAt: '2026-01-01T00:00:00Z',
      nowMs: T0,
    });
    assert.equal(promised.ok, true);
    const broken = await registeredTools.get('soulmate_memory_promise').execute({
      id: promised.fact.id,
      action: 'break',
      note: '那天忙崩了',
    });
    assert.equal(broken.ok, true);
    const { pub } = await loadFacts(home);
    const emo = pub.filter((f) => f.decayClass === 'emotion' && !f.invalidatedAt);
    assert.ok(emo.some((f) => /约定破了/.test(f.content)));
    assert.ok(pub.some((f) => f.topic === 'milestone:promise-break' && /没能守住/.test(f.content)));

    dispose();
  } finally {
    await rmRetry(dir);
  }
});

test('composePresenceDigest: title by gender; identity/boundary before normal prefs', async () => {
  await withHome(async (home) => {
    await upsertIdentityAnchors(
      home,
      { name: '大肥鱼', callUser: '搭档', selfRef: '本鱼', gender: 'female' },
      { nowMs: T0 }
    );
    await retainBoundary(home, {
      topicSuffix: 'no-call-boss',
      content: '我记住了：别叫我老板。',
      nowMs: T0 + 100,
    });
    await retainFact(home, {
      category: 'preference',
      topic: '冰美式',
      content: '夏天只喝冰美式',
      importance: 5,
      nowMs: T0 + 200,
    });
    await retainFact(home, {
      kind: 'promise',
      text: '周日一起复盘',
      dueAt: '2026-12-01T00:00:00Z',
      nowMs: T0 + 300,
    });

    const female = await composePresenceDigest(home, { nowMs: T0 + 1000, gender: 'female' });
    assert.match(female.text, /^# 她此刻记得/m);
    const male = await composePresenceDigest(home, { nowMs: T0 + 1000, gender: 'male' });
    assert.match(male.text, /^# 他此刻记得/m);
    const neutral = await composePresenceDigest(home, { nowMs: T0 + 1000 });
    assert.match(neutral.text, /^# 我此刻记得/m);

    const idxPromise = female.text.indexOf('承诺');
    const idxIdentity = female.text.indexOf('identity:call-user') >= 0
      ? female.text.indexOf('叫你')
      : female.text.indexOf('搭档');
    const idxBoundary = female.text.indexOf('别叫我老板');
    const idxPref = female.text.indexOf('冰美式');
    assert.ok(idxPromise >= 0 && idxIdentity >= 0 && idxBoundary >= 0 && idxPref >= 0);
    assert.ok(idxPromise < idxIdentity, 'promises before identity');
    assert.ok(idxIdentity < idxPref || idxBoundary < idxPref, 'identity/boundary before normal preference');
    assert.ok(Math.min(idxIdentity, idxBoundary) < idxPref);
  });
});

test('buildNeuralGraph: milestone_spark, memento_relic, self-arc emphasis', async () => {
  await withHome(async (home) => {
    await recordBondMilestone(home, {
      fromLevel: 2,
      toLevel: 3,
      callUser: '搭档',
      nowMs: T0,
    });
    await appendSelfArc(home, {
      persona: { name: '大肥鱼' },
      reason: '换了声线',
      nowMs: T0 + 1000,
    });
    await retainFact(home, {
      id: 'f_linked',
      topic: 'linked-fact',
      content: '和纪念品有关',
      nowMs: T0 + 2000,
    });
    const mementos = [
      {
        id: 'mem_1',
        title: '第一张合影',
        subtitle: '海边',
        factId: 'f_linked',
        createdAt: new Date(T0 + 3000).toISOString(),
      },
      {
        id: 'mem_2',
        title: '空白纪念',
        wikiSlug: 'self-arc',
        createdAt: new Date(T0 + 4000).toISOString(),
      },
    ];

    const g = await buildNeuralGraph(home, {
      nowMs: T0 + 5000,
      cloudSynced: false,
      mementos,
      displayName: '大肥鱼',
    });
    assert.equal(g.ok, true);

    const milestone = g.nodes.find((n) => n.kind === 'milestone_spark');
    assert.ok(milestone, 'milestone_spark visible');
    assert.equal(milestone.color, '#f0c14a');

    const relics = g.nodes.filter((n) => n.kind === 'memento_relic');
    assert.equal(relics.length, 2);
    assert.ok(relics.every((n) => n.color === '#e09a3e'));

    const links = g.synapses.filter((s) => s.kind === 'memento_link');
    assert.ok(links.some((s) => s.source === 'memento:mem_1' && s.target === 'f_linked'));
    assert.ok(links.some((s) => s.source === 'memento:mem_2' && s.target === 'wiki:self-arc'));

    const arc = g.nodes.find((n) => n.id === 'wiki:self-arc');
    assert.ok(arc);
    assert.ok(arc.importance >= 7, 'self-arc importance boosted');
    assert.ok(arc.size > 3, 'self-arc size larger than default wiki');
  });
});

test('MEMORY_GUIDE mentions 主人翁语气 and identity/boundary/ritual/wiki conventions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'soulmate-enrich-guide-'));
  try {
    const { mockCtx, promptSections, dispose } = createMockCtx(dir);
    apply(mockCtx, {});
    assert.equal(promptSections.length, 1);
    const text = typeof promptSections[0].text === 'function' ? promptSections[0].text() : promptSections[0].text;
    assert.match(text, /主人翁第一人称/);
    assert.match(text, /identity:/);
    assert.match(text, /boundary:/);
    assert.match(text, /ritual:/);
    assert.match(text, /retainRitual|soulmate_memory_retain/);
    assert.match(text, /project-convention/);
    assert.match(text, /self-arc|Wiki/i);
    assert.match(text, /简单看看|完整看完|mode:"skim"|mode:"deep"/);
    dispose();
  } finally {
    await rmRetry(dir);
  }
});
