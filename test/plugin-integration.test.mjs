import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, name, inject, renderSoulmateHomeHtml } from '../index.js';
import { startMockAigcServer } from '../server-mock/aigc-mock-server.mjs';

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

/** Mock Cordis context mirroring the plan; `webServerKind` selects the HTTP registration style. */
function createMockCtx(dir, { webServerKind = 'registerRoute' } = {}) {
  const registeredTools = new Map();
  const promptSections = [];
  const promptContexts = [];
  const disposers = [];
  const routes = new Map();
  const prefixes = [];
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
        return () => {
          const idx = promptSections.indexOf(sec);
          if (idx >= 0) promptSections.splice(idx, 1);
        };
      },
      context(ctxSec) {
        promptContexts.push(ctxSec);
        return () => {
          const idx = promptContexts.indexOf(ctxSec);
          if (idx >= 0) promptContexts.splice(idx, 1);
        };
      },
    },
    effect(fn) {
      const dispose = fn();
      if (typeof dispose === 'function') disposers.push(dispose);
    },
    provide() {},
    set(serviceName, val) {
      mockCtx[serviceName] = val;
    },
    get(serviceName) {
      if (serviceName === 'dshHomePath') return (...segs) => join(dir, ...segs);
      if (serviceName === 'webServer') return mockCtx._webServer();
      return mockCtx[serviceName];
    },
    // Mirrors Cordis: required deps must exist (missing = loud failure); a dep marked
    // { required: false } may be absent — the fork still runs and sees it undefined.
    inject(deps, callback) {
      const entries = Array.isArray(deps) ? deps.map((d) => [d, {}]) : Object.entries(deps || {});
      for (const [dep, spec] of entries) {
        if (dep === 'webServer') continue;
        // Cordis array-inject *waits* for the service instead of throwing; a host
        // without `llm` simply never runs the child. The mock models that as a no-op.
        if (dep === 'llm' && mockCtx.get(dep) === undefined && mockCtx[dep] === undefined) {
          return () => {};
        }
        if (spec && spec.required === false) continue;
        if (mockCtx.get(dep) === undefined && mockCtx[dep] === undefined) {
          throw new Error(`mock inject missing ${dep}`);
        }
      }
      const webCtx = {
        ...mockCtx,
        webServer: mockCtx._webServer(),
        get: mockCtx.get,
      };
      const inner = callback(webCtx);
      return typeof inner === 'function' ? inner : () => {};
    },
    _webServer() {
      if (webServerKind === 'registerRoute') {
        return {
          registerRoute(method, path, handler) {
            routes.set(`${method} ${path}`, handler);
            return () => routes.delete(`${method} ${path}`);
          },
        };
      }
      return {
        register(entry) {
          prefixes.push(entry);
          return () => prefixes.splice(prefixes.indexOf(entry), 1);
        },
      };
    },
  };
  const dispose = () => {
    while (disposers.length) disposers.pop()();
  };
  return { mockCtx, registeredTools, promptSections, promptContexts, routes, prefixes, dispose };
}

const body = (out) => JSON.parse(out.body);
const GET = (routes, path) => routes.get(`GET ${path}`)({ method: 'GET', url: path });
const POST = (routes, path, payload, headers) =>
  routes.get(`POST ${path}`)({ method: 'POST', url: path, body: payload, ...(headers ? { headers } : {}) });

test('plugin-integration: registers tools, systemPrompt, ctx.soulmate service, and API routes with full cleanup on dispose', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'soulmate-int-'));
  try {
    assert.equal(name, 'dsh-plugin-whale-soulmate');
    assert.deepEqual(inject, ['tools', 'systemPrompt']);

    const { mockCtx, registeredTools, promptSections, promptContexts, routes, dispose } = createMockCtx(dir);
    apply(mockCtx, {});

    assert.equal(promptContexts.length, 1, 'drift anchor context registered');

    assert.ok(registeredTools.has('soulmate_memory_recall'));
    assert.ok(registeredTools.has('soulmate_memory_retain'));
    assert.ok(registeredTools.has('soulmate_memory_reflect'));
    assert.ok(registeredTools.has('soulmate_memory_forget'));
    assert.ok(registeredTools.has('soulmate_status_interact'));
    assert.ok(registeredTools.has('soulmate_persona_evolve'));
    assert.ok(registeredTools.has('soulmate_video_watch'));
    assert.ok(registeredTools.has('soulmate_video_surf'));
    assert.ok(registeredTools.has('soulmate_im_send'));
    assert.ok(registeredTools.has('soulmate_im_manage'));
    assert.equal(registeredTools.size, 22, '10 v1 + bili_manage + bili_action + 2 trust + weather + 7 official-qq tools');
    assert.ok(registeredTools.has('soulmate_bili_action'));
    assert.ok(registeredTools.has('soulmate_memory_promise'));
    assert.ok(registeredTools.has('soulmate_memory_resolve_conflict'));
    assert.ok(routes.has('POST /dsh-soulmate/api/video-watch'));
    assert.ok(routes.has('GET /dsh-soulmate/api/presence'));
    assert.ok(routes.has('GET /dsh-soulmate/api/conflicts'));
    assert.ok(routes.has('POST /dsh-soulmate/api/conflicts'));
    assert.ok(routes.has('GET /dsh-soulmate/api/promises'));
    assert.ok(routes.has('POST /dsh-soulmate/api/promises'));
    assert.ok(mockCtx.soulmate);
    // 3D 家园暂停开发：路由不再挂载。
    assert.ok(!routes.has('GET /soulmate-home'));
    assert.ok(!routes.has('GET /soulmate-home/'));
    assert.ok(routes.has('GET /dsh-soulmate/api/neural-graph'));

    // The service contract promised to phase-2 extensions.
    for (const fn of [
      'getPersonaPrompt',
      'getState',
      'interact',
      'evolvePersona',
      'resetPersona',
      'retainFact',
      'recordEpisode',
      'recall',
      'reflect',
      'forget',
      'getNeuralGraph',
      'syncCloud',
      'registerExtension',
    ]) {
      assert.equal(typeof mockCtx.soulmate[fn], 'function', `ctx.soulmate.${fn}`);
    }

    // Execute interact tool to name the companion and feed her
    const interactTool = registeredTools.get('soulmate_status_interact');
    const feedRes = await interactTool.execute({ action: 'feed', setName: '小汐', setCallUser: '阿澈' });
    assert.equal(feedRes.ok, true);
    assert.equal(feedRes.notebooks.innerTitle, '《小汐的小本本》');
    assert.equal(feedRes.notebooks.publicTitle, '《给阿澈的信》');
    assert.equal(feedRes.state.mood, 'happy');
    assert.equal(feedRes.bondStage.level, 1);

    // Tool schemas are standard JSON Schema compiled by the inline defineTool
    const params = interactTool.parameters;
    assert.equal(params.type, 'object');
    assert.deepEqual(params.required, ['action']);
    assert.deepEqual(params.properties.action.enum, ['feed', 'pat', 'tap', 'nuzzle', 'chat', 'work_assist', 'sleep']);
    await assert.rejects(() => interactTool.execute({}), /missing required argument "action"/);
    await assert.rejects(() => interactTool.execute({ action: 'dance' }), /must be one of/);

    await mockCtx.soulmate.ready;
    // Clean dispose
    dispose();
    assert.equal(registeredTools.size, 0, 'tools removed');
    assert.equal(routes.size, 0, 'routes removed');
    assert.equal(promptSections.length, 0, 'prompt section removed');
    assert.equal(promptContexts.length, 0, 'drift anchor context removed');
    assert.equal(mockCtx.soulmate, undefined, 'service removed');
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('plugin-integration: dynamic persona system-prompt section follows name, evolved traits and dual-track protocol', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'soulmate-prompt-'));
  try {
    const { mockCtx, promptSections, dispose } = createMockCtx(dir);
    apply(mockCtx, {});
    await mockCtx.soulmate.ready;
    assert.equal(promptSections.length, 1);
    const section = promptSections[0];
    const sectionText = (ctx = {}) => (typeof section.text === 'function' ? section.text(ctx) : section.text);

    assert.match(sectionText(), /《soulmate的小本本》/);
    assert.match(sectionText(), /Dual-Track Co-Pilot Protocol/);
    assert.match(sectionText(), /作为一个AI/);
    assert.match(sectionText(), /soulmate_memory_recall/);

    await mockCtx.soulmate.interact('pat', { setName: '小汐', setCallUser: '阿澈' });
    assert.match(sectionText(), /《小汐的小本本》/);
    assert.match(sectionText(), /《给阿澈的信》/);
    assert.match(await mockCtx.soulmate.getPersonaPrompt(), /「小汐」/);

    await mockCtx.soulmate.evolvePersona({ mode: 'self_growth', learned: ['先给补丁再吐槽'] });
    // Red line: self_growth queues candidates only — prompt must NOT absorb the trait yet.
    assert.doesNotMatch(sectionText(), /先给补丁再吐槽/);
    const { readFile } = await import('node:fs/promises');
    const candidates = (await readFile(mockCtx.soulmate.home.candidatesPath, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(candidates.length, 1);
    assert.deepEqual(candidates[0].learned, ['先给补丁再吐槽']);
    assert.equal(candidates[0].status, 'pending');

    // personaOncePerSession -> second call in the same session is a one-line stub
    await mockCtx.soulmate.evolvePersona({ mode: 'user_customize', persona: {} });
    const { saveConfigAuto } = await import('../packages/soulmate-core/state.mjs');
    await saveConfigAuto(mockCtx.soulmate.home, { persona: { personaOncePerSession: true } });
    const first = await mockCtx.soulmate.getPersonaPrompt({ sessionId: 's1' });
    const second = await mockCtx.soulmate.getPersonaPrompt({ sessionId: 's1' });
    assert.ok(first.length > 500);
    assert.ok(second.length < 200);
    assert.match(second, /小汐/);
    dispose();
  } finally {
    // Debounced pet-state writes can land mid-teardown on Windows; retry instead of
    // letting an ENOTEMPTY mask the real assertion error.
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        break;
      } catch (err) {
        if (err?.code !== 'ENOTEMPTY' || attempt === 3) throw err;
        await new Promise((r) => setTimeout(r, 60));
      }
    }
  }
});

test('plugin-integration: drift anchor re-injects a terse persona every N steps and can be switched off', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'soulmate-anchor-'));
  try {
    const { mockCtx, promptContexts, dispose } = createMockCtx(dir);
    apply(mockCtx, {});
    await mockCtx.soulmate.ready;

    assert.equal(promptContexts.length, 1);
    const anchor = promptContexts[0];
    assert.equal(anchor.name, 'soulmate:drift-anchor');
    assert.equal(typeof anchor.text, 'function', 'text is re-evaluated per assembly');
    assert.ok(anchor.order > 125, 'lands after the first-party runtime contexts');

    // Default everyTurns=8: eight identical steps, then the serial number bumps.
    const first = anchor.text();
    assert.match(first, /人设重锚 #1/);
    assert.match(first, /「soulmate」/);
    assert.ok(first.length < 400);
    for (let step = 2; step <= 8; step += 1) assert.equal(anchor.text(), first);
    const second = anchor.text();
    assert.match(second, /人设重锚 #2/);
    // DSH re-reads runtime context before admission (no toolSet); that must not advance the cadence.
    assert.equal(anchor.text({ modelSelection: { provider: 'x', model: 'y' } }), second);
    assert.match(anchor.text({ toolSet: {} }), /人设重锚 #2/);

    // Renaming flows into the anchor after a refresh.
    await mockCtx.soulmate.interact('pat', { setName: '小汐', setCallUser: '阿澈' });
    const renamed = anchor.text();
    assert.match(renamed, /「小汐」/);
    assert.match(renamed, /「阿澈」/);

    // Off switch: provider returns empty text and the section is dropped from the snapshot.
    const { saveConfigAuto } = await import('../packages/soulmate-core/state.mjs');
    await saveConfigAuto(mockCtx.soulmate.home, { persona: { driftAnchor: { enabled: false } } });
    await mockCtx.soulmate.interact('chat');
    assert.equal(anchor.text(), '');
    dispose();
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('soulmate_persona_evolve: customize name, self-growth, appearance and the three safe reset tiers', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'soulmate-evolve-'));
  try {
    const { mockCtx, registeredTools, dispose } = createMockCtx(dir);
    apply(mockCtx, {});
    const evolve = registeredTools.get('soulmate_persona_evolve');
    assert.ok(evolve);

    // user_customize: the notebook title follows the name
    const custom = await evolve.execute({ mode: 'user_customize', name: '小汐', callUser: '阿澈', preset: 'geek-partner' });
    assert.equal(custom.ok, true);
    assert.equal(custom.notebooks.innerTitle, '《小汐的小本本》');
    assert.equal(custom.notebooks.publicTitle, '《给阿澈的信》');
    assert.equal(custom.persona.preset, 'geek-partner');
    // Continuity guard (§6): a preset switch blends toward the preset instead of
    // snapping onto it, so `sassiness` lands between the old and the preset value.
    const sass = custom.persona.traits.sassiness;
    assert.notEqual(sass, 85, 'must not snap to the preset 85 in one switch');

    // Explicit slider values are user sovereignty and land verbatim.
    const explicit = await evolve.execute({ mode: 'user_customize', traits: { sassiness: 85 } });
    assert.equal(explicit.persona.traits.sassiness, 85);

    // self_growth: queues candidates only — traits / deltas stay unchanged (red line)
    const growth = await evolve.execute({
      mode: 'self_growth',
      learned: ['先给修复补丁再吐槽'],
      traitDeltas: { sassiness: 40, brevity: -10 },
      reason: '陪排障 10 次',
    });
    assert.equal(growth.ok, true);
    assert.deepEqual(growth.persona.evolvedTraits, []);
    assert.deepEqual(growth.persona.traitDeltas, {});
    const { readFile: readFileGrowth } = await import('node:fs/promises');
    const growthCandidates = (await readFileGrowth(mockCtx.soulmate.home.candidatesPath, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(growthCandidates.at(-1).learned[0], '先给修复补丁再吐槽');
    assert.equal(growthCandidates.at(-1).traitDeltas.sassiness, 25, 'candidate deltas clamped to ±25');
    assert.equal(growthCandidates.at(-1).traitDeltas.brevity, -10);
    assert.equal(growthCandidates.at(-1).status, 'pending');

    // appearance
    const look = await evolve.execute({
      mode: 'appearance',
      formPreset: 'neko-hacker',
      primaryColor: '#ff2a85',
      scale: 1.4,
      accessories: { holoHeadset: true, ironBowl: false },
    });
    assert.equal(look.ok, true);
    assert.equal(look.appearance.formPreset, 'neko-hacker');
    assert.equal(look.appearance.primaryColor, '#ff2a85');
    assert.equal(look.appearance.scale, 1.4);
    assert.equal(look.appearance.accessories.holoHeadset, true);
    assert.equal(look.appearance.accessories.ironBowl, false);

    // bad input fails loudly
    await assert.rejects(() => evolve.execute({ mode: 'appearance', formPreset: 'dragon' }), /formPreset/);
    await assert.rejects(() => evolve.execute({ mode: 'user_customize', preset: 'nope' }), /preset/);

    // lock self evolution -> growth is skipped, nothing drifts
    await evolve.execute({ mode: 'user_customize', allowSelfEvolution: false });
    const locked = await evolve.execute({ mode: 'self_growth', learned: ['不该出现'] });
    assert.equal(locked.ok, true);
    assert.equal(locked.skipped, true);
    assert.ok(!locked.persona.evolvedTraits.includes('不该出现'));
    await evolve.execute({ mode: 'user_customize', allowSelfEvolution: true });

    // tier A: reset_growth keeps name/preset/appearance, clears learned traits
    const a = await evolve.execute({ mode: 'reset_growth' });
    assert.equal(a.ok, true);
    assert.equal(typeof a.snapshotFile, 'string');
    assert.deepEqual(a.persona.evolvedTraits, []);
    assert.deepEqual(a.persona.traitDeltas, {});
    assert.equal(a.persona.name, '小汐');
    assert.equal(a.persona.preset, 'geek-partner');
    assert.equal(a.appearance.formPreset, 'neko-hacker');

    // tier B: reset_persona -> factory persona + look, notebook title back to 《soulmate的小本本》
    const b = await evolve.execute({ mode: 'reset_persona' });
    assert.equal(b.ok, true);
    assert.equal(b.persona.name, '');
    assert.equal(b.persona.preset, 'blank-custom');
    assert.equal(b.appearance.formPreset, 'astral-orb');
    assert.equal(b.notebooks.innerTitle, '《soulmate的小本本》');

    // tier C needs an explicit confirmation
    const c1 = await evolve.execute({ mode: 'full_rebirth' });
    assert.equal(c1.ok, false);
    assert.match(c1.error, /confirm/);
    await mockCtx.soulmate.interact('feed');
    const c2 = await evolve.execute({ mode: 'full_rebirth', confirm: true });
    assert.equal(c2.ok, true);
    assert.equal(c2.state.affinity, 0);

    // tool result card meta for the chat UI
    const meta = evolve.output.presentationMeta({}, c2);
    assert.equal(meta.kind, 'dsh-plugins-soulmate');
    assert.equal(meta.tool, 'soulmate_persona_evolve');

    dispose();
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('memory tools: retain/recall/reflect/forget with privacy guardrails, and the neural-graph route', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'soulmate-mem-'));
  try {
    const { mockCtx, registeredTools, routes, dispose } = createMockCtx(dir);
    apply(mockCtx, {});
    const t = (n) => registeredTools.get(n);

    const f1 = await t('soulmate_memory_retain').execute({ topic: '咖啡', content: '主人不喝咖啡', importance: 4 });
    assert.equal(f1.ok, true);
    const f2 = await t('soulmate_memory_retain').execute({ topic: '咖啡', content: '主人最近每天早上喝美式', supersedesId: f1.fact.id });
    assert.equal(f2.ok, true);
    const priv = await t('soulmate_memory_retain').execute({ topic: '心事', content: '主人偷偷在学吉他', visibility: 'private', importance: 5 });
    assert.equal(priv.storedIn, 'private');

    // secrets are hard-blocked
    const blocked = await t('soulmate_memory_retain').execute({ topic: 'key', content: 'my key is sk-testonly-privacy-firewall-sample-key02' });
    assert.equal(blocked.ok, false);
    assert.ok(blocked.blockedReason);

    // diary entries use the dynamic notebook titles
    await t('soulmate_status_interact').execute({ action: 'chat', setName: '小汐', setCallUser: '阿澈' });
    const letter = await t('soulmate_memory_retain').execute({ kind: 'to-you', content: '今天陪阿澈修好了一个 bug', title: '小确幸' });
    assert.equal(letter.ok, true);
    const inner = await t('soulmate_memory_retain').execute({ kind: 'inner', content: '其实有点想被夸', visibility: 'private' });
    assert.equal(inner.ok, true);

    const wiki = await t('soulmate_memory_reflect').execute({
      slug: 'owner-profile',
      title: '主人画像',
      summary: '喜欢美式、在学吉他',
      content: '主人早上喝美式咖啡，见 [[shared-bond]]。',
      learned: ['记得问候早餐'],
      traitDeltas: { clinginess: 5 },
    });
    assert.equal(wiki.ok, true);
    assert.equal(wiki.growth.applied, false, 'red line: reflect growth is queued, not applied');
    assert.equal(wiki.growth.queued, true);
    assert.deepEqual(wiki.growth.candidate.learned, ['记得问候早餐']);
    await t('soulmate_memory_reflect').execute({ slug: 'shared-bond', title: '共同默契', content: '先给补丁再吐槽' });

    // recall: new fact wins, invalidated one is gone, private is recallable locally
    const rec = await t('soulmate_memory_recall').execute({ query: '咖啡' });
    assert.equal(rec.ok, true);
    assert.ok(rec.facts.some((f) => f.id === f2.fact.id));
    assert.ok(!rec.facts.some((f) => f.id === f1.fact.id));
    assert.ok(rec.wiki.some((w) => w.slug === 'owner-profile'));
    assert.ok(rec.linkedWiki.some((w) => w.slug === 'shared-bond'));
    // v3 (§12): a memory with no quoted source must NOT be given one.
    assert.equal(rec.evidenceCount, 0, 'no fabricated provenance for rows that never carried evidence');

    // ...and a memory that *did* carry a quote comes back able to say where it came from.
    const traced = await t('soulmate_memory_retain').execute({
      topic: '关灯',
      content: '主人睡觉必须开着小夜灯',
      importance: 4,
      evidence: ['我从小就怕黑，晚上不敢关灯'],
    });
    assert.equal(traced.ok, true);
    const recTraced = await t('soulmate_memory_recall').execute({ query: '关灯 怕黑' });
    const hit = recTraced.facts.find((f) => f.id === traced.fact.id);
    assert.ok(hit, 'the traced fact is recallable');
    assert.ok(hit.evidenceNote, 'the hit carries the sentence it came from');
    assert.match(hit.evidenceNote, /怕黑/);
    assert.ok(recTraced.evidenceCount >= 1, 'the card can report how many hits are traceable');
    const rec2 = await t('soulmate_memory_recall').execute({ query: '吉他', includePrivate: true });
    assert.ok(rec2.facts.some((f) => f.id === priv.fact.id));
    const rec3 = await t('soulmate_memory_recall').execute({ query: '吉他', includePrivate: false });
    assert.equal(rec3.facts.length, 0);

    // neural graph route
    const graphOut = await GET(routes, '/dsh-soulmate/api/neural-graph');
    assert.equal(graphOut.status, 200);
    assert.match(graphOut.headers['content-type'], /application\/json/);
    const graph = body(graphOut);
    assert.equal(graph.ok, true);
    assert.ok(graph.nodes.some((n) => n.kind === 'wiki_star' && n.color === '#00f2fe'));
    assert.ok(graph.nodes.some((n) => n.kind === 'fact_neuron' && n.color === '#4facfe'));
    const shielded = graph.nodes.find((n) => n.id === priv.fact.id);
    assert.equal(shielded.shielded, true);
    assert.equal(shielded.color, '#ffd700');
    assert.ok(graph.synapses.some((s) => s.kind === 'wiki_link'));
    assert.equal(graph.nodes.filter((n) => n.zone === 'remote_nebula').length, 0, 'no cloud ring without consent');
    assert.equal(graph.cloud.consentGiven, false);
    assert.ok(graph.events.some((e) => e.type === 'retain'));
    // inner diary is readable at any affinity
    const innerNode = graph.nodes.find((n) => n.kind === 'episode_crystal' && /-inner$/.test(n.id));
    assert.notEqual(innerNode.locked, true);
    assert.ok(innerNode.content.includes('被夸'));
    await t('soulmate_persona_evolve').execute({ mode: 'user_customize', gender: 'male' });
    const graphMale = body(await GET(routes, '/dsh-soulmate/api/neural-graph'));
    const innerMale = graphMale.nodes.find((n) => n.kind === 'episode_crystal' && /-inner$/.test(n.id));
    assert.ok(innerMale.content.includes('被夸'));

    // memory-node surgery
    const reinforced = body(await POST(routes, '/dsh-soulmate/api/memory-node', { action: 'reinforce', id: f2.fact.id }));
    assert.equal(reinforced.ok, true);
    assert.ok(reinforced.fact.recallCount >= 2);
    const toggled = body(await POST(routes, '/dsh-soulmate/api/memory-node', { action: 'toggle_private', id: f2.fact.id }));
    assert.equal(toggled.visibility, 'private');
    const graph2 = body(await GET(routes, '/dsh-soulmate/api/neural-graph'));
    assert.equal(graph2.nodes.find((n) => n.id === f2.fact.id).shielded, true);
    const bad = await POST(routes, '/dsh-soulmate/api/memory-node', { action: 'explode', id: f2.fact.id });
    assert.equal(bad.status, 400);

    // forget
    const forgotten = await t('soulmate_memory_forget').execute({ id: f2.fact.id });
    assert.equal(forgotten.ok, true);
    const nope = await t('soulmate_memory_forget').execute({ id: 'f_missing' });
    assert.equal(nope.ok, false);
    const graph3 = body(await GET(routes, '/dsh-soulmate/api/neural-graph'));
    assert.ok(!graph3.nodes.some((n) => n.id === f2.fact.id));
    const viaRoute = body(await POST(routes, '/dsh-soulmate/api/memory-node', { action: 'forget', id: priv.fact.id }));
    assert.equal(viaRoute.ok, true);
    assert.ok(viaRoute.eventSeq > 0);

    // recall route (animation helper) does not fire its own bus event
    const before = body(await GET(routes, '/dsh-soulmate/api/neural-graph')).eventSeq;
    const search = body(await routes.get('GET /dsh-soulmate/api/recall')({ method: 'GET', url: '/dsh-soulmate/api/recall?q=%E5%92%96%E5%95%A1&reinforce=0' }));
    assert.equal(search.ok, true);
    assert.ok(search.ids.length >= 1);
    assert.equal(body(await GET(routes, '/dsh-soulmate/api/neural-graph')).eventSeq, before);

    dispose();
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('home APIs: 3D page unmounted (paused); state/interact/evolve/onboard/sync APIs behave', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'soulmate-http-'));
  try {
    const { mockCtx, routes, dispose } = createMockCtx(dir);
    // 本测试只验 API：关掉开机问候，避免引导完成后的异步问候与临时目录清理竞态。
    apply(mockCtx, {});
    await mockCtx.soulmate.ready;
    const { saveConfigAuto } = await import('../packages/soulmate-core/state.mjs');
    await saveConfigAuto(mockCtx.soulmate.home, { chatHome: { bootGreeting: false } });
    // 路由挂载与 ready 异步：等 API 路由出现再继续（旧版靠 3D 路由让出事件循环，现已下线）。
    for (let i = 0; i < 200 && !routes.has('GET /dsh-soulmate/api/state'); i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }

    // 3D 家园暂停开发：页面路由不挂载，API 不受影响。
    assert.ok(!routes.has('GET /soulmate-home'));
    assert.ok(!routes.has('GET /soulmate-home/'));

    const state = body(await GET(routes, '/dsh-soulmate/api/state'));
    assert.equal(state.ok, true);
    assert.equal(state.config.persona.preset, 'blank-custom');
    assert.equal(state.bondStage.level, 1);
    assert.ok(state.notebooks.publicTitle.startsWith('《给'));
    assert.ok(Array.isArray(state.extensions));
    assert.equal(state.presets.length, 10);
    assert.ok(!JSON.stringify(state).includes('apiKey":"sk'));

    // zero-friction onboarding: auto-saves and flips onboardingCompleted
    const onboarded = body(await POST(routes, '/dsh-soulmate/api/onboard', { gender: 'female', callUser: '舰长', preset: 'gentle-echo', name: '小汐' }));
    assert.equal(onboarded.ok, true);
    assert.equal(onboarded.config.onboardingCompleted, true);
    assert.equal(onboarded.config.persona.gender, 'female');
    assert.equal(onboarded.config.persona.preset, 'gentle-echo');
    assert.equal(onboarded.config.persona.callUser, '舰长');
    assert.equal(onboarded.config.persona.name, '小汐');
    assert.equal(onboarded.notebooks.innerTitle, '《小汐的小本本》');
    assert.ok(state.presets.every((p) => p.gender === 'female' || p.gender === 'male'));

    // interact
    const fed = body(await POST(routes, '/dsh-soulmate/api/interact', { action: 'feed' }));
    assert.equal(fed.ok, true);
    assert.equal(fed.state.activity, 'eating_rice');
    const badAct = await POST(routes, '/dsh-soulmate/api/interact', { action: 'dance' });
    assert.equal(badAct.status, 400);

    // persona-evolve (customize + reset)
    const ev = body(await POST(routes, '/dsh-soulmate/api/persona-evolve', { mode: 'appearance', formPreset: 'astral-orb' }));
    assert.equal(ev.config.appearance.formPreset, 'astral-orb');
    const reset = body(await POST(routes, '/dsh-soulmate/api/persona-evolve', { mode: 'reset_persona' }));
    assert.equal(reset.config.appearance.formPreset, 'astral-orb');
    assert.equal((await POST(routes, '/dsh-soulmate/api/persona-evolve', { mode: 'full_rebirth' })).status, 400);

    // config writes are whitelisted
    const cfgOut = await POST(routes, '/dsh-soulmate/api/config', { widget: { visible: false }, cloud: { consentGiven: true }, deviceId: 'hack' });
    assert.equal(cfgOut.status, 200);
    const cfg = body(cfgOut).config;
    assert.equal(cfg.widget.visible, false);
    assert.equal(cfg.cloud.consentGiven, false, 'consent can only be set through the sync/consent action');
    assert.notEqual(cfg.deviceId, 'hack');
    assert.equal((await POST(routes, '/dsh-soulmate/api/config', { cloud: { consentGiven: true } })).status, 400);

    // bookshelf
    const shelf = body(await GET(routes, '/dsh-soulmate/api/bookshelf'));
    assert.equal(shelf.ok, true);
    assert.equal(shelf.canReadInnerDiary, true);

    // cloud: no consent -> no network, loud reason
    const sync = body(await POST(routes, '/dsh-soulmate/api/sync', { action: 'sync' }));
    assert.equal(sync.ok, false);
    assert.match(sync.reason, /consent/i);
    assert.equal(body(await POST(routes, '/dsh-soulmate/api/sync', { action: 'wipe' })).ok, false);
    assert.equal(body(await POST(routes, '/dsh-soulmate/api/sync', { action: 'teleport' })).ok, false);
    const audit = body(await GET(routes, '/dsh-soulmate/api/audit'));
    assert.equal(audit.ok, true);

    // CSRF-style guards
    const cross = await POST(routes, '/dsh-soulmate/api/interact', { action: 'pat' }, { origin: 'https://evil.example', host: '127.0.0.1:3000', 'content-type': 'application/json' });
    assert.equal(cross.status, 403);
    const form = await POST(routes, '/dsh-soulmate/api/interact', { action: 'pat' }, { host: '127.0.0.1:3000', 'content-type': 'text/plain' });
    assert.equal(form.status, 415);
    const same = await POST(routes, '/dsh-soulmate/api/interact', { action: 'pat' }, { origin: 'http://127.0.0.1:3000', host: '127.0.0.1:3000', 'content-type': 'application/json' });
    assert.equal(same.status, 200);

    dispose();
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('home routes: prefix-style webServer.register hosts get one dispatcher per prefix and a real node response', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'soulmate-prefix-'));
  try {
    const { mockCtx, prefixes, dispose } = createMockCtx(dir, { webServerKind: 'register' });
    apply(mockCtx, {});
    await mockCtx.soulmate.ready;
    assert.deepEqual(prefixes.map((p) => p.path).sort(), ['/dsh-soulmate']);
    assert.ok(prefixes.every((p) => p.kind === 'prefix'));

    const sent = {};
    const res = {
      writeHead(status, headers) {
        sent.status = status;
        sent.headers = headers;
      },
      end(text) {
        sent.body = text;
      },
    };
    await prefixes[0].handler({ method: 'GET', url: '/dsh-soulmate/api/state', headers: {} }, res);
    assert.equal(sent.status, 200);
    assert.equal(JSON.parse(sent.body).ok, true);

    const missing = {};
    await prefixes[0].handler({ method: 'GET', url: '/dsh-soulmate/api/nope' }, { writeHead: (s) => (missing.status = s), end() {} });
    assert.equal(missing.status, 404);

    dispose();
    assert.equal(prefixes.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('home routes: companion art uploads to /api/sprite, is served back as bytes, and survives a delete', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'soulmate-sprite-'));
  try {
    const { mockCtx, routes, dispose } = createMockCtx(dir);
    apply(mockCtx, {});
    await mockCtx.soulmate.ready;

    // Fresh home gets the bundled Q版 idle PNG as default — never a blank corner.
    const before = await GET(routes, '/dsh-soulmate/api/sprite');
    assert.equal(before.status, 200);
    assert.equal(before.headers['content-type'], 'image/png');
    assert.ok(Buffer.from(before.body).length > 0);

    // A 1x1 transparent PNG, the smallest thing a browser will actually decode.
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const up = body(await POST(routes, '/dsh-soulmate/api/sprite', { dataUrl: 'data:image/png;base64,' + png }));
    assert.equal(up.ok, true);
    assert.match(up.url, /^\/dsh-soulmate\/api\/sprite\?v=\d+$/);
    assert.equal(up.file, '小鲸.png');

    // Served back with a sniffed image/* content type.
    const served = await GET(routes, up.url.split('?')[0]);
    assert.equal(served.status, 200);
    assert.equal(served.headers['content-type'], 'image/png');
    assert.ok(Buffer.isBuffer(served.body) || served.body instanceof Uint8Array);
    assert.equal(Buffer.from(served.body).length, Buffer.from(png, 'base64').length);

    // config.appearance.customSpriteUrl now points at the route, so the widget picks it up.
    const state = body(await GET(routes, '/dsh-soulmate/api/state'));
    assert.match(state.config.appearance.customSpriteUrl, /^\/dsh-soulmate\/api\/sprite/);

    // DELETE restores the bundled Q版 default sticker instead of leaving a hole.
    const gone = body(await routes.get('DELETE /dsh-soulmate/api/sprite')({ method: 'DELETE', url: '/dsh-soulmate/api/sprite' }));
    assert.equal(gone.ok, true);
    assert.equal(gone.restored, 'Q版默认形象');
    const after = body(await GET(routes, '/dsh-soulmate/api/state'));
    assert.match(after.config.appearance.customSpriteUrl, /^\/dsh-soulmate\/api\/sprite/);
    const restored = await GET(routes, '/dsh-soulmate/api/sprite');
    assert.equal(restored.status, 200);
    assert.equal(restored.headers['content-type'], 'image/png');
    assert.ok(Buffer.from(restored.body).length > Buffer.from(png, 'base64').length);

    // Bad payloads fail loudly instead of writing garbage.
    const bad = await POST(routes, '/dsh-soulmate/api/sprite', { dataUrl: 'data:text/html;base64,PHNjcmlwdD4=' });
    assert.equal(bad.status, 400);

    dispose();
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('home routes: male default sprite is the bundled Q版 PNG and DELETE restores it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'soulmate-sprite-male-'));
  try {
    const { mockCtx, routes, dispose } = createMockCtx(dir);
    apply(mockCtx, {});
    await mockCtx.soulmate.ready;

    const served = await GET(routes, '/dsh-soulmate/api/sprite-male');
    assert.equal(served.status, 200);
    assert.equal(served.headers['content-type'], 'image/png');
    assert.ok(Buffer.from(served.body).length > 10_000);

    const gone = body(await routes.get('DELETE /dsh-soulmate/api/sprite-male')({ method: 'DELETE', url: '/dsh-soulmate/api/sprite-male' }));
    assert.equal(gone.ok, true);
    assert.equal(gone.restored, 'Q版默认形象');
    assert.match(gone.url, /^\/dsh-soulmate\/api\/sprite-male\?v=\d+$/);

    const again = await GET(routes, '/dsh-soulmate/api/sprite-male');
    assert.equal(again.status, 200);
    assert.equal(again.headers['content-type'], 'image/png');

    dispose();
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('plugin config is validated loudly and extensions can register / unregister', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'soulmate-cfg-'));
  try {
    const bad = createMockCtx(dir);
    assert.throws(() => apply(bad.mockCtx, { autoSync: 'yes' }), /autoSync/);
    assert.throws(() => apply(bad.mockCtx, { syncIntervalSec: 5 }), /syncIntervalSec/);
    assert.throws(() => apply(bad.mockCtx, { homeDir: 42 }), /homeDir/);

    const custom = await mkdtemp(join(tmpdir(), 'soulmate-custom-'));
    const { mockCtx, dispose } = createMockCtx(dir);
    apply(mockCtx, { homeDir: custom, autoSync: false });
    assert.equal(mockCtx.soulmate.home.rootDir, custom);
    await mockCtx.soulmate.ready;

    const off = mockCtx.soulmate.registerExtension({ id: 'bili', name: 'B 站冲浪', description: '二期' });
    const { routes } = createMockCtx(dir);
    assert.equal(typeof off, 'function');
    assert.throws(() => mockCtx.soulmate.registerExtension({}), /registerExtension/);
    off();
    dispose();
    await rm(custom, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('cloud wiring: consent -> sync against the mock AIGC server mounts remote capability tools and lights the remote nebula; dispose unmounts', async () => {
  const server = await startMockAigcServer(0);
  const dir = await mkdtemp(join(tmpdir(), 'soulmate-cloud-'));
  try {
    const { mockCtx, registeredTools, routes, dispose } = createMockCtx(dir);
    apply(mockCtx, { autoSync: false });
    await mockCtx.soulmate.ready;

    await mockCtx.soulmate.retainFact({ topic: '默契', content: '先给补丁再吐槽', importance: 4 });
    const secret = await mockCtx.soulmate.retainFact({ topic: '隐私', content: '只在本机', visibility: 'private' });

    // not authorised yet -> refuses
    assert.equal(body(await POST(routes, '/dsh-soulmate/api/sync', { action: 'sync' })).ok, false);

    const consent = body(await POST(routes, '/dsh-soulmate/api/sync', { action: 'consent', consent: true, serverUrl: server.baseUrl }));
    assert.equal(consent.config.cloud.consentGiven, true);
    assert.equal(consent.config.cloud.serverUrl, server.baseUrl);
    const noKey = body(await POST(routes, '/dsh-soulmate/api/sync', { action: 'sync' }));
    assert.equal(noKey.ok, false);
    assert.match(noKey.reason, /API key/i);

    const keyRes = body(await POST(routes, '/dsh-soulmate/api/sync', { action: 'set_key', apiKey: 'ak_integration_user_1234' }));
    assert.equal(keyRes.ok, true);
    assert.ok(!JSON.stringify(body(await GET(routes, '/dsh-soulmate/api/state'))).includes('ak_integration_user_1234'), 'raw key never leaves credentials.json');

    const synced = body(await POST(routes, '/dsh-soulmate/api/sync', { action: 'sync' }));
    assert.equal(synced.ok, true);
    assert.ok(synced.uploaded.facts >= 1);

    // remote capability tools are mounted lazily after the first good sync
    for (let i = 0; i < 50 && !registeredTools.has('soulmate_cloud_draw_selfie'); i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(registeredTools.has('soulmate_cloud_draw_selfie'));
    const drawn = await registeredTools.get('soulmate_cloud_draw_selfie').execute({ scene: '在 C:\\Users\\alice\\Desktop 看海' });
    assert.equal(drawn.ok, true);
    const state = body(await GET(routes, '/dsh-soulmate/api/state'));
    assert.equal(state.mementos.length, 1);

    const graph = body(await GET(routes, '/dsh-soulmate/api/neural-graph'));
    assert.ok(graph.nodes.some((n) => n.zone === 'remote_nebula' && n.kind === 'remote_cloud'));
    assert.ok(graph.nodes.some((n) => n.kind === 'remote_capability'));
    assert.ok(graph.synapses.some((s) => s.kind === 'warp_sync_beam'));
    assert.ok(!graph.nodes.some((n) => n.id === `remote:${secret.fact.id}`), 'private memory never gets a cloud twin');
    assert.ok(graph.events.some((e) => e.type === 'sync' && e.ok === true));

    // withdrawing consent keeps working offline
    const off = body(await POST(routes, '/dsh-soulmate/api/sync', { action: 'consent', consent: false }));
    assert.equal(off.config.cloud.consentGiven, false);

    dispose();
    assert.equal(registeredTools.size, 0, 'dynamic cloud tools unmounted with the plugin');
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('room3d-page: self-contained HTML with valid inline script, XSS-safe payload and both 3D modes', () => {
  const html = renderSoulmateHomeHtml({ summary: { note: '</script><img src=x onerror=alert(1)>' } });
  assert.ok(html.startsWith('<!DOCTYPE html>'));
  assert.ok(!html.includes('</script><img'), 'payload cannot break out of the JSON script tag');
  assert.ok(!/<script[^>]+src=/.test(html), 'no external script');
  assert.ok(!/https?:\/\/(cdn|unpkg|cdnjs)/.test(html), 'no CDN');
  for (const needle of ['btnNeb', 'btnRoom', 'Reinforce', 'Toggle Private', 'Forget', '记忆书架', '纪念照片墙', '餐桌投喂', '衣帽间', '云端传送门', 'whale-girl', 'cyber-muse', 'neko-hacker', 'astral-orb', 'ironBowl', 'holoHeadset', 'quantumHalo', 'warp_sync_beam', 'topic_cluster', 'wiki_link', 'startOnboarding', '已自动保存 ✓']) {
    assert.ok(html.includes(needle), `page contains ${needle}`);
  }
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.equal(scripts.length, 1);
  assert.doesNotThrow(() => new vm.Script(scripts[0], { filename: 'soulmate-home-inline.js' }), 'inline client script parses');
  assert.equal(renderSoulmateHomeHtml().includes('soulmate-initial'), true);
});

test('client.js: browser half registers the chat-card definition + slot and renders soulmate tool results', async () => {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
  let loaded;
  const sandbox = {
    window: { __ModuleLoader__: { load: (def) => (loaded = def) } },
    console,
  };
  vm.runInNewContext(source, sandbox, { filename: 'client.js' });
  assert.equal(loaded.id, pkg.name);

  const React = { createElement: (type, props, ...kids) => ({ type, props, kids }) };
  const mod = loaded.factory((id) => {
    assert.equal(id, 'react');
    return React;
  });
  assert.deepEqual([...mod.inject], []);

  const defs = [];
  const slotCalls = [];
  mod.apply({
    get: (name) => ({
      conversationEvents: { register: (d) => defs.push(d) },
      slots: {
        inject: (name2, fn) => slotCalls.push([name2, fn]),
        register: (opts, comp) => ({ opts, comp }),
      },
    }[name]),
    effect: (fn) => {
      const dispose = fn();
      return typeof dispose === 'function' ? dispose : undefined;
    },
  });
  assert.equal(defs.length, 1);
  assert.equal(slotCalls[0][0], 'conversation.chat.node');
  assert.equal(slotCalls[0][1]().opts.key, 'dsh-plugins-soulmate');

  const def = defs[0];
  const meta = { kind: 'dsh-plugins-soulmate', tool: 'soulmate_status_interact', ok: true, title: '🍚 投喂', lines: ['心情 happy'], state: { affinity: 30 }, bondStage: { level: 1 } };
  const event = { type: 'tool/result', seq: 7, data: { meta, message: { source: { callId: 'c1' } } } };
  assert.deepEqual({ ...def.match(event) }, { id: 'c1', role: 'start' });
  assert.equal(def.match({ ...event, type: 'tool/call' }), null);
  assert.equal(def.match({ ...event, data: { ...event.data, meta: { kind: 'other' } } }), null);
  const state = def.start({}, { event });
  assert.equal(state.title, '🍚 投喂');
  const node = def.buildViewNode({ key: 'k', id: 'c1', state, start: { event, location: { kind: 'x' } }, matches: [] });
  assert.equal(node.kind, 'dsh-plugins-soulmate');
  assert.equal(node.anchorSeq, 7);
  assert.equal(def.buildViewNode({ state: undefined }), null);

  const Card = slotCalls[0][1]().comp;
  const rendered = Card({ node }).type(Card({ node }).props);
  assert.equal(rendered.type, 'div');
  assert.match(rendered.props.className, /sm-chat/);
});

test('client.js: a host missing conversationEvents / slots never blocks the boot (regression: "pending: waiting for service: conversationEvents")', async () => {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
  let loaded;
  vm.runInNewContext(source, { window: { __ModuleLoader__: { load: (def) => (loaded = def) } }, console }, { filename: 'client.js' });

  const React = { createElement: (type, props, ...kids) => ({ type, props, kids }) };
  const mod = loaded.factory(() => React);

  // Declaring these in `inject` is what left the fiber pending forever and failed the whole
  // web boot; they must stay out of it and be probed instead.
  assert.deepEqual([...mod.inject], [], 'no hard service dependency may be declared');

  // A host with neither service (and no document) must still apply cleanly.
  assert.doesNotThrow(() => mod.apply({ get: () => undefined, effect: () => {} }));
  assert.doesNotThrow(() => mod.apply({ get: () => undefined }));

  // A host with only one of the two must wire just that surface.
  const defs = [];
  assert.doesNotThrow(() => mod.apply({
    get: (name) => (name === 'conversationEvents' ? { register: (d) => defs.push(d) } : undefined),
    effect: (fn) => fn(),
  }));
  assert.equal(defs.length, 1, 'chat card registers on the surface that exists');
});

test('client.js: adds the sidebar panellist row + persona workshop page (waits for slots via inject)', async () => {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
  let loaded;
  vm.runInNewContext(source, { window: { __ModuleLoader__: { load: (def) => (loaded = def) } }, console }, { filename: 'client.js' });

  // The panel page is only ever rendered by the host, so the hooks never run here.
  const React = {
    createElement: (type, props, ...kids) => ({ type, props, kids }),
    useState: () => [null, () => {}],
    useRef: () => ({ current: null }),
    useCallback: (fn) => fn,
    useEffect: () => {},
  };
  const mod = loaded.factory(() => React);

  const registered = [];
  const slots = {
    inject: (name2, fn) => {
      registered.push({ slot: name2, entry: fn() });
      return () => {};
    },
    register: (opts, comp) => ({ opts, comp }),
  };
  // Mirror desktop: slots arrives through ctx.inject(['slots'], …), not a one-shot get.
  mod.apply({
    inject: (deps, callback) => {
      if (!Array.isArray(deps) || !deps.includes('slots')) return () => {};
      return callback({ slots, get: (n) => (n === 'slots' ? slots : undefined) }) || (() => {});
    },
    get: () => undefined,
    effect: (fn) => fn(),
  });

  const row = registered.find((r) => r.slot === 'sidebar.panellist');
  assert.ok(row, 'sidebar.panellist is registered');
  assert.equal(row.entry.opts.id, 'soulmate');
  assert.equal(row.entry.opts.order, 5);
  assert.equal(typeof row.entry.opts.label, 'function', 'label is a thunk so rename can remount');
  assert.equal(row.entry.opts.label(), 'soulmate', 'empty displayName falls back to soulmate');
  assert.equal(typeof row.entry.comp, 'function', 'panel row carries a glyph component');

  const page = registered.find((r) => r.slot === 'main');
  assert.equal(page.entry.opts.key, 'soulmate', 'the main slot keys the page by the same panel id');
  assert.equal(typeof page.entry.comp, 'function', 'the panel body is a component');
});

test('client.js: the floating widget is avatar-only and the page is a tabbed settings view', async () => {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');

  // Widget contract: no meters, no bubble, no action grid. The corner shows the
  // companion and nothing else, so every readout moved to the settings page.
  assert.ok(source.includes('sm-card sm-card-avatar'), 'avatar-only card class is present');
  assert.ok(source.includes('sm-widget sm-widget-avatar'), 'avatar-only widget class is present');
  assert.ok(!source.includes("text: '🍚 投喂'"), 'the feed button is gone from the widget');
  assert.ok(!source.includes("text: '🧠 神经元'"), 'the neuron button is gone from the widget');
  assert.ok(!source.includes("className: 'sm-btns'"), 'the widget action grid is gone');
  assert.ok(!/const bubble = el\('div'/.test(source), 'the mood bubble is gone');

  // Settings page: title says 设置 and the tabs include the requested sections.
  assert.match(source, /'\s*的设置'\)/, 'title reads「XX 的设置」');
  for (const label of ['状态总览', '性格观察与设置', '记忆神经网络', '称呼与形象', '日记']) {
    assert.ok(source.includes(label), `tab「${label}」is present`);
  }
  // No placeholder tab may ship: an empty「待定」panel is a promise the user cannot use.
  assert.ok(!source.includes('待定'), 'the placeholder tab is gone');
  assert.ok(!source.includes('DISPLAY ONLY'), 'the budget is measured, not a display-only figure');
  // Neuron tab: a scattered memory galaxy, NOT a whale silhouette. The whale layout was
  // removed on request — it forced every memory onto a drawn animal, so a handful of
  // memories produced a fully-formed whale and a busy graph collapsed into one clump.
  // The assertions now lock in what replaced it: an even topic shell, fact clouds around
  // their own topic, and no silhouette/filler geometry left behind.
  assert.ok(source.includes('function drawNeurons'), 'drawNeurons exists');
  assert.ok(source.includes('layoutMemoryGalaxy'), 'the scattered galaxy layout is present');
  assert.ok(source.includes('topicShell'), 'topics are spread on a shell');
  assert.ok(source.includes('cloudShell'), 'facts orbit their own topic');
  for (const banned of ['function drawGrain', 'function drawWhaleBody', 'BODY_PTS', 'WHALE_OUTLINE', 'layout.guideDots']) {
    assert.ok(!source.includes(banned), `${banned} must be gone: it drew a shape the memories did not support`);
  }
  assert.ok(source.includes('neuronSky'), 'starfield cache is present');
  // Camera affordances. These were documented in comments long before they existed —
  // the header claimed "double-click to come home" with no dblclick listener anywhere, so
  // pinning the behaviour down here keeps the comment and the code from drifting apart.
  assert.ok(source.includes("addEventListener('dblclick'"), 'double-click is actually bound');
  assert.ok(source.includes('function flyTo'), 'double-click flies to a star');
  assert.ok(source.includes('function stepFly'), 'the flight is animated, not a jump cut');
  assert.ok(source.includes('function pickNode'), 'picking is shared by hover/click/double-click');
  assert.ok(/MAX_ZOOM\s*=\s*([1-9]\d|1[0-9])/.test(source), 'zoom ceiling is deep enough to inspect a star');
  assert.ok(source.includes('exp(-dt'), 'flight smoothing is time-based so throttled frames still converge');
  // The three memory layers must be distinguishable by size *before* importance is
  // considered. Sizing on importance alone was silently flattening the hierarchy: a topic
  // and a retained fact both reach importance 5, so a layer-2 speck could draw exactly as
  // large as a layer-1 theme star. Each layer now owns a size band.
  assert.ok(source.includes('LAYER_BAND'), 'each memory layer has its own size band');
  for (const band of ['wiki_star', 'episode_crystal', 'fact_neuron', 'private_shielded']) {
    assert.ok(source.includes(band), `size band covers ${band}`);
  }
  for (const banned of ['rainbow', '#00f2fe', '#b721ff', '#ff2a85']) {
    assert.ok(!source.includes(banned), `neuron field must not use ${banned}`);
  }

  // Regression: hooks after the empty-draft early return blank the settings page.
  const panel = source.slice(source.indexOf('function SoulmatePanelPage'), source.indexOf('// Floating widget'));
  const early = panel.indexOf('if (!draft) {');
  assert.ok(early > 0, 'early draft guard exists');
  const after = panel.slice(early);
  assert.ok(!/React\.use(State|Ref|Effect|Callback)\(/.test(after), 'no hooks after the early return');
  // Regression: gateBudget must be declared before gateCard uses it (TDZ blanked the page).
  assert.ok(
    panel.indexOf('const gateBudget') < panel.indexOf('const gateCard'),
    'gateBudget is declared before the gate card'
  );
});
test('plugin-integration v3: presence digest rides the drift anchor and the trust tools close the loop', async () => {
  const { readFile } = await import('node:fs/promises');
  const dir = await mkdtemp(join(tmpdir(), 'soulmate-v3-'));
  try {
    const { mockCtx, registeredTools, promptContexts, dispose } = createMockCtx(dir);
    apply(mockCtx, {});
    await mockCtx.soulmate.ready;
    const settle = () => new Promise((r) => setTimeout(r, 90));
    const retain = registeredTools.get('soulmate_memory_retain');

    // An empty memory keeps the anchor persona-only…
    // Fresh install gender=null → 中性标题「我此刻记得」（非「她/他」）。
    assert.ok(!/我此刻记得|她此刻记得|他此刻记得/.test(promptContexts[0].text()));

    assert.equal((await retain.execute({ kind: 'fact', topic: '冰美式', content: '夏天只喝冰美式', category: 'preference' })).ok, true);
    await settle();
    assert.match(promptContexts[0].text(), /我此刻记得/);
    assert.match(promptContexts[0].text(), /偏好：.*冰美式/);

    // …an overdue promise nags until its status moves…
    const promised = await retain.execute({ kind: 'fact', topic: 'promise', content: '周五陪你看电影', category: 'promise', dueAt: '2026-01-01T00:00:00Z' });
    assert.equal(promised.ok, true);
    await settle();
    assert.match(promptContexts[0].text(), /逾期/);
    const kept = await registeredTools.get('soulmate_memory_promise').execute({ id: promised.fact.id, action: 'keep', note: '爆米花我买' });
    assert.equal(kept.status, 'kept');
    await settle();
    assert.ok(!/逾期/.test(promptContexts[0].text()), 'a kept promise stops nagging');

    // …and a parked conflict asks instead of guessing.
    await retain.execute({ kind: 'fact', topic: '咖啡', content: '搭档不喝咖啡' });
    const neu = await retain.execute({ kind: 'fact', topic: '咖啡', content: '搭档喝咖啡' });
    await settle();
    assert.match(promptContexts[0].text(), /冲突/);
    const rows = (await readFile(join(dir, 'soulmate', 'memory', 'facts', 'facts.jsonl'), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const older = rows.find((r) => r.conflictWith === neu.fact.id);
    assert.ok(older, 'the older side carries the back pointer');
    const resolved = await registeredTools.get('soulmate_memory_resolve_conflict').execute({ keepId: neu.fact.id, dropId: older.id, reason: '他亲口说的' });
    assert.equal(resolved.ok, true);
    await settle();
    assert.ok(!/\[conflict\]/.test(promptContexts[0].text()), 'a resolved pair leaves the anchor');
    dispose();
  } finally {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        break;
      } catch (err) {
        if (err?.code !== 'ENOTEMPTY' || attempt === 3) throw err;
        await new Promise((r) => setTimeout(r, 60));
      }
    }
  }
});

test('plugin-integration v3: the promise patrol speaks once per local day for overdue promises', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'soulmate-patrol-'));
  try {
    const { mockCtx, registeredTools, dispose } = createMockCtx(dir);
    apply(mockCtx, {});
    await mockCtx.soulmate.ready;
    const { saveConfigAuto } = await import('../packages/soulmate-core/state.mjs');
    await saveConfigAuto(mockCtx.soulmate.home, { extensions: { biliAutoSurfEnabled: false }, proactive: { intentEnabled: false } });
    const retain = registeredTools.get('soulmate_memory_retain');
    const at = Date.parse('2026-11-10T11:00:00Z'); // 19:00 at UTC+8
    await retain.execute({ kind: 'fact', topic: 'promise', content: '上周答应一起复盘网关', category: 'promise', dueAt: '2026-11-04T00:00:00Z' });
    const tick = await mockCtx.soulmate.runProactiveTick(at);
    assert.equal(tick.patrol.ran, true);
    assert.equal(tick.patrol.speak, true);
    assert.equal(tick.patrol.ask, true, 'six days overdue is an ask, not a nudge');
    assert.ok(mockCtx.soulmate.events(0).some((e) => e.type === 'promise-patrol'));
    const again = await mockCtx.soulmate.runProactiveTick(at + 60_000);
    assert.equal(again.patrol.ran, false, 'the patrol is idempotent per local day');
    dispose();
  } finally {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        break;
      } catch (err) {
        if (err?.code !== 'ENOTEMPTY' || attempt === 3) throw err;
        await new Promise((r) => setTimeout(r, 60));
      }
    }
  }
});

test('plugin-integration v3: engine snapshot carries the trust layer and the rebuilt client ships the trust card', async () => {
  const { readFile } = await import('node:fs/promises');
  const dir = await mkdtemp(join(tmpdir(), 'soulmate-trustui-'));
  try {
    const { mockCtx, registeredTools, dispose } = createMockCtx(dir);
    apply(mockCtx, {});
    await mockCtx.soulmate.ready;
    const retain = registeredTools.get('soulmate_memory_retain');
    await retain.execute({ kind: 'fact', topic: '咖啡', content: '搭档不喝咖啡' });
    await retain.execute({ kind: 'fact', topic: '咖啡', content: '搭档喝咖啡' });
    await retain.execute({ kind: 'fact', topic: 'promise', content: '周日复盘', category: 'promise', dueAt: '2026-01-01T00:00:00Z' });
    const snapshot = await (await import('../packages/soulmate-core/layers/index.mjs')).getEngineSnapshot(mockCtx.soulmate.home, Date.now());
    assert.equal(snapshot.trust.conflicts.length, 1);
    assert.equal(snapshot.trust.promises.length, 1);
    assert.equal(snapshot.trust.promises[0].overdueDays > 0, true);
    assert.match(snapshot.presence.text, /冲突/);
    assert.equal(snapshot.status.memory.conflictsOpen, 2);
    assert.equal(snapshot.status.memory.activeFacts, 3);
    assert.equal(snapshot.status.memory.historicalFacts, 3);
    dispose();
  } finally {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        break;
      } catch (err) {
        if (err?.code !== 'ENOTEMPTY' || attempt === 3) throw err;
        await new Promise((r) => setTimeout(r, 60));
      }
    }
  }
  const client = await readFile(new URL('../client.js', import.meta.url), 'utf8');
  assert.match(client, /约定与近况/, 'the rebuilt client.js ships the trust card');
  assert.match(client, /她记得的事/, 'the presence preview ships too');
});
