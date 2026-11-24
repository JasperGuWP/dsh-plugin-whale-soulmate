// Throwaway star-sea smoke harness: serves the REAL neuron-bundle.js with a mock
// neural-graph + growth + events feed, so pulses / births / info card / growth strip
// can be verified in the browser without a DSH host.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = 4399;

const now = Date.now();
const iso = (msAgo) => new Date(now - msAgo).toISOString();
const nodes = [];
const synapses = [];
// gold topic suns
for (const [i, slug] of ['饮品偏好', '代码风格', '装机翻车'].entries()) {
  nodes.push({ id: 'wiki:' + slug, label: slug, kind: 'wiki_star', importance: 5, energy: 0.9, recallCount: 3, createdAt: iso(86400000 * (20 - i * 5)), updatedAt: iso(86400000), summary: '关于' + slug + '的长期记忆' });
}
// fact dust
for (let i = 0; i < 60; i += 1) {
  const parent = nodes[i % 3].id;
  nodes.push({ id: 'fact:' + i, label: '事实' + (i % 12), kind: 'fact_neuron', importance: 1 + (i % 5), energy: 0.3 + (i % 7) / 10, recallCount: i % 4, createdAt: iso(86400000 * (i % 25)), updatedAt: iso(3600000 * i), summary: '第' + i + '条零散记忆的摘要' });
  // every 7th fact is unlinked (drift constellation); every 11th links to the dream
  if (i % 7 === 3) continue;
  if (i % 11 === 5) { synapses.push({ id: 'sd' + i, source: 'fact:' + i, target: 'wiki:dream-2026-11-23', kind: 'topic_cluster', strength: 0.4, pulseColor: '#4facfe' }); continue; }
  synapses.push({ id: 's' + i, source: 'fact:' + i, target: parent, kind: 'topic_cluster', strength: 0.3 + (i % 6) / 10, pulseColor: '#4facfe' });
}
// episodes + session stars + shielded
for (let i = 0; i < 8; i += 1) nodes.push({ id: 'episode:e' + i, label: '日记' + i, kind: 'episode_crystal', importance: 2, energy: 0.6, createdAt: iso(86400000 * i), updatedAt: iso(86400000 * i), summary: '那天的事' });
for (let i = 0; i < 4; i += 1) nodes.push({ id: 'session:s' + i, label: '大海 · ' + (i + 1), kind: 'session_star', importance: 3, energy: 0.7, createdAt: iso(86400000 * i * 2), updatedAt: iso(3600000), summary: '窗里的话题' });
for (let i = 0; i < 5; i += 1) nodes.push({ id: 'priv:' + i, label: '私密' + i, kind: 'private_shielded', importance: 2, energy: 0.5, shielded: true });
synapses.push({ id: 'sw1', source: 'wiki:饮品偏好', target: 'wiki:代码风格', kind: 'wiki_link', strength: 0.9, pulseColor: '#00f2fe' });
// dream page (outer band, ice tint)
nodes.push({ id: 'wiki:dream-2026-11-23', label: 'soulmate的梦 · 2026-11-23', kind: 'wiki_star', importance: 5, energy: 0.9, createdAt: iso(86400000), updatedAt: iso(86400000), summary: '梦到了饮品和代码' });
// remote cloud + warp beams (the long crossing lines that used to clutter the sky)
for (let i = 0; i < 10; i += 1) {
  nodes.push({ id: 'cloud:' + i, label: '云端' + i, kind: 'remote_cloud', importance: 2, energy: 0.5, createdAt: iso(86400000 * (10 + i)), updatedAt: iso(86400000 * i), summary: '云端副本' });
  synapses.push({ id: 'warp' + i, source: 'cloud:' + i, target: 'wiki:' + ['饮品偏好', '代码风格', '装机翻车'][i % 3], kind: 'warp_sync_beam', strength: 0.5, pulseColor: '#b721ff' });
}

let seq = 0;
let firedBurst = false;
const events = [];

const growthWeeks = [
  { week: '2026-W45', at: iso(86400000 * 14), traits: { clinginess: 50, sassiness: 60, curiosity: 55, brevity: 50, tsundere: 40 }, nodes: 40, wikiStars: 2, facts: 30 },
  { week: '2026-W46', at: iso(86400000 * 7), traits: { clinginess: 54, sassiness: 60, curiosity: 58, brevity: 50, tsundere: 40 }, nodes: 62, wikiStars: 3, facts: 48 },
  { week: '2026-W47', at: iso(86400000), traits: { clinginess: 54, sassiness: 63, curiosity: 58, brevity: 50, tsundere: 36 }, nodes: 78, wikiStars: 3, facts: 60 },
];

const HTML = `<!doctype html><html><head><meta charset="utf-8"><title>neuron smoke</title>
<style>html,body{margin:0;height:100%;background:#05070f;overflow:hidden}canvas{display:block;width:100vw;height:100vh;cursor:grab}
#hud{position:fixed;left:14px;top:12px;color:rgba(196,210,240,.75);font:12px ui-monospace,Menlo,monospace}</style></head><body>
<canvas id="sky" width="1280" height="720"></canvas><div id="hud">neuron smoke</div>
<script src="/neuron.js"></script><script>
(function () {
  var canvas = document.getElementById('sky')
  var graph = null
  var since = 0
  var seeded = false
  function poll() {
    fetch('/dsh-soulmate/api/neural-graph?since=' + since).then(function (r) { return r.json() }).then(function (g) {
      graph = g
      if (seeded && Array.isArray(g.events) && g.events.length) window.__neuronFx.noteEvents(canvas, g.events, Date.now())
      if (g.eventSeq) since = g.eventSeq
      seeded = true
      document.getElementById('hud').textContent = 'neuron smoke · ' + g.nodes.length + ' 星' + (window.__neuronFx.progressActive(canvas) ? ' · 整理中…' : '')
      window.__smokeReady = true
    })
  }
  poll(); setInterval(poll, 3000)
  function frame(t) { if (graph) window.__neuronFx.drawNeurons(canvas, graph, t); requestAnimationFrame(frame) }
  requestAnimationFrame(frame)
})()
</script></body></html>`;

const server = createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const send = (code, type, body) => { res.writeHead(code, { 'content-type': type }); res.end(body); };
  try {
    if (u.pathname === '/' || u.pathname === '/index.html') return send(200, 'text/html; charset=utf-8', HTML);
    if (u.pathname === '/neuron.js') return send(200, 'text/javascript; charset=utf-8', await readFile(join(ROOT, 'runtime', 'neuron-window', 'neuron-bundle.js'), 'utf8'));
    if (u.pathname === '/dsh-soulmate/api/neural-graph') {
      // One-time burst after first poll: a new dream star + progress + intent events.
      if (!firedBurst && seq > 0) {
        firedBurst = true;
        nodes.push({ id: 'wiki:dream-tonight', label: '今晚的梦', kind: 'wiki_star', importance: 5, energy: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), summary: '梦到了饮品和代码' });
        events.push({ seq: ++seq, type: 'memory-progress', stage: 'done', work: 'dream', slug: 'dream-tonight', ids: ['wiki:dream-tonight'] });
        events.push({ seq: ++seq, type: 'intent', action: 'silent' });
      } else if (seq === 0) {
        events.push({ seq: ++seq, type: 'memory-progress', stage: 'dream', work: 'dream', slug: 'dream-tonight' });
      }
      seq += 0;
      return send(200, 'application/json', JSON.stringify({ ok: true, nodes, synapses, events: events.splice(0), eventSeq: seq }));
    }
    if (u.pathname === '/dsh-soulmate/api/growth') return send(200, 'application/json', JSON.stringify({ ok: true, weeks: growthWeeks }));
    send(404, 'application/json', JSON.stringify({ ok: false }));
  } catch (err) {
    send(500, 'application/json', JSON.stringify({ ok: false, error: String(err) }));
  }
});
server.listen(PORT, '127.0.0.1', () => console.log('neuron smoke on http://127.0.0.1:' + PORT));