// Memory / trust-layer routes: engine strip, presence, conflicts, promises, gate,
// neural graph, bookshelf, recall preview, privacy audit, memory-node actions.

import { companionPronoun } from '../persona.mjs';
import { listTrustItems, reinforceMemoryNode, toggleMemoryPrivacy } from '../memory-engine.mjs';
import { getEngineSnapshot, runSubmissionGate } from '../layers/index.mjs';
import { readPrivacyAudit } from '../privacy-firewall.mjs';
import { jsonOut, statusOf } from '../http-plumbing.mjs';

export function memoryRoutes({ home, service, memory, getSummary, promptText, events, eventSeq, pushEvent }) {
  const { recall, presenceDigest, promiseAction, resolveConflict, forget, getNeuralGraph } = service;
  // idsOfRecall is a memory-runtime helper, not part of the public ctx.soulmate surface.
  const { idsOfRecall } = memory;

  const lockInnerDiaries = (graph, summary) => {
    if (summary.bondStage.canReadInnerDiary) return graph;
    const pp = companionPronoun(summary.config?.persona?.gender).third;
    const lock = `🔒 亲密度达到 Lv.3「默契副驾」后才能偷看${pp}的私密小本本`;
    return {
      ...graph,
      nodes: graph.nodes.map((n) =>
        n.kind === 'episode_crystal' && /-inner$/.test(n.id) ? { ...n, content: lock, summary: lock, locked: true } : n,
      ),
    };
  };

  return [
    {
      method: 'GET',
      paths: ['/dsh-soulmate/api/engine'],
      handler: async () => jsonOut(200, await getEngineSnapshot(home, Date.now(), { promptText: promptText() })),
    },
    // v3 trust layer surfaces (§4.4 / §11)
    {
      method: 'GET',
      paths: ['/dsh-soulmate/api/presence'],
      handler: async () => jsonOut(200, await presenceDigest({ nowMs: Date.now() })),
    },
    {
      method: 'GET',
      paths: ['/dsh-soulmate/api/conflicts'],
      handler: async () => jsonOut(200, await listTrustItems(home)),
    },
    {
      method: 'POST',
      paths: ['/dsh-soulmate/api/conflicts'],
      handler: async ({ body }) => {
        const res = await resolveConflict(body ?? {});
        return jsonOut(statusOf(res), res);
      },
    },
    {
      method: 'GET',
      paths: ['/dsh-soulmate/api/promises'],
      handler: async () => jsonOut(200, await listTrustItems(home)),
    },
    {
      method: 'POST',
      paths: ['/dsh-soulmate/api/promises'],
      handler: async ({ body }) => {
        const res = await promiseAction(body ?? {});
        return jsonOut(statusOf(res), res);
      },
    },
    {
      // Submission gate: the only engine path from candidates → traits.yaml.
      method: 'GET',
      paths: ['/dsh-soulmate/api/gate'],
      handler: async ({ query }) => {
        const dryRun = query.get('dry') === '1';
        const nowMs = Number(query.get('now')) || undefined;
        return jsonOut(200, await runSubmissionGate(home, { dryRun, nowMs }));
      },
    },
    {
      method: 'GET',
      paths: ['/dsh-soulmate/api/neural-graph'],
      handler: async ({ query }) => {
        const [graph, summary] = await Promise.all([getNeuralGraph(), getSummary()]);
        const since = Number(query.get('since')) || 0;
        return jsonOut(200, { ...lockInnerDiaries(graph, summary), events: events.filter((e) => e.seq > since), eventSeq: eventSeq() });
      },
    },
    {
      method: 'GET',
      paths: ['/dsh-soulmate/api/bookshelf'],
      handler: async () => {
        const [graph, summary] = await Promise.all([getNeuralGraph({ cloudSynced: false }), getSummary()]);
        const locked = lockInnerDiaries(graph, summary);
        const wikiNodes = locked.nodes.filter((n) => n.kind === 'wiki_star');
        const episodes = locked.nodes.filter((n) => n.kind === 'episode_crystal');
        return jsonOut(200, {
          ok: true,
          notebooks: summary.notebooks,
          canReadInnerDiary: summary.bondStage.canReadInnerDiary,
          wiki: wikiNodes.map((n) => ({ id: n.id, slug: n.id.slice(5), title: n.label, summary: n.summary, content: n.content, updatedAt: n.updatedAt })),
          toYou: episodes.filter((n) => /-to-you$/.test(n.id)).map((n) => ({ id: n.id, label: n.label, content: n.content, updatedAt: n.updatedAt, private: n.shielded })),
          inner: episodes.filter((n) => /-inner$/.test(n.id)).map((n) => ({ id: n.id, label: n.label, content: n.content, updatedAt: n.updatedAt, private: n.shielded, locked: n.locked === true })),
        });
      },
    },
    {
      method: 'GET',
      paths: ['/dsh-soulmate/api/recall'],
      handler: async ({ query }) => {
        const q = (query.get('q') ?? '').trim();
        if (!q) return jsonOut(400, { ok: false, error: 'q is required' });
        // pulse:false -> the page animates its own shockwave; other tabs are not disturbed.
        // v3 (§3.4): the preview route can no longer elevate itself into reinforcing.
        const res = await recall(q, { limit: 6, reinforce: false, pulse: false });
        return jsonOut(statusOf(res), res.ok ? { ...res, ids: idsOfRecall(res) } : res);
      },
    },
    {
      method: 'GET',
      paths: ['/dsh-soulmate/api/audit'],
      handler: async () => jsonOut(200, { ok: true, records: await readPrivacyAudit(home, 50) }),
    },
    {
      method: 'POST',
      paths: ['/dsh-soulmate/api/memory-node'],
      handler: async ({ body }) => {
        const id = typeof body.id === 'string' ? body.id.trim() : '';
        if (!id) return jsonOut(400, { ok: false, error: 'id is required' });
        const localId = id.replace(/^remote:/, '');
        let res;
        switch (body.action) {
          case 'reinforce':
            res = await reinforceMemoryNode(home, localId);
            if (res.ok) pushEvent('reinforce', { ids: [id] });
            break;
          case 'toggle_private':
            res = await toggleMemoryPrivacy(home, localId);
            if (res.ok) pushEvent('shield', { ids: [localId] });
            break;
          case 'forget':
            res = await forget(id);
            break;
          default:
            res = { ok: false, error: `unknown action "${body.action}" (reinforce | toggle_private | forget)` };
        }
        return jsonOut(statusOf(res), { ...res, eventSeq: eventSeq() });
      },
    },
  ];
}
