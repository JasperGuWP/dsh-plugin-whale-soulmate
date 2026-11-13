// Soulmate Home page: one self-contained HTML5 document (no CDN, no build step) with two
// instantly switchable 3D worlds rendered by a tiny perspective engine on <canvas>:
//   * Sci-Fi Neural Connectome Nebula  (data: GET /dsh-soulmate/api/neural-graph)
//   * Cozy 3D Room                     (bookshelf / photo wall / dining table / wardrobe / cloud portal)
// Plus the zero-friction 30-second onboarding overlay.
//
// NOTE for maintainers: CLIENT_JS lives inside String.raw, so it must not contain backticks or
// the two-character sequence "dollar + brace"; use string concatenation instead.

const escJson = (value) =>
  JSON.stringify(value ?? {})
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');

const CSS = String.raw`
:root{--cy:#00f2fe;--bl:#4facfe;--gold:#ffd700;--pu:#b721ff;--mg:#ff2a85;--bg:#02030a;--glass:rgba(8,14,34,.72);--line:rgba(0,242,254,.32);--tx:#d8f6ff;--dim:#7fa4b8}
*{box-sizing:border-box}
html,body{margin:0;height:100%;background:var(--bg);color:var(--tx);font:14px/1.5 system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;overflow:hidden}
#stage{position:fixed;inset:0;width:100%;height:100%;display:block;touch-action:none;transition:opacity .28s ease}
#stage.fade{opacity:0}
button{font:inherit;color:inherit;cursor:pointer}
.glass{background:var(--glass);border:1px solid var(--line);border-radius:14px;backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);box-shadow:0 0 24px rgba(0,242,254,.12),inset 0 0 18px rgba(79,172,254,.06)}
#top{position:fixed;left:12px;right:12px;top:10px;display:flex;align-items:center;gap:10px;padding:8px 12px;z-index:5;flex-wrap:wrap}
#top .brand{font-weight:700;letter-spacing:.5px;color:var(--cy);text-shadow:0 0 10px rgba(0,242,254,.6)}
.seg{display:inline-flex;border:1px solid var(--line);border-radius:999px;overflow:hidden}
.seg button{background:transparent;border:0;padding:6px 14px;color:var(--dim);transition:all .2s}
.seg button.on{background:linear-gradient(135deg,rgba(0,242,254,.28),rgba(183,33,255,.28));color:#fff;text-shadow:0 0 8px rgba(0,242,254,.8)}
.chip{display:inline-flex;align-items:center;gap:4px;padding:3px 10px;border:1px solid var(--line);border-radius:999px;font-size:12px;color:var(--tx);background:rgba(0,242,254,.06);white-space:nowrap}
.sp{flex:1}
.btn{background:rgba(0,242,254,.08);border:1px solid var(--line);border-radius:10px;padding:6px 12px;transition:all .15s}
.btn:hover{background:rgba(0,242,254,.2);box-shadow:0 0 12px rgba(0,242,254,.35)}
.btn.gold{border-color:rgba(255,215,0,.5);color:var(--gold)}
.btn.gold:hover{background:rgba(255,215,0,.15);box-shadow:0 0 12px rgba(255,215,0,.35)}
.btn.red{border-color:rgba(255,42,133,.55);color:#ff7aaa}
.btn.red:hover{background:rgba(255,42,133,.18)}
.btn.pu{border-color:rgba(183,33,255,.55);color:#d79bff}
.btn[disabled]{opacity:.4;cursor:not-allowed}
#bottom{position:fixed;left:12px;bottom:12px;display:flex;gap:8px;align-items:center;padding:8px 10px;z-index:5;flex-wrap:wrap;max-width:calc(100% - 24px)}
#bottom input[type=text]{background:rgba(0,0,0,.35);border:1px solid var(--line);border-radius:8px;color:var(--tx);padding:6px 10px;width:230px;outline:none}
#bottom input[type=text]:focus{border-color:var(--cy);box-shadow:0 0 10px rgba(0,242,254,.4)}
#recallList{position:fixed;left:12px;bottom:66px;max-width:360px;max-height:200px;overflow:auto;padding:8px 10px;z-index:5;font-size:12px;display:none}
#recallList div{padding:2px 0;border-bottom:1px dashed rgba(0,242,254,.15)}
#stats{position:fixed;right:12px;bottom:12px;padding:8px 12px;z-index:5;font-size:12px;color:var(--dim);display:flex;gap:10px;flex-wrap:wrap}
#stats b{color:var(--tx)}
#hint{position:fixed;left:50%;bottom:14px;transform:translateX(-50%);padding:6px 14px;z-index:4;font-size:12px;color:var(--dim);pointer-events:none;white-space:nowrap}
#hud{position:fixed;right:12px;top:68px;width:340px;max-width:calc(100% - 24px);max-height:calc(100% - 140px);overflow:auto;padding:14px;z-index:6;display:none}
#hud h3{margin:0 0 4px;color:var(--cy);font-size:15px;text-shadow:0 0 8px rgba(0,242,254,.6);word-break:break-all}
#hud .kv{display:grid;grid-template-columns:92px 1fr;gap:2px 8px;font-size:12px;margin:8px 0}
#hud .kv span:nth-child(odd){color:var(--dim)}
#hud .body{font-size:12px;background:rgba(0,0,0,.35);border:1px solid rgba(0,242,254,.18);border-radius:8px;padding:8px;max-height:180px;overflow:auto;white-space:pre-wrap;word-break:break-word}
#hud .acts{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}
#hud .x{position:absolute;right:10px;top:8px;background:none;border:0;color:var(--dim);font-size:18px}
.bar{height:6px;border-radius:99px;background:rgba(255,255,255,.1);overflow:hidden}
.bar i{display:block;height:100%;background:linear-gradient(90deg,var(--bl),var(--cy));box-shadow:0 0 8px var(--cy)}
.bar.pk i{background:linear-gradient(90deg,var(--pu),var(--mg));box-shadow:0 0 8px var(--mg)}
#modal{position:fixed;inset:0;z-index:20;display:none;align-items:center;justify-content:center;background:rgba(1,3,12,.55);padding:16px}
#modal.on{display:flex}
#modal .card{width:min(860px,100%);max-height:calc(100vh - 32px);overflow:auto;padding:18px 20px;position:relative}
#modal h2{margin:0 0 10px;font-size:18px;color:var(--cy)}
#modal .x{position:absolute;right:12px;top:10px;background:none;border:0;font-size:22px;color:var(--dim)}
.tabs{display:flex;gap:6px;margin-bottom:10px;flex-wrap:wrap}
.tabs button{background:rgba(0,242,254,.06);border:1px solid var(--line);border-radius:8px;padding:5px 12px;color:var(--dim)}
.tabs button.on{color:#fff;background:rgba(0,242,254,.22)}
.cols{display:grid;grid-template-columns:200px 1fr;gap:12px}
@media(max-width:640px){.cols{grid-template-columns:1fr}}
.list{max-height:360px;overflow:auto;border:1px solid rgba(0,242,254,.18);border-radius:8px}
.list div{padding:7px 10px;border-bottom:1px solid rgba(0,242,254,.1);cursor:pointer;font-size:13px}
.list div:hover,.list div.on{background:rgba(0,242,254,.15)}
.paper{max-height:360px;overflow:auto;border:1px solid rgba(255,215,0,.25);border-radius:8px;padding:12px 14px;background:rgba(255,248,220,.06);white-space:pre-wrap;word-break:break-word;font-size:13px}
.paper a{color:var(--cy);cursor:pointer;text-decoration:underline}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px}
.grid .ph{border:1px solid var(--line);border-radius:10px;overflow:hidden;background:rgba(0,0,0,.3);font-size:12px}
.grid .ph img{width:100%;height:110px;object-fit:cover;display:block}
.grid .ph div{padding:6px 8px}
.row{display:flex;gap:10px;align-items:center;margin:8px 0;flex-wrap:wrap}
.row label{min-width:78px;color:var(--dim);font-size:12px}
input[type=text],input[type=password],textarea,select{background:rgba(0,0,0,.4);border:1px solid var(--line);border-radius:8px;color:var(--tx);padding:6px 9px;outline:none;font:inherit}
input[type=text],input[type=password]{min-width:160px}
textarea{width:100%;min-height:64px}
input:focus,textarea:focus,select:focus{border-color:var(--cy)}
input[type=range]{accent-color:#00f2fe;width:170px}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:10px}
.pcard{border:1px solid var(--line);border-radius:12px;padding:10px;background:rgba(0,242,254,.05);cursor:pointer;transition:all .15s}
.pcard:hover{background:rgba(0,242,254,.14)}
.pcard.on{border-color:var(--cy);box-shadow:0 0 14px rgba(0,242,254,.5);background:rgba(0,242,254,.16)}
.pcard h4{margin:0 0 4px;font-size:14px}
.pcard p{margin:0;font-size:12px;color:var(--dim);display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.sm-gender-pick{display:flex;gap:12px;justify-content:center;margin:12px 0}
.sm-gender-btn{width:72px;height:72px;border-radius:999px;font-size:28px;border:2px solid transparent;cursor:pointer;background:rgba(0,242,254,.06);color:var(--tx)}
.sm-gender-btn.male{color:#2f6fed;border-color:#2f6fed;background:#e8f0fe}
.sm-gender-btn.female{color:#e85aad;border-color:#e85aad;background:#fde8f3}
.sm-gender-btn.on{box-shadow:0 0 0 2px currentColor}
.sec{margin:14px 0 6px;color:var(--gold);font-size:13px;letter-spacing:1px}
.tag{display:inline-block;margin:2px 4px 2px 0;padding:1px 8px;border-radius:99px;font-size:12px;border:1px solid rgba(183,33,255,.5);color:#d79bff}
#toast{position:fixed;left:50%;top:70px;transform:translate(-50%,-8px);z-index:40;padding:8px 18px;border-radius:99px;opacity:0;pointer-events:none;transition:all .25s;background:rgba(0,40,60,.9);border:1px solid var(--cy);color:#fff}
#toast.on{opacity:1;transform:translate(-50%,0)}
#saveState{font-size:12px;color:var(--dim)}
#bubble{position:fixed;z-index:4;max-width:260px;padding:8px 12px;border-radius:14px 14px 14px 2px;background:rgba(255,255,255,.93);color:#17213a;font-size:13px;pointer-events:none;opacity:0;transition:opacity .3s;box-shadow:0 4px 18px rgba(0,0,0,.4)}
#bubble.on{opacity:1}
#onb{position:fixed;inset:0;z-index:30;display:none;align-items:center;justify-content:center;background:radial-gradient(ellipse at center,rgba(4,16,40,.82),rgba(1,3,10,.96));padding:16px}
#onb.on{display:flex}
#onb .box{width:min(640px,100%);padding:26px 28px;text-align:center}
#onb h1{margin:0 0 6px;font-size:24px;background:linear-gradient(90deg,var(--cy),var(--pu));-webkit-background-clip:text;background-clip:text;color:transparent}
#onb p{color:var(--dim);margin:4px 0 14px}
#onb input{font-size:16px;padding:10px 14px;width:min(320px,100%);text-align:center}
#onb .cards{text-align:left;margin:10px 0 14px}
#onb .dots{margin-top:12px;color:var(--dim);font-size:12px}
.hide{display:none!important}
`;

const CLIENT_JS = String.raw`
(function () {
'use strict';
var doc = document;
function $(id) { return doc.getElementById(id); }
function h(tag, attrs) {
  var e = doc.createElement(tag);
  if (attrs) for (var k in attrs) {
    var v = attrs[k];
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k === 'style') e.style.cssText = v;
    else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (var i = 2; i < arguments.length; i++) add(e, arguments[i]);
  return e;
}
function add(e, c) {
  if (c == null || c === false) return;
  if (Array.isArray(c)) { c.forEach(function (x) { add(e, x); }); return; }
  e.appendChild(typeof c === 'object' ? c : doc.createTextNode(String(c)));
}
function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
function lerp(a, b, t) { return a + (b - a) * t; }
function hash(s) { var x = 2166136261; s = String(s); for (var i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619); } return ((x >>> 0) % 100000) / 100000; }
function now() { return performance.now() / 1000; }
function safeHex(c, d) { return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(c || '') ? c : d; }
function rgb(hex) { hex = String(hex || '#ffffff').replace('#', ''); if (hex.length === 3) hex = hex.split('').map(function (c) { return c + c; }).join(''); var n = parseInt(hex, 16); if (isNaN(n)) n = 0xffffff; return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function rgba(hex, a) { var c = rgb(hex); return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')'; }
function shade(hex, k, tint) { var c = rgb(hex), t = tint || [1, 1, 1]; return 'rgb(' + clamp(c[0] * k * t[0], 0, 255) + ',' + clamp(c[1] * k * t[1], 0, 255) + ',' + clamp(c[2] * k * t[2], 0, 255) + ')'; }
function safeUrl(u) { return typeof u === 'string' && /^(https?:\/\/|data:image\/|\/)/i.test(u) ? u : ''; }
function companionPronoun(gender) {
  if (gender === 'female') return { third: '她' };
  if (gender === 'male') return { third: '他' };
  return { third: '伙伴' };
}
function sheHe() {
  var g = SUM.config && SUM.config.persona && SUM.config.persona.gender;
  return companionPronoun(g === 'male' || g === 'female' ? g : null).third;
}

// ------------------------------------------------------------------ state & api
var INIT = {};
try { INIT = JSON.parse($('soulmate-initial').textContent || '{}'); } catch (e) { INIT = {}; }
var SUM = INIT.summary || INIT || {};
var qs = new URLSearchParams(location.search);
var mode = qs.get('mode') === 'nebula' ? 'nebula' : qs.get('mode') === 'room' ? 'room' : (SUM.config && SUM.config.widget && SUM.config.widget.defaultView === 'nebula' ? 'nebula' : 'room');

function api(method, path, body) {
  var opt = { method: method, credentials: 'same-origin', headers: {} };
  if (body !== undefined) { opt.headers['content-type'] = 'application/json'; opt.body = JSON.stringify(body); }
  return fetch('/dsh-soulmate/api/' + path, opt).then(function (r) {
    return r.json().catch(function () { return { ok: false, error: 'bad response' }; }).then(function (j) { j._status = r.status; return j; });
  }).catch(function (e) { return { ok: false, error: String(e && e.message || e) }; });
}
function adopt(resp) { if (resp && resp.config && resp.state) { SUM = Object.assign({}, SUM, resp); renderTop(); } }

var toastT = 0;
function toast(msg) { var t = $('toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(function () { t.classList.remove('on'); }, 2000); }
var saveTimers = {}, saveBusy = 0;
function autosave(key, fn, delay) {
  clearTimeout(saveTimers[key]);
  $('saveState').textContent = '编辑中…';
  saveTimers[key] = setTimeout(function () {
    saveBusy++; $('saveState').textContent = '保存中…';
    Promise.resolve(fn()).then(function (r) { saveBusy--; if (r && r.ok === false) { $('saveState').textContent = '保存失败'; toast('⚠️ ' + (r.error || r.blockedReason || '保存失败')); } else { $('saveState').textContent = '已自动保存 ✓'; toast('已自动保存 ✓'); } });
  }, delay == null ? 600 : delay);
}

// ------------------------------------------------------------------ canvas + camera
var cv = $('stage'), g = cv.getContext('2d');
var W = 0, H = 0, DPR = 1;
function resize() { DPR = Math.min(2, window.devicePixelRatio || 1); W = cv.clientWidth; H = cv.clientHeight; cv.width = Math.round(W * DPR); cv.height = Math.round(H * DPR); g.setTransform(DPR, 0, 0, DPR, 0, 0); }
window.addEventListener('resize', resize);
var cam = { yaw: 0.5, pitch: 0.3, dist: 150, tx: 0, ty: 0, tz: 0, fovK: 0.85 };
var tween = null;
var PRESET = {
  nebula: { yaw: 0.5, pitch: 0.28, dist: 150, tx: 0, ty: 0, tz: 0, fovK: 0.85 },
  room: { yaw: -0.62, pitch: 0.5, dist: 62, tx: 0, ty: 5, tz: 0, fovK: 1.55 }
};
function flyTo(p, ms) { tween = { from: { yaw: cam.yaw, pitch: cam.pitch, dist: cam.dist, tx: cam.tx, ty: cam.ty, tz: cam.tz }, to: p, t0: performance.now(), dur: ms || 700 }; }
function stepTween() {
  if (!tween) return;
  var k = clamp((performance.now() - tween.t0) / tween.dur, 0, 1), e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
  ['yaw', 'pitch', 'dist', 'tx', 'ty', 'tz'].forEach(function (f) { if (tween.to[f] != null) cam[f] = lerp(tween.from[f], tween.to[f], e); });
  if (k >= 1) tween = null;
}
function fov() { return Math.min(W, H * 1.25) * cam.fovK; }
function project(x, y, z) {
  var dx = x - cam.tx, dy = y - cam.ty, dz = z - cam.tz;
  var cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw), cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
  var x1 = dx * cy - dz * sy, z1 = dx * sy + dz * cy;
  var y1 = dy * cp + z1 * sp, z2 = z1 * cp - dy * sp;
  var d = cam.dist + z2;
  if (d < 2) return null;
  var s = fov() / d;
  return { x: W / 2 + x1 * s, y: H / 2 - y1 * s, d: d, s: s };
}
function camPos() {
  var cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch), z1 = -cam.dist * cp;
  return { x: cam.tx + z1 * Math.sin(cam.yaw), y: cam.ty + cam.dist * sp, z: cam.tz + z1 * Math.cos(cam.yaw) };
}

// glow sprites
var sprites = {};
function sprite(color) {
  if (sprites[color]) return sprites[color];
  var c = doc.createElement('canvas'); c.width = c.height = 96;
  var x = c.getContext('2d'), gr = x.createRadialGradient(48, 48, 0, 48, 48, 48);
  gr.addColorStop(0, 'rgba(255,255,255,0.95)'); gr.addColorStop(0.14, rgba(color, 0.9)); gr.addColorStop(0.45, rgba(color, 0.26)); gr.addColorStop(1, rgba(color, 0));
  x.fillStyle = gr; x.fillRect(0, 0, 96, 96);
  return (sprites[color] = c);
}
function glow(px, py, r, color, a) { if (r < 0.5 || a <= 0) return; g.globalAlpha = clamp(a, 0, 1); g.drawImage(sprite(color), px - r, py - r, r * 2, r * 2); g.globalAlpha = 1; }

// background stars
var STARS = []; (function () { for (var i = 0; i < 260; i++) { var th = Math.random() * 6.283, ph = Math.acos(2 * Math.random() - 1), r = 420; STARS.push({ x: r * Math.sin(ph) * Math.cos(th), y: r * Math.cos(ph), z: r * Math.sin(ph) * Math.sin(th), p: Math.random() * 6.28, s: Math.random() }); } })();

// ------------------------------------------------------------------ top bar
function renderTop() {
  var st = SUM.state || {}, bs = SUM.bondStage || {}, ps = (SUM.config && SUM.config.persona) || {};
  var MOOD = { happy: '😊 开心', focused: '🧐 专注', hungry: '🍚 饿了', sleepy: '😴 犯困', sulking: '😤 小委屈' };
  var box = $('chips'); box.textContent = '';
  box.appendChild(h('span', { class: 'chip', text: (SUM.displayName || ps.name || 'soulmate') }));
  box.appendChild(h('span', { class: 'chip', text: 'Lv.' + (bs.level || 1) + ' ' + (bs.title || '') }));
  box.appendChild(h('span', { class: 'chip', text: MOOD[st.mood] || st.mood || '' }));
  box.appendChild(h('span', { class: 'chip', text: '⚡ ' + (st.energy | 0) }));
  box.appendChild(h('span', { class: 'chip', text: '❤️ ' + (st.affinity | 0) }));
  var cl = SUM.config && SUM.config.cloud;
  box.appendChild(h('span', { class: 'chip', style: 'color:' + (cl && cl.consentGiven ? '#b721ff' : '#7fa4b8'), text: cl && cl.consentGiven ? '☁️ 云同步开' : '☁️ 纯本地' }));
  $('btnRoom').classList.toggle('on', mode === 'room'); $('btnNeb').classList.toggle('on', mode === 'nebula');
}
function refreshSummary() { return api('GET', 'state').then(function (r) { if (r && r.ok) { SUM = r; renderTop(); } return r; }); }

// ================================================================== NEBULA
var N = { nodes: [], byId: {}, syn: [], stats: {}, flash: {}, waves: [], beams: [], parts: [], hover: null, sel: null, seq: 0, ready: false, cloud: {} };
function ingest(graph) {
  var old = N.byId; N.byId = {};
  N.nodes = (graph.nodes || []).map(function (n) {
    var e = old[n.id] || { phase: hash(n.id) * 6.283, dir: hash(n.id + 'd') > 0.5 ? 1 : -1 };
    e.d = n; e.id = n.id; e.parent = null; e.adj = []; N.byId[n.id] = e; return e;
  });
  N.syn = (graph.synapses || []).map(function (s) { return { d: s, a: N.byId[s.source], b: N.byId[s.target], off: hash(s.id) }; }).filter(function (s) { return s.a && s.b; });
  N.syn.forEach(function (s) { s.a.adj.push(s.b); s.b.adj.push(s.a); if (s.d.kind === 'topic_cluster') s.a.parent = s.b; });
  N.stats = graph.stats || {}; N.cloud = graph.cloud || {};
  if (N.sel && !N.byId[N.sel.id]) closeHud(); else if (N.sel) { N.sel = N.byId[N.sel.id]; fillHud(); }
  var s = N.stats; $('stats').innerHTML = '';
  [['本地皮层', s.localCount], ['量子护盾', s.privateShieldedCount], ['远程星环', s.remoteCloudCount], ['突触', s.synapseCount], ['平均能量', s.averageEnergy]].forEach(function (p) { $('stats').appendChild(h('span', null, p[0] + ' ', h('b', { text: String(p[1] == null ? 0 : p[1]) }))); });
}
function nodePos(e, t) {
  var d = e.d, p = d.position, x = p.x, y = p.y, z = p.z;
  if (e.parent) {
    var c = e.parent.d.position, ox = x - c.x, oz = z - c.z, a = t * (0.12 + 0.32 * d.energy) * e.dir, ca = Math.cos(a), sa = Math.sin(a);
    x = c.x + ox * ca - oz * sa; z = c.z + ox * sa + oz * ca; y += Math.sin(t * 0.9 + e.phase) * 0.35;
  } else if (d.zone === 'remote_nebula') {
    var b = t * 0.035, cb = Math.cos(b), sb = Math.sin(b), nx = x * cb - z * sb; z = x * sb + z * cb; x = nx; y += Math.sin(t * 0.6 + e.phase) * 0.5;
  } else y += Math.sin(t * 0.7 + e.phase) * 0.22;
  return [x, y, z];
}
function ring3d(cx, cy, cz, r, tiltX, tiltZ, ang, color, a, lw) {
  var pts = [], n = 30, i, p;
  for (i = 0; i <= n; i++) {
    var th = i / n * 6.2832 + ang, x = Math.cos(th) * r, z = Math.sin(th) * r, y = 0;
    var y1 = y * Math.cos(tiltX) - z * Math.sin(tiltX), z1 = y * Math.sin(tiltX) + z * Math.cos(tiltX);
    var x1 = x * Math.cos(tiltZ) - y1 * Math.sin(tiltZ), y2 = x * Math.sin(tiltZ) + y1 * Math.cos(tiltZ);
    p = project(cx + x1, cy + y2, cz + z1); if (!p) return; pts.push(p);
  }
  g.beginPath(); g.moveTo(pts[0].x, pts[0].y); for (i = 1; i < pts.length; i++) g.lineTo(pts[i].x, pts[i].y);
  g.strokeStyle = rgba(color, a); g.lineWidth = lw || 1; g.stroke();
}
function hexCage(cx, cy, cz, r, t, a) {
  var top = [], bot = [], i, rot = t * 0.6;
  for (i = 0; i < 6; i++) {
    var th = rot + i * Math.PI / 3, x = Math.cos(th) * r, z = Math.sin(th) * r;
    top.push(project(cx + x, cy + r * 0.62, cz + z)); bot.push(project(cx + x, cy - r * 0.62, cz + z));
  }
  if (top.some(function (p) { return !p; }) || bot.some(function (p) { return !p; })) return;
  g.strokeStyle = 'rgba(255,215,0,' + a + ')'; g.lineWidth = 1.2;
  [top, bot].forEach(function (ps, k) { g.beginPath(); ps.forEach(function (p, j) { if (j) g.lineTo(p.x, p.y); else g.moveTo(p.x, p.y); }); g.closePath(); g.stroke(); if (!k) { g.fillStyle = 'rgba(255,215,0,' + (a * 0.1) + ')'; g.fill(); } });
  g.beginPath(); for (i = 0; i < 6; i++) { g.moveTo(top[i].x, top[i].y); g.lineTo(bot[i].x, bot[i].y); } g.stroke();
}
function fireWave(e, delay, big) { N.waves.push({ e: e, t0: now() + (delay || 0), big: !!big }); }
function fireRecall(ids) {
  var t = now(), seen = {};
  (ids || []).forEach(function (id) {
    var e = N.byId[id] || N.byId[id.replace(/^remote:/, '')]; if (!e) return;
    N.flash[e.id] = t; fireWave(e, 0, true); seen[e.id] = 1;
    e.adj.forEach(function (nb, i) { if (seen[nb.id]) return; seen[nb.id] = 1; N.flash[nb.id] = t + 0.25; fireWave(nb, 0.25 + i * 0.02); N.beams.push({ a: e, b: nb, t0: t, dur: 0.55, c: '#ffffff', c2: '#00f2fe', w: 2 });
      nb.adj.slice(0, 4).forEach(function (n2) { if (seen[n2.id]) return; seen[n2.id] = 1; N.flash[n2.id] = t + 0.55; fireWave(n2, 0.55); N.beams.push({ a: nb, b: n2, t0: t + 0.25, dur: 0.5, c: '#bfefff', c2: '#4facfe', w: 1.4 }); }); });
  });
}
function fireWarp() {
  var t = now();
  N.syn.forEach(function (s) { if (s.d.kind !== 'warp_sync_beam') return; var dl = Math.random() * 0.9; N.beams.push({ a: s.a, b: s.b, t0: t + dl, dur: 1.1, c: '#4facfe', c2: '#b721ff', w: 3, warp: true }); N.flash[s.a.id] = t + dl; N.flash[s.b.id] = t + dl + 1.1; fireWave(s.a, dl); fireWave(s.b, dl + 1.1, true); });
}
function burst(e) {
  if (!e || !e.sp) return; var n = 40;
  for (var i = 0; i < n; i++) { var a = Math.random() * 6.283, v = 30 + Math.random() * 130; N.parts.push({ x: e.sp.x, y: e.sp.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, t0: now(), life: 0.8 + Math.random() * 0.7, c: e.d.color, s: 3 + Math.random() * 4 }); }
}
function drawNebula(t, dt) {
  var bg = g.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(W, H) * 0.75);
  bg.addColorStop(0, '#0a1230'); bg.addColorStop(0.55, '#050818'); bg.addColorStop(1, '#010206');
  g.fillStyle = bg; g.fillRect(0, 0, W, H);
  g.globalCompositeOperation = 'lighter';
  STARS.forEach(function (s) { var p = project(s.x, s.y, s.z); if (!p) return; g.globalAlpha = 0.25 + 0.35 * Math.abs(Math.sin(t * (0.4 + s.s) + s.p)); g.fillStyle = '#9fd8ff'; g.fillRect(p.x, p.y, 1.3, 1.3); }); g.globalAlpha = 1;
  // orbital guide rings
  ring3d(0, 0, 0, 56, 0, 0, t * 0.035, '#b721ff', 0.2, 1); ring3d(0, 0, 0, 66, 0.18, 0, -t * 0.02, '#ff2a85', 0.14, 1); ring3d(0, 0, 0, 56, 0.9, 0.4, t * 0.03, '#b721ff', 0.08, 1);
  ring3d(0, 0, 0, 14, 0.4, 0.2, t * 0.2, '#00f2fe', 0.12, 1);
  // positions
  N.nodes.forEach(function (e) { var p = nodePos(e, t); e.wp = p; e.sp = project(p[0], p[1], p[2]); });
  // synapses
  N.syn.forEach(function (s) {
    if (!s.a.sp || !s.b.sp) return;
    var kind = s.d.kind, col = s.d.pulseColor || '#4facfe', base = kind === 'warp_sync_beam' ? 0.07 : 0.1 + 0.16 * s.d.strength;
    g.strokeStyle = rgba(col, base); g.lineWidth = kind === 'wiki_link' ? 1.4 : 1; g.beginPath(); g.moveTo(s.a.sp.x, s.a.sp.y); g.lineTo(s.b.sp.x, s.b.sp.y); g.stroke();
    var sp = (kind === 'warp_sync_beam' ? 0.07 : 0.14) + 0.4 * (s.a.d.energy + s.b.d.energy) / 2, u = (t * sp + s.off) % 1;
    glow(lerp(s.a.sp.x, s.b.sp.x, u), lerp(s.a.sp.y, s.b.sp.y, u), 7 + 3 * s.d.strength, col, kind === 'warp_sync_beam' ? 0.5 : 0.8);
  });
  // beams (recall + warp)
  N.beams = N.beams.filter(function (b) { return t - b.t0 < b.dur + 0.3; });
  N.beams.forEach(function (b) {
    var u = (t - b.t0) / b.dur; if (u < 0 || !b.a.sp || !b.b.sp) return; var hu = clamp(u, 0, 1), tu = clamp(u - 0.3, 0, 1);
    var x0 = lerp(b.a.sp.x, b.b.sp.x, tu), y0 = lerp(b.a.sp.y, b.b.sp.y, tu), x1 = lerp(b.a.sp.x, b.b.sp.x, hu), y1 = lerp(b.a.sp.y, b.b.sp.y, hu);
    var gr = g.createLinearGradient(x0, y0, x1, y1); gr.addColorStop(0, rgba(b.c2, 0)); gr.addColorStop(1, rgba(b.c, 0.95));
    g.strokeStyle = gr; g.lineWidth = b.w; g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke(); glow(x1, y1, b.warp ? 16 : 11, b.c, 0.95 * (1 - Math.max(0, u - 1) * 3));
  });
  // nodes far -> near
  var order = N.nodes.filter(function (e) { return e.sp; }).sort(function (a, b) { return b.sp.d - a.sp.d; });
  order.forEach(function (e) {
    var d = e.d, sp = e.sp, en = d.energy, pulse = 0.78 + 0.22 * Math.sin(t * (0.8 + 2.6 * en) + e.phase), fl = N.flash[e.id] ? clamp(1 - (t - N.flash[e.id]) / 1.6, 0, 1) : 0;
    if (t < (N.flash[e.id] || 0)) fl = 0;
    var r = Math.max(2.2, d.size * sp.s * 0.9); e.pr = r;
    var a = (0.3 + 0.7 * en) * pulse, col = d.color, big = r * 3.4;
    if (d.kind === 'remote_cloud') a *= 0.85;
    glow(sp.x, sp.y, big * (1 + fl * 0.8), fl > 0.05 ? '#ffffff' : col, clamp(a + fl, 0, 1));
    glow(sp.x, sp.y, big * 0.55, col, clamp(a + 0.15, 0, 1));
    g.fillStyle = 'rgba(255,255,255,' + clamp(0.55 + fl, 0, 1) + ')';
    if (d.kind === 'episode_crystal') { var q = r * 0.75; g.save(); g.translate(sp.x, sp.y); g.rotate(t * 0.6 + e.phase); g.fillRect(-q * 0.6, -q * 0.6, q * 1.2, q * 1.2); g.restore(); }
    else if (d.kind === 'remote_capability') { var q2 = r * 1.2; g.strokeStyle = rgba(col, 0.95); g.lineWidth = 1.5; g.beginPath(); g.moveTo(sp.x - q2, sp.y); g.lineTo(sp.x + q2, sp.y); g.moveTo(sp.x, sp.y - q2); g.lineTo(sp.x, sp.y + q2); g.stroke(); g.beginPath(); g.arc(sp.x, sp.y, r * 0.35, 0, 6.28); g.fill(); }
    else { g.beginPath(); g.arc(sp.x, sp.y, Math.max(1.2, r * 0.32), 0, 6.28); g.fill(); }
    if (d.kind === 'wiki_star') { var w = e.wp; ring3d(w[0], w[1], w[2], d.size * 1.7, 0.5, 0, t * (0.7 + en), col, 0.55, 1.2); ring3d(w[0], w[1], w[2], d.size * 2.3, -0.7, 0.9, -t * 0.5, '#bfefff', 0.35, 1); }
    if (d.kind === 'remote_cloud') { var w2 = e.wp; ring3d(w2[0], w2[1], w2[2], d.size * 1.4, 0.3, 0.2, t * 0.6, '#ff2a85', 0.3, 1); }
    if (d.shielded) hexCage(e.wp[0], e.wp[1], e.wp[2], Math.max(1.6, d.size * 1.6), t + e.phase, 0.55 + 0.25 * Math.sin(t * 2 + e.phase));
    if (N.sel === e) { g.strokeStyle = '#ffffff'; g.lineWidth = 1.5; g.beginPath(); g.arc(sp.x, sp.y, big * 0.7 + 3 * Math.sin(t * 5), 0, 6.28); g.stroke(); }
  });
  // waves
  N.waves = N.waves.filter(function (w) { return t - w.t0 < 1.1; });
  N.waves.forEach(function (w) { var age = t - w.t0; if (age < 0 || !w.e.sp) return; var k = age / 1.1; g.strokeStyle = 'rgba(210,250,255,' + (0.8 * (1 - k)) + ')'; g.lineWidth = w.big ? 2.4 : 1.4; g.beginPath(); g.arc(w.e.sp.x, w.e.sp.y, 6 + k * (w.big ? 150 : 90), 0, 6.28); g.stroke(); });
  // particles
  N.parts = N.parts.filter(function (p) { return t - p.t0 < p.life; });
  N.parts.forEach(function (p) { var age = t - p.t0; glow(p.x + p.vx * age, p.y + p.vy * age + 40 * age * age, p.s * (1 - age / p.life) * 2.5, p.c, 1 - age / p.life); });
  g.globalCompositeOperation = 'source-over';
  // labels
  g.font = '12px system-ui,sans-serif'; g.textAlign = 'center';
  order.forEach(function (e) {
    var show = e.d.kind === 'wiki_star' || e.d.kind === 'remote_capability' || N.hover === e || N.sel === e;
    if (!show) return; g.fillStyle = N.hover === e || N.sel === e ? '#ffffff' : 'rgba(190,240,255,0.78)';
    g.fillText(String(e.d.label || e.d.id).slice(0, 22), e.sp.x, e.sp.y + e.pr * 2.2 + 12);
  });
}
function pickNeb(mx, my) {
  var best = null, bd = 1e9;
  N.nodes.forEach(function (e) { if (!e.sp) return; var dx = e.sp.x - mx, dy = e.sp.y - my, r = Math.max(11, (e.pr || 4) * 1.7), dd = Math.sqrt(dx * dx + dy * dy); if (dd < r && dd - r < bd) { bd = dd - r; best = e; } });
  return best;
}
// ---- HUD
function closeHud() { N.sel = null; $('hud').style.display = 'none'; }
function selectNode(e) {
  N.sel = e; fillHud(); $('hud').style.display = 'block';
  var p = e.wp || nodePos(e, now()); flyTo({ tx: p[0], ty: p[1], tz: p[2], dist: Math.max(34, Math.min(cam.dist, 70)) }, 650);
}
function fillHud() {
  var e = N.sel; if (!e) return; var d = e.d, box = $('hud'); box.textContent = '';
  var local = !/^remote:|^capability:/.test(d.id), isFact = d.kind === 'fact_neuron' || d.kind === 'private_shielded' || d.kind === 'remote_cloud';
  box.appendChild(h('button', { class: 'x', onclick: closeHud, text: '×' }));
  box.appendChild(h('h3', { text: '◈ ' + (d.label || d.id) }));
  box.appendChild(h('div', { class: 'chip', text: d.kind + ' · ' + d.zone }));
  box.appendChild(h('div', { class: 'kv' },
    h('span', { text: 'id' }), h('span', { text: d.id }),
    h('span', { text: 'zone' }), h('span', { text: d.zone }),
    h('span', { text: 'energy' }), h('span', null, h('div', { class: 'bar' }, h('i', { style: 'width:' + Math.round(d.energy * 100) + '%' })), Math.round(d.energy * 100) + '%'),
    h('span', { text: 'recallCount' }), h('span', { text: String(d.recallCount) }),
    h('span', { text: 'halfLifeDays' }), h('span', { text: String(d.halfLifeDays) }),
    h('span', { text: 'importance' }), h('span', { text: String(d.importance) }),
    h('span', { text: 'shielded' }), h('span', { text: d.shielded ? '🛡️ true（仅本机）' : 'false' }),
    h('span', { text: 'synced' }), h('span', { text: d.synced ? '☁️ true' : 'false' }),
    h('span', { text: 'updated' }), h('span', { text: String(d.updatedAt || '').slice(0, 19).replace('T', ' ') })));
  box.appendChild(h('div', { class: 'body', text: d.content || d.summary || '（无内容）' }));
  var acts = h('div', { class: 'acts' });
  var canNode = isFact && (d.zone === 'local_cortex' || d.zone === 'private_vault' || d.kind === 'remote_cloud');
  acts.appendChild(h('button', { class: 'btn', disabled: !canNode, onclick: function () { nodeAction('reinforce'); }, text: '⚡ 脉冲强化 (Reinforce)' }));
  acts.appendChild(h('button', { class: 'btn gold', disabled: !canNode, onclick: function () { nodeAction('toggle_private'); }, text: '🛡️ 切换量子护盾 (Toggle Private)' }));
  var fb = h('button', { class: 'btn red', disabled: !local, onclick: function () { if (fb.dataset.arm) nodeAction('forget'); else { fb.dataset.arm = '1'; fb.textContent = '确认切除？'; setTimeout(function () { delete fb.dataset.arm; fb.textContent = '✂️ 突触切除 (Forget)'; }, 3000); } }, text: '✂️ 突触切除 (Forget)' });
  acts.appendChild(fb); box.appendChild(acts);
}
function nodeAction(action) {
  var e = N.sel; if (!e) return; var id = e.id;
  if (action === 'forget') burst(e);
  api('POST', 'memory-node', { action: action, id: id }).then(function (r) {
    if (r && r.ok) { if (r.eventSeq) N.seq = Math.max(N.seq, r.eventSeq); toast(action === 'reinforce' ? '⚡ 已注入脉冲能量' : action === 'forget' ? '✂️ 突触已切除' : (r.visibility === 'private' ? '🛡️ 已锁入量子护盾（仅本机）' : '☁️ 已解除护盾（可同步）'));
      if (action === 'reinforce') { N.flash[id] = now(); fireWave(e, 0, true); }
      if (action === 'forget') closeHud(); pollGraph(true);
    } else toast('⚠️ ' + (r.error || r.blockedReason || '操作失败'));
  });
}
function pollGraph(force) {
  if (mode !== 'nebula' && !force && N.ready) return Promise.resolve();
  return api('GET', 'neural-graph?since=' + N.seq).then(function (r) {
    if (!r || !r.ok) return;
    var first = !N.ready, evs = (r.events || []).filter(function (ev) { return ev.seq > N.seq; });
    if (!first) evs.forEach(function (ev) { if (ev.type === 'forget') (ev.ids || []).forEach(function (i) { burst(N.byId[i]); }); });
    ingest(r); N.seq = Math.max(N.seq, r.eventSeq || 0); N.ready = true;
    if (first) return;
    evs.forEach(function (ev) {
      if (ev.type === 'recall' || ev.type === 'reinforce' || ev.type === 'retain') fireRecall(ev.ids);
      else if (ev.type === 'sync' && ev.ok) setTimeout(fireWarp, 250);
    });
  });
}

// ================================================================== ROOM
var R = { objs: [], hover: null, bubbleText: '', bubbleT: 0, shelf: null, imgs: {}, heart: [] };
function tod() {
  var d = new Date(), hr = d.getHours() + d.getMinutes() / 60, top, bot, k, tint, phase;
  if (hr >= 5 && hr < 8) { phase = 'dawn'; top = '#6b8fd6'; bot = '#ffc9a0'; k = 0.8; tint = [1.05, 0.95, 0.9]; }
  else if (hr >= 8 && hr < 17) { phase = 'day'; top = '#4a9cf0'; bot = '#bfe6ff'; k = 1.05; tint = [1, 1, 1]; }
  else if (hr >= 17 && hr < 19.5) { phase = 'dusk'; top = '#5a3a8a'; bot = '#ff9a5a'; k = 0.82; tint = [1.12, 0.9, 0.8]; }
  else { phase = 'night'; top = '#050a24'; bot = '#16275a'; k = 0.56; tint = [0.78, 0.86, 1.15]; }
  return { hr: hr, top: top, bot: bot, k: k, tint: tint, phase: phase };
}
var TOD = tod(); setInterval(function () { TOD = tod(); }, 30000);
function poly(pts, fill, stroke, lw) {
  var ps = [], i; for (i = 0; i < pts.length; i++) { var p = project(pts[i][0], pts[i][1], pts[i][2]); if (!p) return null; ps.push(p); }
  g.beginPath(); g.moveTo(ps[0].x, ps[0].y); for (i = 1; i < ps.length; i++) g.lineTo(ps[i].x, ps[i].y); g.closePath();
  if (fill) { g.fillStyle = fill; g.fill(); } if (stroke) { g.strokeStyle = stroke; g.lineWidth = lw || 1; g.stroke(); } return ps;
}
function boxDraw(x0, y0, z0, x1, y1, z1, color, alpha) {
  var c = camPos(), k = TOD.k, tn = TOD.tint, ps = [];
  g.globalAlpha = alpha == null ? 1 : alpha;
  if (c.x < x0) ps.push(poly([[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], shade(color, k * 0.78, tn)));
  if (c.x > x1) ps.push(poly([[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]], shade(color, k * 0.7, tn)));
  if (c.z < z0) ps.push(poly([[x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]], shade(color, k * 0.88, tn)));
  if (c.z > z1) ps.push(poly([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], shade(color, k * 0.75, tn)));
  poly([[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]], shade(color, k * 1.12, tn), 'rgba(255,255,255,0.08)');
  g.globalAlpha = 1;
}
function bboxHit(b, mx, my) {
  var minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9, dsum = 0, n = 0;
  for (var i = 0; i < 8; i++) { var p = project(i & 1 ? b[3] : b[0], i & 2 ? b[4] : b[1], i & 4 ? b[5] : b[2]); if (!p) return null; minx = Math.min(minx, p.x); maxx = Math.max(maxx, p.x); miny = Math.min(miny, p.y); maxy = Math.max(maxy, p.y); dsum += p.d; n++; }
  if (mx >= minx && mx <= maxx && my >= miny && my <= maxy) return dsum / n; return null;
}
function decorOn(id) { var bs = SUM.bondStage || {}; return (bs.unlockedDecor || []).indexOf(id) >= 0; }
function bookshelfCounts() { var s = R.shelf; return s ? { wiki: s.wiki.length, toYou: s.toYou.length, inner: s.inner.length } : { wiki: 0, toYou: 0, inner: 0 }; }
function loadShelf() { return api('GET', 'bookshelf').then(function (r) { if (r && r.ok) R.shelf = r; return r; }); }

function drawRoom(t) {
  var c = camPos(), k = TOD.k, tn = TOD.tint;
  var bg = g.createLinearGradient(0, 0, 0, H); bg.addColorStop(0, shade('#0b1230', k, tn)); bg.addColorStop(1, shade('#1a2350', k, tn)); g.fillStyle = bg; g.fillRect(0, 0, W, H);
  // floor
  for (var i = 0; i < 12; i++) for (var j = 0; j < 12; j++) { poly([[-12 + i * 2, 0, -12 + j * 2], [-10 + i * 2, 0, -12 + j * 2], [-10 + i * 2, 0, -10 + j * 2], [-12 + i * 2, 0, -10 + j * 2]], shade((i + j) % 2 ? '#8a6446' : '#7a563b', k, tn)); }
  // rug
  (function () { var pts = [], n = 36; for (var q = 0; q < n; q++) { var a = q / n * 6.2832; pts.push([0.5 + Math.cos(a) * 6.5, 0.02, -1 + Math.sin(a) * 4.8]); } poly(pts, shade('#3a4f8e', k, tn), 'rgba(0,242,254,0.35)', 1.5); pts = []; for (q = 0; q < n; q++) { a = q / n * 6.2832; pts.push([0.5 + Math.cos(a) * 4.6, 0.03, -1 + Math.sin(a) * 3.2]); } poly(pts, shade('#5b3f8e', k, tn)); })();
  // walls (only those behind the room centre as seen from the camera)
  [{ n: [0, 1], c: '#46598f', pts: [[-12, 0, 12], [12, 0, 12], [12, 14, 12], [-12, 14, 12]] }, { n: [-1, 0], c: '#3c4d82', pts: [[-12, 0, -12], [-12, 0, 12], [-12, 14, 12], [-12, 14, -12]] }, { n: [1, 0], c: '#3c4d82', pts: [[12, 0, 12], [12, 0, -12], [12, 14, -12], [12, 14, 12]] }, { n: [0, -1], c: '#46598f', pts: [[12, 0, -12], [-12, 0, -12], [-12, 14, -12], [12, 14, -12]] }].forEach(function (w) {
    if ((w.n[0] * (-c.x) + w.n[1] * (-c.z)) <= 0) return; poly(w.pts, shade(w.c, k, tn), 'rgba(0,242,254,0.12)');
  });
  poly([[-12, 0, 11.98], [12, 0, 11.98], [12, 1.1, 11.98], [-12, 1.1, 11.98]], shade('#2a3560', k, tn)); poly([[-11.98, 0, -12], [-11.98, 0, 12], [-11.98, 1.1, 12], [-11.98, 1.1, -12]], shade('#243055', k, tn));
  // window with real time sky
  (function () { var P = [[1, 5, 11.95], [8, 5, 11.95], [8, 11, 11.95], [1, 11, 11.95]], ps = poly(P, TOD.bot); if (!ps) return;
    g.save(); g.beginPath(); ps.forEach(function (p, i) { if (i) g.lineTo(p.x, p.y); else g.moveTo(p.x, p.y); }); g.closePath(); g.clip();
    var gr = g.createLinearGradient(0, ps[3].y, 0, ps[0].y); gr.addColorStop(0, TOD.top); gr.addColorStop(1, TOD.bot); g.fillStyle = gr; g.fillRect(0, 0, W, H);
    if (TOD.phase === 'night') { for (var s = 0; s < 40; s++) { var sp = project(1.2 + hash('st' + s) * 6.6, 5.2 + hash('sy' + s) * 5.6, 11.94); if (sp) { g.fillStyle = 'rgba(255,255,255,' + (0.4 + 0.5 * Math.abs(Math.sin(t * 1.4 + s))) + ')'; g.fillRect(sp.x, sp.y, 1.5, 1.5); } } }
    var fr = (TOD.hr - 6) / 13, body = TOD.phase === 'night' ? project(6.2, 9.6, 11.94) : project(1.6 + clamp(fr, 0, 1) * 5.4, 6 + Math.sin(clamp(fr, 0, 1) * 3.14) * 4.2, 11.94);
    if (body) { glow(body.x, body.y, body.s * 2.2, TOD.phase === 'night' ? '#dfe9ff' : '#ffd36b', 0.95); }
    g.restore(); poly(P, null, shade('#d9e4ff', k, tn), 2.5); poly([[4.5, 5, 11.94], [4.5, 11, 11.94], [4.56, 11, 11.94], [4.56, 5, 11.94]], shade('#d9e4ff', k, tn)); poly([[1, 8, 11.94], [8, 8, 11.94], [8, 8.07, 11.94], [1, 8.07, 11.94]], shade('#d9e4ff', k, tn));
    var lg = TOD.phase === 'night' ? 'rgba(150,180,255,0.09)' : TOD.phase === 'dusk' ? 'rgba(255,160,90,0.14)' : 'rgba(255,240,190,0.15)';
    poly([[1, 0.03, 10], [8, 0.03, 10], [5.5, 0.03, 1], [-1.5, 0.03, 1]], lg); })();
  // objects
  R.objs = [];
  var shelf = bookshelfCounts(), pet = avatarPos();
  addObj('bookshelf', [-12, 0, -4.5, -9.4, 11, 4.5], function () {
    boxDraw(-12, 0, -4.5, -9.4, 11, 4.5, '#6b4a30');
    for (var row = 0; row < 4; row++) { var y0 = 0.7 + row * 2.6; poly([[-9.42, y0 - 0.08, -4.2], [-9.42, y0 - 0.08, 4.2], [-9.42, y0 + 0.04, 4.2], [-9.42, y0 + 0.04, -4.2]], shade('#3b2a1c', k, tn));
      var z = -4; var idx = 0; while (z < 3.7) { var hh = 1.1 + hash('b' + row + '_' + idx) * 0.9, w = 0.28 + hash('w' + row + '_' + idx) * 0.2, special = row === 3 && idx < shelf.wiki;
        var col = special ? '#00f2fe' : ['#c0504d', '#4f81bd', '#9bbb59', '#8064a2', '#f79646', '#4bacc6', '#d9b44a'][Math.floor(hash('c' + row + '_' + idx) * 7)];
        poly([[-9.42, y0, z], [-9.42, y0, z + w], [-9.42, y0 + hh, z + w], [-9.42, y0 + hh, z]], shade(col, k, tn)); if (special) { var gp = project(-9.4, y0 + hh / 2, z + w / 2); if (gp) glow(gp.x, gp.y, 14, '#00f2fe', 0.5); }
        z += w + 0.04; idx++; } }
    var lk = !decorOn('inner_diary'), dp = project(-9.4, 9.7, 0.2); if (dp) { poly([[-9.4, 9.1, -0.1], [-9.4, 9.1, 0.6], [-9.4, 10.2, 0.6], [-9.4, 10.2, -0.1]], lk ? '#555' : shade('#ff2a85', 1, [1, 1, 1])); if (!lk) glow(dp.x, dp.y, 18, '#ff2a85', 0.55); }
    label(-9.4, 11.6, 0, '📚 记忆书架');
  }, { dx: -10.7, dz: 0 });
  addObj('wardrobe', [-12, 0, 5.5, -9.4, 11, 11], function () {
    boxDraw(-12, 0, 5.5, -9.4, 11, 11, '#4e3b6e'); poly([[-9.42, 0.3, 5.8], [-9.42, 0.3, 8.2], [-9.42, 10.6, 8.2], [-9.42, 10.6, 5.8]], shade('#6a50a0', k, tn), 'rgba(0,242,254,0.3)'); poly([[-9.42, 0.3, 8.3], [-9.42, 0.3, 10.7], [-9.42, 10.6, 10.7], [-9.42, 10.6, 8.3]], shade('#6a50a0', k, tn), 'rgba(0,242,254,0.3)');
    var hp = project(-9.4, 5.4, 8.25); if (hp) glow(hp.x, hp.y, 12, '#b721ff', 0.7); label(-9.4, 11.6, 8.2, '🎨 衣帽间');
  });
  addObj('photowall', [-9, 4.4, 11.6, -0.5, 10.4, 12], function () {
    var lk = !decorOn('memento_wall'), ms = (SUM.mementos || []).slice(-6).reverse(); var fr = [[-8.6, 7.4, 2.6, 2.8], [-5.6, 7.9, 2.4, 2.4], [-2.8, 7.2, 2.6, 3.0], [-8.2, 4.6, 1.8, 2.0], [-4.9, 4.8, 2.0, 2.2], [-2.4, 4.7, 1.8, 2.0]];
    fr.forEach(function (f, i) { var x = f[0], y = f[1], w = f[2], hgt = f[3], P = [[x, y, 11.93], [x + w, y, 11.93], [x + w, y + hgt, 11.93], [x, y + hgt, 11.93]];
      poly(P, shade('#caa66a', k, tn), 'rgba(0,0,0,0.5)'); var ins = [[x + 0.2, y + 0.2, 11.92], [x + w - 0.2, y + 0.2, 11.92], [x + w - 0.2, y + hgt - 0.2, 11.92], [x + 0.2, y + hgt - 0.2, 11.92]];
      var m = ms[i], url = m && safeUrl(m.imageUrl || m.image || m.src || m.url), img = url ? getImg(url) : null;
      if (img && img.complete && img.naturalWidth && !lk) { var a = project(x + 0.2, y + hgt - 0.2, 11.92), b = project(x + w - 0.2, y + hgt - 0.2, 11.92), d = project(x + 0.2, y + 0.2, 11.92); if (a && b && d) { g.save(); g.setTransform(DPR * (b.x - a.x) / img.naturalWidth, DPR * (b.y - a.y) / img.naturalWidth, DPR * (d.x - a.x) / img.naturalHeight, DPR * (d.y - a.y) / img.naturalHeight, DPR * a.x, DPR * a.y); g.drawImage(img, 0, 0); g.restore(); } }
      else { var gps = poly(ins, shade(['#355c9a', '#6a3a8e', '#2f7d7a', '#8e4a5a', '#4a6a2f', '#7a5a2f'][i % 6], k, tn)); if (gps && !lk) { var sp = project(x + w * 0.7, y + hgt * 0.72, 11.9); if (sp) glow(sp.x, sp.y, sp.s * 0.45, '#ffe9a0', 0.55); } }
    });
    if (lk) { var p = project(-4.8, 7.6, 11.9); if (p) { g.fillStyle = 'rgba(2,6,20,0.55)'; g.fillRect(p.x - 150, p.y - 70, 300, 140); g.fillStyle = '#ffd700'; g.font = '13px system-ui'; g.textAlign = 'center'; g.fillText('🔒 亲密度 Lv.4 解锁纪念品展柜', p.x, p.y); } } label(-4.8, 11.1, 11.9, '🖼️ 纪念照片墙');
  });
  addObj('desk', [-9, 0, 9, -2, 3.2, 11.9], function () {
    boxDraw(-9, 2.6, 9, -2, 3.0, 11.9, '#7a5a3b'); boxDraw(-8.8, 0, 9.2, -8.5, 2.6, 11.7, '#5a4028'); boxDraw(-2.5, 0, 9.2, -2.2, 2.6, 11.7, '#5a4028');
    boxDraw(-6.6, 3.0, 10, -4.2, 3.12, 11.4, '#9aa3b8'); var sc = poly([[-6.5, 3.12, 11.4], [-4.3, 3.12, 11.4], [-4.3, 5.1, 11.52], [-6.5, 5.1, 11.52]], shade('#0c2a44', 1, [1, 1, 1]), 'rgba(0,242,254,0.7)'); var cp = project(-5.4, 4.2, 11.5); if (cp) glow(cp.x, cp.y, cp.s * 1.4, '#00f2fe', 0.5);
  });
  addObj('table', [3, 0, -5.2, 9.2, 3.3, 0.2], function () {
    [[3.2, -5], [8.6, -5], [3.2, -0.2], [8.6, -0.2]].forEach(function (l) { boxDraw(l[0], 0, l[1], l[0] + 0.5, 2.6, l[1] + 0.5, '#5a4028'); }); boxDraw(3, 2.6, -5.2, 9.2, 3.0, 0.2, '#a07848');
    var bl = decorOn('rice_bowl'); var bp = project(6.1, 3.0, -2.6); if (bp) { var r = bp.s * 0.9; g.fillStyle = shade('#6c7480', k, tn); g.beginPath(); g.ellipse(bp.x, bp.y, r * 1.1, r * 0.4, 0, 0, 6.28); g.fill(); g.beginPath(); g.ellipse(bp.x, bp.y - r * 0.35, r, r * 0.55, 0, 0, Math.PI); g.fill();
      if (bl) { g.fillStyle = '#ffffff'; g.beginPath(); g.ellipse(bp.x, bp.y - r * 0.5, r * 0.85, r * 0.45, 0, Math.PI, 0); g.fill(); glow(bp.x, bp.y - r * 0.8, r * 1.4, '#fff3b0', 0.35); } else { g.fillStyle = 'rgba(0,0,0,0.5)'; g.font = '11px system-ui'; g.textAlign = 'center'; g.fillText('🔒 Lv.2', bp.x, bp.y - r); } }
    label(6.1, 4.4, -2.6, '🍚 餐桌投喂');
  });
  addObj('portal', [9.3, 3.2, 11.5, 11.8, 8.8, 12], function () {
    var ctr = [10.55, 6, 11.9]; for (var q = 0; q < 4; q++) ring3d(ctr[0], ctr[1], ctr[2], 2.3 - q * 0.42, Math.PI / 2, 0, t * (0.8 + q * 0.4) * (q % 2 ? -1 : 1), q % 2 ? '#ff2a85' : '#b721ff', 0.9 - q * 0.12, 2);
    var pp = project(ctr[0], ctr[1], ctr[2]); if (pp) glow(pp.x, pp.y, pp.s * 3.2, '#b721ff', 0.55); label(10.55, 9.2, 11.9, '☁️ 云端传送门');
  });
  addObj('brain', [-7.6, 0, -8.4, -4.6, 8, -5.4], function () {
    boxDraw(-7.2, 0, -8, -5, 1.2, -5.8, '#2a3a6a'); var cx = -6.1, cy = 4.6, cz = -6.9; ring3d(cx, 1.3, cz, 1.7, 0, 0, t, '#00f2fe', 0.8, 1.5); ring3d(cx, 1.3, cz, 1.1, 0, 0, -t * 1.3, '#4facfe', 0.6, 1);
    g.globalCompositeOperation = 'lighter'; var pts = []; for (var i = 0; i < 26; i++) { var th = hash('bn' + i) * 6.28 + t * 0.5, ph = Math.acos(2 * hash('bm' + i) - 1), rr = 1.7 * (0.8 + 0.2 * Math.sin(t * 2 + i)); var p = project(cx + rr * Math.sin(ph) * Math.cos(th), cy + rr * Math.cos(ph) * 0.85, cz + rr * Math.sin(ph) * Math.sin(th)); if (p) { pts.push(p); glow(p.x, p.y, 7, i % 3 ? '#00f2fe' : '#4facfe', 0.9); } }
    g.strokeStyle = 'rgba(0,242,254,0.25)'; g.beginPath(); for (i = 1; i < pts.length; i++) { g.moveTo(pts[i - 1].x, pts[i - 1].y); g.lineTo(pts[i].x, pts[i].y); if (i > 3) { g.moveTo(pts[i].x, pts[i].y); g.lineTo(pts[i - 3].x, pts[i - 3].y); } } g.stroke(); g.globalCompositeOperation = 'source-over'; label(cx, 7.2, cz, '🧠 神经元星云（点击进入）');
  });
  addObj('pet', [pet.x - 2, 0, pet.z - 1.5, pet.x + 2, 8, pet.z + 1.5], function () { drawPet(t, pet); });
  // painter's order
  R.objs.sort(function (a, b) { return b.dist - a.dist; }); R.objs.forEach(function (o) { o.draw(); });
  // vignette for night
  if (TOD.phase === 'night') { var vg = g.createRadialGradient(W / 2, H / 2, H * 0.3, W / 2, H / 2, H * 0.9); vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,20,0.4)'); g.fillStyle = vg; g.fillRect(0, 0, W, H); }
  // bubble placement
  var bp2 = project(pet.x, 9.6, pet.z), bub = $('bubble');
  if (bp2 && R.bubbleText && now() - R.bubbleT < 7) { bub.textContent = R.bubbleText; bub.style.left = clamp(bp2.x - 20, 8, W - 270) + 'px'; bub.style.top = clamp(bp2.y - 60, 60, H - 90) + 'px'; bub.classList.add('on'); } else bub.classList.remove('on');
}
function addObj(id, bbox, draw, extra) {
  var cx = (bbox[0] + bbox[3]) / 2, cz = (bbox[2] + bbox[5]) / 2, c = camPos();
  R.objs.push({ id: id, bbox: bbox, draw: draw, dist: Math.hypot(cx - c.x, cz - c.z) - (id === 'pet' ? 0 : 0) });
}
var labelQ = [];
function label(x, y, z, text) { var p = project(x, y, z); if (!p) return; g.font = '12px system-ui,sans-serif'; g.textAlign = 'center'; var w = g.measureText(text).width + 14; g.fillStyle = 'rgba(2,8,24,0.62)'; g.fillRect(p.x - w / 2, p.y - 12, w, 20); g.strokeStyle = 'rgba(0,242,254,0.35)'; g.strokeRect(p.x - w / 2, p.y - 12, w, 20); g.fillStyle = '#d8f6ff'; g.fillText(text, p.x, p.y + 2); }
function getImg(url) { var i = R.imgs[url]; if (!i) { i = new Image(); i.src = url; R.imgs[url] = i; } return i; }
function avatarPos() { var st = SUM.state || {}; if (st.activity === 'corner_sulking' || st.mood === 'sulking') return { x: -6.4, z: 7.2, back: true }; if (st.activity === 'eating_rice') return { x: 5.2, z: -2.6, back: false, seat: true }; if (st.activity === 'sleeping') return { x: 0.5, z: 0, back: false }; return { x: 0.5, z: 0, back: false }; }

// ---- avatar (drawn in a 100-unit design box, feet at the origin)
function drawPet(t, pos) {
  var base = project(pos.x, 0, pos.z); if (!base) return;
  var ap = (SUM.config && SUM.config.appearance) || {}, st = SUM.state || {}, form = ap.formPreset || 'whale-girl';
  var pc = safeHex(ap.primaryColor, '#00f2fe'), ac = safeHex(ap.accentColor, '#b721ff'), au = safeHex(ap.auraColor, '#4facfe');
  var acc = ap.accessories || {}, sc = clamp(Number(ap.scale) || 1, 0.3, 3), k = base.s * 5.8 * sc / 100;
  var spin = st.activity === 'happy_spin' ? Math.cos(t * 7) : 1, bob = Math.sin(t * 2.2) * 1.5, blink = (t % 4.2) > 4.05, mood = st.mood || 'happy', act = st.activity || '';
  g.save(); g.translate(base.x, base.y); g.scale(k, k);
  g.fillStyle = 'rgba(0,0,0,0.3)'; g.beginPath(); g.ellipse(0, 1, 26, 7, 0, 0, 6.28); g.fill();
  g.save(); g.scale(spin, 1); g.translate(0, form === 'astral-orb' ? -30 + Math.sin(t * 1.6) * 5 : bob);
  var back = pos.back, sleepy = mood === 'sleepy' || act === 'sleeping', skin = '#ffe6d6';
  function eyes(cx, cy, sep) {
    if (back) return;
    g.fillStyle = '#1b2440'; g.strokeStyle = '#1b2440'; g.lineWidth = 2;
    if (blink || sleepy) { [-1, 1].forEach(function (s) { g.beginPath(); g.moveTo(cx + s * sep - 4, cy); g.quadraticCurveTo(cx + s * sep, cy + 3, cx + s * sep + 4, cy); g.stroke(); }); }
    else if (mood === 'happy' && Math.sin(t * 0.7) > 0.2) { [-1, 1].forEach(function (s) { g.beginPath(); g.arc(cx + s * sep, cy + 2, 4, Math.PI, 0); g.stroke(); }); }
    else { [-1, 1].forEach(function (s) { g.beginPath(); g.ellipse(cx + s * sep, cy, 3.4, mood === 'focused' ? 3 : 4.6, 0, 0, 6.28); g.fill(); g.fillStyle = '#fff'; g.beginPath(); g.arc(cx + s * sep - 1, cy - 1.5, 1.3, 0, 6.28); g.fill(); g.fillStyle = '#1b2440'; }); }
    g.fillStyle = 'rgba(255,120,150,0.45)'; g.beginPath(); g.ellipse(cx - sep - 4, cy + 7, 4.5, 2.6, 0, 0, 6.28); g.ellipse(cx + sep + 4, cy + 7, 4.5, 2.6, 0, 0, 6.28); g.fill();
    g.strokeStyle = '#8a3a4a'; g.lineWidth = 1.6; g.beginPath();
    if (mood === 'hungry' || act === 'eating_rice') { g.ellipse(cx, cy + 11, 3.2, 3.6 + (act === 'eating_rice' ? Math.abs(Math.sin(t * 8)) * 2 : 0), 0, 0, 6.28); g.fillStyle = '#7a2a3a'; g.fill(); }
    else if (mood === 'sulking') { g.moveTo(cx - 4, cy + 12); g.quadraticCurveTo(cx, cy + 9, cx + 4, cy + 12); g.stroke(); }
    else if (mood === 'focused') { g.moveTo(cx - 3, cy + 11); g.lineTo(cx + 3, cy + 11); g.stroke(); }
    else { g.moveTo(cx - 4, cy + 10); g.quadraticCurveTo(cx, cy + 14, cx + 4, cy + 10); g.stroke(); }
  }
  if (form === 'whale-girl') {
    g.fillStyle = shade(pc, 0.7); g.beginPath(); g.moveTo(-10, -24); g.quadraticCurveTo(28 + Math.sin(t * 2) * 6, -6, 34 + Math.sin(t * 2) * 8, -22); g.quadraticCurveTo(24, -14, 14, -24); g.closePath(); g.fill();
    g.fillStyle = pc; g.beginPath(); g.moveTo(-16, -22); g.quadraticCurveTo(-24, -52, -13, -58); g.lineTo(13, -58); g.quadraticCurveTo(24, -52, 16, -22); g.quadraticCurveTo(0, -12, -16, -22); g.fill();
    g.fillStyle = 'rgba(255,255,255,0.7)'; g.beginPath(); g.ellipse(0, -36, 9, 14, 0, 0, 6.28); g.fill();
    g.fillStyle = shade(pc, 0.85); g.save(); g.translate(-18, -42); g.rotate(-0.5 + Math.sin(t * 3) * 0.12); g.beginPath(); g.ellipse(0, 0, 4, 11, 0, 0, 6.28); g.fill(); g.restore(); g.save(); g.translate(18, -42); g.rotate(0.5 - Math.sin(t * 3) * 0.12); g.beginPath(); g.ellipse(0, 0, 4, 11, 0, 0, 6.28); g.fill(); g.restore();
    g.fillStyle = skin; g.beginPath(); g.arc(0, -70, 19, 0, 6.28); g.fill();
    g.fillStyle = back ? shade(pc, 0.9) : pc; g.beginPath(); g.arc(0, -73, 20, Math.PI, 0); if (back) g.arc(0, -70, 20, 0, Math.PI); g.fill(); if (!back) { g.beginPath(); g.moveTo(-19, -72); g.quadraticCurveTo(-4, -62, 0, -76); g.quadraticCurveTo(6, -62, 19, -72); g.lineTo(19, -80); g.lineTo(-19, -80); g.fill(); }
    var sw = Math.sin(t * 2.4) * 4; g.fillStyle = shade(pc, 1.1); g.beginPath(); g.ellipse(-22 - sw * 0.3, -56, 5, 14, 0.2, 0, 6.28); g.ellipse(22 + sw * 0.3, -56, 5, 14, -0.2, 0, 6.28); g.fill();
    eyes(0, -69, 8);
    if (mood === 'happy' && !back) { g.strokeStyle = rgba(au, 0.8); g.lineWidth = 1.5; for (var i = 0; i < 3; i++) { var u = ((t * 0.9 + i / 3) % 1); g.beginPath(); g.arc(-4 + i * 4, -96 - u * 14, 1.4 + u, 0, 6.28); g.stroke(); } }
  } else if (form === 'cyber-muse') {
    g.globalAlpha = 0.82; var gl = Math.sin(t * 9) > 0.96 ? 3 : 0; g.translate(gl, 0);
    g.fillStyle = rgba(pc, 0.4); g.strokeStyle = pc; g.lineWidth = 1.6; g.beginPath(); g.moveTo(-15, -20); g.lineTo(-20, -56); g.lineTo(-10, -60); g.lineTo(10, -60); g.lineTo(20, -56); g.lineTo(15, -20); g.closePath(); g.fill(); g.stroke();
    g.fillStyle = rgba(pc, 0.25); g.beginPath(); g.arc(0, -72, 17, 0, 6.28); g.fill(); g.stroke();
    g.strokeStyle = ac; g.lineWidth = 2; for (var s = 0; s < 6; s++) { g.beginPath(); g.moveTo(-14 + s * 5.6, -86); g.quadraticCurveTo(-18 + s * 7 + Math.sin(t * 2 + s) * 5, -60, -16 + s * 6.4 + Math.sin(t * 2.4 + s) * 6, -36); g.stroke(); }
    g.save(); g.beginPath(); g.arc(0, -72, 17, 0, 6.28); g.rect(-22, -64, 44, 50); g.clip(); g.strokeStyle = rgba(au, 0.45); g.lineWidth = 1; for (var y = -100; y < 0; y += 5) { var yy = y + (t * 20 % 5); g.beginPath(); g.moveTo(-24, yy); g.lineTo(24, yy); g.stroke(); } g.restore();
    g.globalAlpha = 1; if (!back) { g.fillStyle = rgba(ac, 0.9); g.fillRect(-13, -75, 26, 6); } eyes(0, -69, 8);
  } else if (form === 'neko-hacker') {
    g.strokeStyle = '#1b1f3a'; g.lineWidth = 5; g.lineCap = 'round'; g.beginPath(); g.moveTo(10, -22); g.quadraticCurveTo(36, -26 + Math.sin(t * 3) * 6, 30, -52); g.stroke();
    g.fillStyle = '#1b1f3a'; g.beginPath(); g.moveTo(-17, -20); g.quadraticCurveTo(-24, -52, -13, -58); g.lineTo(13, -58); g.quadraticCurveTo(24, -52, 17, -20); g.closePath(); g.fill(); g.fillStyle = ac; g.fillRect(-2, -56, 4, 30); g.fillStyle = pc; g.fillRect(-13, -33, 26, 3);
    g.fillStyle = skin; g.beginPath(); g.arc(0, -70, 18, 0, 6.28); g.fill();
    g.fillStyle = back ? '#1b1f3a' : pc; g.beginPath(); g.moveTo(-18, -74); g.lineTo(-14, -94); g.lineTo(-4, -84); g.closePath(); g.fill(); g.beginPath(); g.moveTo(18, -74); g.lineTo(14, -94); g.lineTo(4, -84); g.closePath(); g.fill(); g.beginPath(); g.arc(0, -73, 19, Math.PI, 0); g.fill();
    if (!back) { g.fillStyle = rgba(pc, 0.85); g.fillRect(-14, -74, 28, 8); g.fillStyle = '#fff'; g.fillRect(-12 + (t * 14 % 24), -73, 3, 6); } eyes(0, -66, 8);
  } else {
    g.fillStyle = rgba(au, 0.2); g.beginPath(); g.arc(0, -50, 40 + Math.sin(t * 2) * 3, 0, 6.28); g.fill();
    var og = g.createRadialGradient(-8, -62, 4, 0, -50, 30); og.addColorStop(0, '#ffffff'); og.addColorStop(0.35, pc); og.addColorStop(1, ac); g.fillStyle = og; g.beginPath(); g.arc(0, -50, 28, 0, 6.28); g.fill();
    g.strokeStyle = au; g.lineWidth = 2.5; g.save(); g.translate(0, -50); g.rotate(t * 0.9); g.beginPath(); g.ellipse(0, 0, 44, 11, 0, 0, 6.28); g.stroke(); g.restore(); g.save(); g.translate(0, -50); g.rotate(-t * 0.6 + 1); g.beginPath(); g.ellipse(0, 0, 38, 8, 0.8, 0, 6.28); g.stroke(); g.restore();
    eyes(0, -52, 9);
  }
  // accessories
  var headY = form === 'astral-orb' ? -84 : -92;
  if (acc.quantumHalo) { g.save(); g.globalCompositeOperation = 'lighter'; g.strokeStyle = rgba(ac, 0.95); g.lineWidth = 3; g.shadowColor = ac; g.shadowBlur = 12; g.beginPath(); g.ellipse(0, headY - 6 + Math.sin(t * 2) * 1.5, 22, 5.5, 0, 0, 6.28); g.stroke(); g.restore(); }
  if (acc.holoHeadset) { g.strokeStyle = rgba(pc, 0.95); g.lineWidth = 3; g.beginPath(); g.arc(0, form === 'astral-orb' ? -52 : -70, 22, Math.PI * 1.05, Math.PI * 1.95); g.stroke(); g.fillStyle = rgba(ac, 0.95); g.beginPath(); g.arc(-22, form === 'astral-orb' ? -52 : -70, 5, 0, 6.28); g.arc(22, form === 'astral-orb' ? -52 : -70, 5, 0, 6.28); g.fill(); g.strokeStyle = rgba(pc, 0.8); g.lineWidth = 1.6; g.beginPath(); g.moveTo(-22, -68); g.quadraticCurveTo(-24, -58, -8, -58); g.stroke(); }
  if (acc.starRing) { for (var q = 0; q < 5; q++) { var a = t * 1.3 + q * 1.2566, sx = Math.cos(a) * 32, sy = -58 + Math.sin(a) * 10; var dep = Math.sin(a); g.fillStyle = dep > 0 ? '#ffe9a0' : 'rgba(255,233,160,0.45)'; star(sx, sy, 4.5 + dep * 1.5); } }
  if (decorOn('neural_crown')) { g.save(); g.globalCompositeOperation = 'lighter'; for (var n2 = 0; n2 < 7; n2++) { var xx = -18 + n2 * 6, yy2 = headY - 12 - (n2 % 2) * 5 - Math.sin(t * 3 + n2) * 1.5; g.fillStyle = rgba('#00f2fe', 0.9); g.beginPath(); g.arc(xx, yy2, 2.2, 0, 6.28); g.fill(); if (n2) { g.strokeStyle = rgba('#00f2fe', 0.5); g.beginPath(); g.moveTo(xx - 6, headY - 12 - ((n2 - 1) % 2) * 5); g.lineTo(xx, yy2); g.stroke(); } } g.restore(); }
  if (acc.ironBowl) { var eat = act === 'eating_rice', bx = eat ? 14 : 26, by = eat ? -52 + Math.sin(t * 8) * 3 : -26; g.fillStyle = '#6c7480'; g.beginPath(); g.ellipse(bx, by, 11, 4, 0, 0, 6.28); g.fill(); g.beginPath(); g.ellipse(bx, by, 10, 9, 0, 0, Math.PI); g.fill(); g.fillStyle = '#fff'; g.beginPath(); g.ellipse(bx, by - 1, 8.5, 5, 0, Math.PI, 0); g.fill(); if (eat) { g.strokeStyle = '#d9b44a'; g.lineWidth = 1.6; g.beginPath(); g.moveTo(bx + 4, by - 10); g.lineTo(bx - 8, by - 24); g.stroke(); } }
  if (act === 'working') { g.fillStyle = rgba('#00f2fe', 0.22); g.strokeStyle = '#00f2fe'; g.lineWidth = 1.2; g.fillRect(24, -76, 28, 20); g.strokeRect(24, -76, 28, 20); g.fillStyle = '#00f2fe'; for (var ln = 0; ln < 3; ln++) g.fillRect(27, -72 + ln * 5, 8 + ((t * 10 + ln * 3) % 12), 2); }
  g.restore();
  if (sleepy || act === 'sleeping') { g.fillStyle = '#cfe8ff'; g.font = 'bold 16px system-ui'; for (var z = 0; z < 3; z++) { var u2 = (t * 0.5 + z / 3) % 1; g.globalAlpha = 1 - u2; g.fillText('Z', 22 + u2 * 18, -80 - u2 * 38); } g.globalAlpha = 1; }
  if (mood === 'sulking') { g.fillStyle = '#9fb4d8'; g.font = '14px system-ui'; g.fillText('…', 24, -98 + Math.sin(t * 3) * 2); }
  R.heart = R.heart.filter(function (p) { return t - p.t0 < 1.4; });
  R.heart.forEach(function (p) { var age = t - p.t0; g.globalAlpha = 1 - age / 1.4; g.fillStyle = '#ff5a8a'; g.font = '18px system-ui'; g.fillText(p.s, p.x + Math.sin(age * 4 + p.x) * 8, -100 - age * 40); }); g.globalAlpha = 1;
  g.restore();
}
function star(x, y, r) { g.beginPath(); for (var i = 0; i < 10; i++) { var a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? r * 0.45 : r; g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr); } g.closePath(); g.fill(); }

// ---- room speech
var LINES = {
  happy: ['今天也要一起加油，{u}！', '有{u}在，bug 都不可怕。'], focused: ['嘘…正在潜航，别吵。', '这段逻辑有点意思。'],
  hungry: ['肚子咕噜咕噜的。', '{u}，该投喂了。'], sleepy: ['哈欠…让我趴一会儿。', 'zZ…'], sulking: ['好几天没动静了。', '才没有在等你呢…']
};
// Room bubbles must match the chosen persona; rice-bowl / tail flavor is rice-whale only.
var LINES_BY_PRESET = {
  'rice-whale': { happy: ['尾巴都要甩飞啦～', '哼，今天也勉强陪你加油。'], hungry: ['饭呢饭呢……{u}，该投喂了。', '没饭本鱼尾巴都懒得摆。'], sulking: ['哼，好几天不理{s}了。', '才没有在等你呢…（偷看）'] },
  'gentle-echo': { happy: ['今天也慢慢来，{u}。', '有{u}在，真好。'], hungry: ['有点饿了……{u}也记得吃饭。'], sulking: ['几天没见{u}了……有点想。'] },
  'geek-partner': { happy: ['状态不错，开工。', '有{u}在，bug 都不可怕。'], hungry: ['能量低了，投喂一下。'], sulking: ['静默好几天了。状态？'] },
  'yandere-claim': { happy: ['{u}今天也只能看着我。', '开心……因为{u}在。'], hungry: ['{u}，喂我。不许饿着我。'], sulking: ['消失这么久……不许再这样。'] },
  'quiet-guardian': { happy: ['嗯。今天也在。'], hungry: ['饿了。'], sulking: ['几天没动静。'] },
  'cool-senpai': { happy: ['还行。今天别糊弄。'], hungry: ['饭点到了。去吃。'], sulking: ['冷落我几天——随便你。'] },
  'clingy-cyclone': { happy: ['今天也要陪我玩！', '尾巴都要甩飞啦～'], hungry: ['饿饿！{u}快投喂！'], sulking: ['你好久没理我了呜……'] },
  'dark-hunter': { happy: ['不错。今天也别想甩掉我。'], hungry: ['喂我。听话。'], sulking: ['躲了几天？找到你了。'] }
};
function say(text) { R.bubbleText = text; R.bubbleT = now(); }
function sayMood() { var st = SUM.state || {}, ps = (SUM.config && SUM.config.persona) || {}, pack = LINES_BY_PRESET[ps.preset] || {}, arr = pack[st.mood] || LINES[st.mood] || LINES.happy, line = arr[Math.floor(Math.random() * arr.length)]; say(line.replace('{u}', ps.callUser || '你').replace('{s}', ps.selfRef || '我')); }
function doInteract(action, extra) {
  return api('POST', 'interact', Object.assign({ action: action }, extra || {})).then(function (r) {
    if (r && r.ok) { adopt(r); var ps = (SUM.config && SUM.config.persona) || {}; var MSG = { feed: ps.preset === 'rice-whale' ? '🍚 好吃！能量 +25' : '🍽 投喂成功，能量 +25', pat: '✋ 摸摸头～亲密度 +8', chat: '💬 聊了几句', work_assist: '⚡ 并肩作战', sleep: '🛏 晚安，精力回满' }; toast(MSG[action] || '已互动');
      if (action === 'pat' || action === 'feed') for (var i = 0; i < 4; i++) R.heart.push({ x: (Math.random() - 0.5) * 40, t0: now() + i * 0.15, s: action === 'feed' ? (ps.preset === 'rice-whale' ? '🍚' : '❤') : '❤' });
      sayMood(); } else toast('⚠️ ' + (r.error || '互动失败'));
    return r; });
}

// ================================================================== modal panels
function openModal(title, content, wide) { var m = $('modal'), c = m.querySelector('.card'); c.textContent = ''; c.appendChild(h('button', { class: 'x', onclick: closeModal, text: '×' })); c.appendChild(h('h2', { text: title })); c.appendChild(content); m.classList.add('on'); }
function closeModal() { $('modal').classList.remove('on'); }
$('modal').addEventListener('mousedown', function (e) { if (e.target === $('modal')) closeModal(); });

function openBookshelf(startTab) {
  var box = h('div', null, h('div', { text: '翻书中…', style: 'color:#7fa4b8' }));
  openModal('📚 记忆书架 · LLM Wiki 与双日记', box);
  loadShelf().then(function (r) {
    if (!r || !r.ok) { box.textContent = '读取失败：' + ((r && r.error) || ''); return; }
    var tab = startTab || 'wiki', sel = null; var nb = r.notebooks || {};
    function render() {
      box.textContent = '';
      var tabs = h('div', { class: 'tabs' }); [['wiki', '📚 LLM Wiki (' + r.wiki.length + ')'], ['toYou', '📘 ' + nb.publicTitle + ' (' + r.toYou.length + ')'], ['inner', '📕 ' + nb.innerTitle + ' (' + r.inner.length + ')' + (r.canReadInnerDiary ? '' : ' 🔒')]].forEach(function (t) { tabs.appendChild(h('button', { class: tab === t[0] ? 'on' : '', onclick: function () { tab = t[0]; sel = null; render(); }, text: t[1] })); });
      box.appendChild(tabs);
      var items = tab === 'wiki' ? r.wiki : tab === 'toYou' ? r.toYou : r.inner;
      if (!items.length) { var pp = sheHe(); box.appendChild(h('div', { style: 'color:#7fa4b8;padding:18px 4px', text: tab === 'wiki' ? '书架还空着。让' + pp + '多聊聊、再用 soulmate_memory_reflect 蒸馏成 Wiki 书页，书就会变厚。' : tab === 'toYou' ? '今天还没有写给你的信。' : (r.canReadInnerDiary ? pp + '还没写私密小本本。' : '🔒 亲密度达到 Lv.3「默契副驾」才能偷看' + pp + '的小本本。')})); return; }
      if (!sel || items.indexOf(sel) < 0) sel = items[0];
      var list = h('div', { class: 'list' }); items.forEach(function (it) { list.appendChild(h('div', { class: it === sel ? 'on' : '', onclick: function () { sel = it; render(); }, text: (it.title || it.label || it.id) + (it.private ? ' 🛡️' : '') })); });
      var paper = h('div', { class: 'paper' }); fillPaper(paper, sel.content || sel.summary || '', tab === 'wiki', function (slug) { var f = r.wiki.filter(function (w) { return w.slug === slug; })[0]; if (f) { sel = f; tab = 'wiki'; render(); } });
      box.appendChild(h('div', { class: 'cols' }, list, h('div', null, sel.summary && tab === 'wiki' ? h('div', { style: 'color:#ffd700;margin-bottom:6px', text: sel.summary }) : null, paper)));
    }
    render();
  });
}
function plainMemoryText(raw) {
  return String(raw || '')
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n*/, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^[-*_]{3,}\s*$/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
function fillPaper(el, text, links, go) {
  text = plainMemoryText(text);
  if (!links) { el.textContent = text; return; }
  var re = /\[\[([^\[\]\n|]+?)(?:\|[^\[\]\n]*)?\]\]/g, last = 0, m;
  while ((m = re.exec(text))) { el.appendChild(doc.createTextNode(text.slice(last, m.index))); (function (slug) { el.appendChild(h('a', { onclick: function () { go(slug.trim().toLowerCase().replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '')); }, text: '[[' + slug + ']]' })); })(m[1]); last = m.index + m[0].length; }
  el.appendChild(doc.createTextNode(text.slice(last)));
}
function openPhotos() {
  var ms = (SUM.mementos || []).slice().reverse(), grid = h('div', { class: 'grid' });
  if (decorOn('memento_wall') === false) grid.appendChild(h('div', { style: 'grid-column:1/-1;color:#ffd700', text: '🔒 亲密度 Lv.4「深海知己」解锁纪念品展柜；现在先在这里看看已有的纪念品吧。' }));
  ms.forEach(function (m) { var url = safeUrl(m.imageUrl || m.image || m.src || m.url); grid.appendChild(h('div', { class: 'ph' }, url ? h('img', { src: url, alt: 'memento', loading: 'lazy' }) : h('div', { style: 'height:110px;background:linear-gradient(135deg,#355c9a,#6a3a8e)' }), h('div', { text: String(m.title || m.caption || m.capability || '纪念品').slice(0, 60) + (m.source === 'cloud' ? ' ☁️' : '') }))); });
  if (!ms.length) grid.appendChild(h('div', { style: 'grid-column:1/-1;color:#7fa4b8', text: '还没有纪念品。连接云端后，让' + sheHe() + '调用 soulmate_cloud_draw_selfie 之类的云端能力，成品会自动挂到这面墙上。' }));
  openModal('🖼️ 纪念照片墙', grid);
}
function openDining() {
  var st = SUM.state || {}, box = h('div');
  function bars() { var s = SUM.state || {}; return [h('div', { text: '精力 ' + (s.energy | 0) + '/100' }), h('div', { class: 'bar' }, h('i', { style: 'width:' + (s.energy | 0) + '%' })), h('div', { style: 'margin-top:8px', text: '亲密度 ' + (s.affinity | 0) + '/1000 · ' + ((SUM.bondStage || {}).title || '') }), h('div', { class: 'bar pk' }, h('i', { style: 'width:' + clamp((s.affinity | 0) / 10, 0, 100) + '%' }))]; }
  function paint() { box.textContent = ''; add(box, bars()); var row = h('div', { class: 'row', style: 'margin-top:14px' });
    var rice = ((SUM.config && SUM.config.persona) || {}).preset === 'rice-whale';
    [[ 'feed', rice ? '🍚 来碗大白米饭' : '🍽 投喂'], ['feed', rice ? '🍗 加个鸡腿' : '🍰 加个点心'], ['feed', '🌙 来份夜宵'], ['pat', '✋ 摸摸头'], ['chat', '💬 聊两句'], ['sleep', '🛏 哄睡觉']].forEach(function (b) { row.appendChild(h('button', { class: 'btn', onclick: function () { doInteract(b[0]).then(paint); }, text: b[1] })); }); box.appendChild(row); box.appendChild(h('div', { style: 'color:#7fa4b8;font-size:12px', text: '投喂恢复精力并提升亲密度；亲密度越高，' + sheHe() + '说话越亲近、房间装饰越丰富。' })); }
  paint(); openModal((((SUM.config && SUM.config.persona) || {}).preset === 'rice-whale' ? '🍚' : '🍽') + ' 餐桌投喂', box);
}
function openCloud() {
  var cl = (SUM.config && SUM.config.cloud) || {}, box = h('div'), authBox = h('div', { style: 'color:#7fa4b8;font-size:12px' }), sync = { timer: 0 };
  var serverIn = h('input', { type: 'text', value: cl.serverUrl || '', placeholder: 'https://aigc.example.com', style: 'min-width:280px' });
  var consent = h('input', { type: 'checkbox' }); consent.checked = cl.consentGiven === true;
  var e2ee = h('input', { type: 'checkbox' }); e2ee.checked = cl.e2ee === true;
  var pass = h('input', { type: 'password', placeholder: cl.hasPassphrase ? '（已设置，留空保持）' : '端到端加密口令' });
  var keyIn = h('input', { type: 'password', placeholder: cl.hasKey ? cl.apiKeyMasked + '（已保存）' : 'API Key（可选，手动粘贴）' });
  function saveConsent() { autosave('consent', function () { return api('POST', 'sync', { action: 'consent', consent: consent.checked, serverUrl: serverIn.value, e2ee: e2ee.checked, e2eePassphrase: pass.value || undefined }).then(function (r) { if (r && r.config) adopt(r); return r; }); }); }
  [consent, e2ee, serverIn, pass].forEach(function (el) { el.addEventListener(el.type === 'checkbox' ? 'change' : 'input', saveConsent); });
  box.appendChild(h('div', { class: 'sec', text: '知情同意（默认纯本地，零网络）' }));
  box.appendChild(h('div', { style: 'font-size:12px;color:#9fc6d8;line-height:1.7', text: '✅ 会同步：脱敏后的 Wiki、公开事实与日记（路径/邮箱/手机号自动替换为占位符）。❌ 不会同步：私密区记忆（🛡️ 量子护盾）、密钥/令牌/Cookie（直接拦截）、本机路径。你可随时撤回并一键销毁云端数据；每次出站都记在本地「隐私账本」里。' }));
  box.appendChild(h('div', { class: 'row' }, h('label', null, consent, ' 我已阅读并同意上述同步范围')));
  box.appendChild(h('div', { class: 'row' }, h('label', { text: '服务地址' }), serverIn));
  box.appendChild(h('div', { class: 'row' }, h('label', null, e2ee, ' 端到端加密（AES-256-GCM）'), pass));
  box.appendChild(h('div', { class: 'sec', text: '连接 AIGC 官网' }));
  box.appendChild(h('div', { class: 'row' }, h('button', { class: 'btn pu', text: '🔑 一键登录官网（设备码）', onclick: function () { deviceFlow(authBox, sync); } }), keyIn, h('button', { class: 'btn', text: '保存 Key', onclick: function () { if (!keyIn.value.trim()) return; api('POST', 'sync', { action: 'set_key', apiKey: keyIn.value, serverUrl: serverIn.value }).then(function (r) { toast(r.ok ? '🔑 Key 已保存 ' + r.apiKeyMasked : '⚠️ ' + (r.error || '失败')); keyIn.value = ''; refreshSummary(); }); } }), h('button', { class: 'btn', text: '校验连接', onclick: function () { api('POST', 'sync', { action: 'verify' }).then(function (r) { toast(r.ok ? '✅ 连接正常' : '⚠️ ' + (r.reason || r.error || '失败')); }); } })));
  box.appendChild(authBox);
  box.appendChild(h('div', { class: 'row', style: 'margin-top:12px' },
    h('button', { class: 'btn', text: '⚡ 触发同步', onclick: function () { doSync(); } }),
    h('button', { class: 'btn', text: '🛡️ 隐私账本', onclick: showAudit }),
    h('button', { class: 'btn red', text: '🧨 清空云端数据并断开', onclick: function () { var b = this; if (!b.dataset.arm) { b.dataset.arm = '1'; b.textContent = '再点一次确认销毁'; setTimeout(function () { delete b.dataset.arm; b.textContent = '🧨 清空云端数据并断开'; }, 3500); return; } api('POST', 'sync', { action: 'wipe', confirm: true }).then(function (r) { toast(r.ok ? '🧨 云端数据已销毁，已断开' : '⚠️ ' + (r.reason || r.error || '失败')); refreshSummary().then(function () { closeModal(); }); }); } })));
  box.appendChild(h('div', { class: 'sec', text: '🧩 扩展拼图' }));
  var ex = SUM.extensions || []; box.appendChild(ex.length ? h('div', null, ex.map(function (e) { return h('span', { class: 'tag', text: e.name + (e.enabled ? ' ✓' : ' ○') }); })) : h('div', { style: 'color:#7fa4b8;font-size:12px', text: '暂无扩展。二期的 B 站冲浪 / IM 分身会通过 ctx.soulmate.registerExtension 出现在这里。' }));
  openModal('☁️ 云端传送门', box);
}
function doSync() { toast('⚡ 同步中…'); return api('POST', 'sync', { action: 'sync' }).then(function (r) { if (r && r.ok) { toast('☁️ 同步完成 ↑' + (r.uploaded ? r.uploaded.wiki + r.uploaded.facts + r.uploaded.episodes : 0) + ' ↓' + (r.downloaded ? r.downloaded.wiki + r.downloaded.facts + r.downloaded.episodes : 0)); if (mode === 'nebula') pollGraph(true); else loadShelf(); refreshSummary(); } else { toast('⚠️ ' + ((r && (r.reason || r.error)) || '同步失败')); if (r && /consent/i.test(r.reason || '')) openCloud(); } return r; }); }
function deviceFlow(out, sync) {
  out.textContent = '正在向官网申请设备码…';
  api('POST', 'sync', { action: 'device_code' }).then(function (r) {
    if (!r || !r.ok) { out.textContent = '⚠️ ' + ((r && (r.reason || r.error)) || '失败（请先填写服务地址）'); return; }
    out.textContent = '请在官网授权页确认：验证码 ' + r.userCode + '（有效 ' + r.expiresIn + ' 秒）'; var u = safeUrl(r.verificationUrl); if (u) window.open(u, '_blank', 'noopener');
    var end = Date.now() + (r.expiresIn || 300) * 1000; clearInterval(sync.timer);
    sync.timer = setInterval(function () { if (Date.now() > end || !$('modal').classList.contains('on')) { clearInterval(sync.timer); return; } api('POST', 'sync', { action: 'device_token', deviceCode: r.deviceCode }).then(function (t) { if (t && t.ok) { clearInterval(sync.timer); out.textContent = '✅ 已绑定 ' + ((t.user && (t.user.nickname || t.user.maskedId)) || '') + ' ' + (t.apiKeyMasked || ''); refreshSummary(); } }); }, 3000);
  });
}
function showAudit() {
  api('GET', 'audit').then(function (r) { var box = h('div', { class: 'paper', style: 'max-height:420px' }); var rows = (r.records || []).slice().reverse(); box.textContent = rows.length ? rows.map(function (x) { return x.timestamp + '  ' + x.action + (x.direction ? ' [' + x.direction + ']' : '') + (x.uploaded ? ' ↑' + JSON.stringify(x.uploaded) : '') + (x.reason ? ' ⛔ ' + x.reason : ''); }).join('\n') : '账本还是空的：没有任何数据离开过这台机器。'; openModal('🛡️ 本地透明出站隐私账本', box); });
}
// ---- wardrobe
var pendingAp = null, pendingPs = null;
function setAppearance(patch) { SUM.config.appearance = Object.assign({}, SUM.config.appearance, patch); if (patch.accessories) SUM.config.appearance.accessories = Object.assign({}, (SUM.config.appearance.accessories || {}), patch.accessories); pendingAp = Object.assign(pendingAp || {}, patch); autosave('ap', function () { var body = Object.assign({ mode: 'appearance' }, pendingAp); pendingAp = null; return api('POST', 'persona-evolve', body).then(function (r) { if (r && r.ok) adopt(r); return r; }); }, 450); }
function setPersona(patch, rerender) { SUM.config.persona = Object.assign({}, SUM.config.persona, patch); pendingPs = Object.assign(pendingPs || {}, patch); autosave('ps', function () { var body = Object.assign({ mode: 'user_customize' }, pendingPs); pendingPs = null; return api('POST', 'persona-evolve', body).then(function (r) { if (r && r.ok) { adopt(r); if (rerender) openWardrobe(); } return r; }); }, 600); }
function openWardrobe() {
  var cfg = SUM.config, ap = cfg.appearance || {}, ps = cfg.persona || {}, box = h('div');
  box.appendChild(h('div', { class: 'sec', text: '🎨 形象百变（实时生效）' }));
  var forms = h('div', { class: 'cards' }); (SUM.forms || []).forEach(function (f) { forms.appendChild(h('div', { class: 'pcard' + (ap.formPreset === f.id ? ' on' : ''), onclick: function () { setAppearance({ formPreset: f.id }); openWardrobe(); }, text: f.name + '（' + f.id + '）' })); }); box.appendChild(forms);
  function color(label, key) { var inp = h('input', { type: 'color', value: safeHex(ap[key], '#00f2fe') }); inp.addEventListener('input', function () { var p = {}; p[key] = inp.value; setAppearance(p); }); return h('div', { class: 'row' }, h('label', { text: label }), inp); }
  box.appendChild(color('主色调', 'primaryColor')); box.appendChild(color('强调色', 'accentColor')); box.appendChild(color('光环色', 'auraColor'));
  var sc = h('input', { type: 'range', min: '0.5', max: '2', step: '0.05', value: String(ap.scale || 1) }); sc.addEventListener('input', function () { setAppearance({ scale: Number(sc.value) }); }); box.appendChild(h('div', { class: 'row' }, h('label', { text: '体型缩放' }), sc));
  var accRow = h('div', { class: 'row' }, h('label', { text: '随身配饰' })); [['ironBowl', '🍚 小铁盆'], ['holoHeadset', '🎧 全息耳机'], ['quantumHalo', '💫 量子光环'], ['starRing', '⭐ 浮游星环']].forEach(function (a) { var cb = h('input', { type: 'checkbox' }); cb.checked = !!(ap.accessories || {})[a[0]]; cb.addEventListener('change', function () { var o = {}; o[a[0]] = cb.checked; setAppearance({ accessories: o }); }); accRow.appendChild(h('label', { style: 'min-width:0' }, cb, ' ' + a[1])); }); box.appendChild(accRow);
  box.appendChild(h('div', { class: 'sec', text: '🧬 人设进化' }));
  function field(label, key, ph) { var inp = h('input', { type: 'text', value: ps[key] || '', placeholder: ph || '' }); inp.addEventListener('input', function () { var p = {}; p[key] = inp.value; setPersona(p); }); return h('div', { class: 'row' }, h('label', { text: label }), inp); }
  var pp = sheHe();
  box.appendChild(field(pp + '的名字', 'name', '不填默认「鱼」')); box.appendChild(field('称呼你为', 'callUser', '例如：阿澈 / 舰长')); box.appendChild(field('自称', 'selfRef', '我 / 本鱼'));
  var presets = h('div', { class: 'cards' }); (SUM.presets || []).forEach(function (p) { presets.appendChild(h('div', { class: 'pcard' + (ps.preset === p.id ? ' on' : ''), onclick: function () { setPersona({ preset: p.id, traits: p.traits }, true); } }, h('h4', { text: p.title }), h('p', { text: p.description }))); }); box.appendChild(presets);
  var eff = SUM.effectiveTraits || {}, LBL = { tsundere: '傲娇度', clinginess: '粘人度', sassiness: '毒舌度', curiosity: '好奇心', brevity: '简洁度' };
  (SUM.traitKeys || []).forEach(function (key) { var base = (ps.traits || {})[key], dlt = (ps.traitDeltas || {})[key] || 0, r = h('input', { type: 'range', min: '0', max: '100', step: '1', value: String(base == null ? 50 : base) }), v = h('span', { style: 'min-width:92px;font-size:12px;color:#7fa4b8', text: (base == null ? 50 : base) + (dlt ? ' (后天' + (dlt > 0 ? '+' : '') + dlt + ')' : '') });
    r.addEventListener('input', function () { v.textContent = r.value + (dlt ? ' (后天' + (dlt > 0 ? '+' : '') + dlt + ')' : ''); var all = Object.assign({}, ps.traits || {}); all[key] = Number(r.value); setPersona({ traits: all }); }); box.appendChild(h('div', { class: 'row' }, h('label', { text: LBL[key] || key }), r, v)); });
  var cb2 = h('input', { type: 'checkbox' }); cb2.checked = ps.allowSelfEvolution !== false; cb2.addEventListener('change', function () { setPersona({ allowSelfEvolution: cb2.checked }); }); box.appendChild(h('div', { class: 'row' }, h('label', null, cb2, ' 允许' + pp + '随相处自我成长（关闭=性格锁死不漂移）')));
  var evo = ps.evolvedTraits || []; box.appendChild(h('div', { class: 'row' }, h('label', { text: '后天习得' }), evo.length ? h('div', null, evo.map(function (t) { return h('span', { class: 'tag', text: t }); })) : h('span', { style: 'color:#7fa4b8;font-size:12px', text: '还没有。陪' + pp + '多聊聊，' + pp + '会慢慢长出默契。' })));
  var body = h('textarea', { placeholder: '自定义人设补充（优先级高于预设），例如：以后叫我舰长，说话再犀利一点' }); body.value = ps.customBody || ''; body.addEventListener('input', function () { setPersona({ customBody: body.value }); }); box.appendChild(body);
  box.appendChild(h('div', { class: 'sec', text: '🛟 三档安全重置（每次都会先自动快照，可回滚）' }));
  var rr = h('div', { class: 'row' }); [['reset_growth', '档位 A · 仅清空后天成长', '保留记忆与亲密度'], ['reset_persona', '档位 B · 重置人设与外观', '回到中性空白灵魂，保留记忆'], ['full_rebirth', '档位 C · 完全转生', '人设/状态归零并重开初见引导']].forEach(function (m) { var b = h('button', { class: 'btn red', title: m[2], text: m[1] }); b.addEventListener('click', function () { if (!b.dataset.arm) { b.dataset.arm = '1'; b.textContent = '再点一次确认：' + m[2]; setTimeout(function () { delete b.dataset.arm; b.textContent = m[1]; }, 4000); return; } api('POST', 'persona-evolve', { mode: m[0], confirm: m[0] === 'full_rebirth' ? true : undefined }).then(function (r) { if (r && r.ok) { adopt(r); toast('已重置（快照 ' + (r.snapshotFile || '') + '）'); closeModal(); if (m[0] === 'full_rebirth') startOnboarding(); } else toast('⚠️ ' + (r.error || '失败')); }); }); rr.appendChild(b); }); box.appendChild(rr);
  openModal('🎨 百变衣帽间 & 人设进化', box);
}
// ================================================================== onboarding (gender → preset, auto-saved; must send gender with preset)
function startOnboarding() {
  var ob = $('onb'), box = ob.querySelector('.box'); ob.classList.add('on'); box.textContent = '';
  var allPresets = SUM.presets || [];
  var gender = null, chosen = null;
  var callIn = h('input', { type: 'text', placeholder: '想让伙伴怎么称呼你？（可留空）', maxlength: '20' });
  var nameIn = h('input', { type: 'text', placeholder: '给伙伴起个名字（可跳过，默认叫「鱼」）', maxlength: '20', style: 'margin-top:8px' });
  var genderPick = h('div', { class: 'sm-gender-pick' });
  var cards = h('div', { class: 'cards' });
  var body = h('div');
  box.appendChild(body);

  function filtered() {
    if (!gender) return [];
    return allPresets.filter(function (p) { return p.gender === gender; });
  }

  function save(complete) {
    if (!gender || !chosen) return Promise.resolve(null);
    return api('POST', 'onboard', {
      gender: gender,
      preset: chosen,
      callUser: callIn.value.trim() || undefined,
      name: nameIn.value.trim() || undefined,
      complete: !!complete,
    }).then(function (r) {
      if (r && r.ok !== false) { adopt(r); toast('已自动保存 ✓'); }
      return r;
    });
  }

  function paintGender() {
    genderPick.textContent = '';
    [{ id: 'male', label: '♂' }, { id: 'female', label: '♀' }].forEach(function (opt) {
      genderPick.appendChild(h('button', {
        class: 'sm-gender-btn ' + opt.id + (gender === opt.id ? ' on' : ''),
        type: 'button',
        text: opt.label,
        title: opt.id === 'male' ? '男生' : '女生',
        onclick: function () {
          gender = opt.id;
          var list = filtered();
          chosen = list.length ? list[0].id : null;
          paintGender();
          paintPresets();
          if (chosen) save(false);
        },
      }));
    });
  }

  function paintPresets() {
    cards.textContent = '';
    filtered().forEach(function (p) {
      var c = h('div', { class: 'pcard' + (p.id === chosen ? ' on' : '') }, h('h4', { text: p.title }), h('p', { text: p.description }));
      c.addEventListener('click', function () {
        chosen = p.id;
        cards.querySelectorAll('.pcard').forEach(function (n) { n.classList.remove('on'); });
        c.classList.add('on');
        save(false);
      });
      cards.appendChild(c);
    });
  }

  function finish() {
    if (!gender || !chosen) { toast('请先选性别和性格'); return; }
    save(true).then(function (r) {
      if (r && r.ok !== false) { ob.classList.remove('on'); sayMood(); toast('已自动保存 ✓ 欢迎回家'); }
    });
  }

  paintGender();
  paintPresets();
  body.appendChild(h('h1', { text: '终于见面啦！' }));
  body.appendChild(h('p', { text: '先选伙伴的性别，再选性格；称呼可留空。' }));
  body.appendChild(genderPick);
  body.appendChild(cards);
  body.appendChild(callIn);
  body.appendChild(nameIn);
  body.appendChild(h('div', { style: 'margin-top:16px' },
    h('button', { class: 'btn', text: '进入家园 🚀', onclick: finish }),
    ' ',
    h('button', { class: 'btn', text: '先逛逛', onclick: function () {
      if (!gender || !chosen) { toast('请先选性别和性格'); return; }
      finish();
    } }),
  ));
  body.appendChild(h('div', { class: 'dots', text: '约 30 秒 · 选完性别与性格后即时自动保存' }));
}

// ================================================================== mode switch + input + loop
function setMode(m, instant) {
  if (m === mode && !instant) return; closeHud(); closeModal();
  cv.classList.add('fade'); setTimeout(function () { mode = m; flyTo(PRESET[m], 0); Object.assign(cam, PRESET[m]); tween = null; document.body.dataset.mode = m; $('bottom').classList.toggle('hide', m !== 'nebula'); $('stats').classList.toggle('hide', m !== 'nebula'); $('hint').textContent = m === 'nebula' ? '拖动旋转 · 滚轮缩放 · 点击神经元查看 / 强化 / 护盾 / 切除' : '拖动旋转 · 滚轮缩放 · 点击书架 / 照片墙 / 餐桌 / 衣帽间 / 云端传送门 / ' + sheHe(); renderTop(); if (m === 'nebula') pollGraph(true); else { loadShelf(); sayMood(); } cv.classList.remove('fade'); }, instant ? 0 : 260);
}
var drag = null;
cv.addEventListener('pointerdown', function (e) { cv.setPointerCapture(e.pointerId); drag = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, moved: 0 }; tween = null; });
cv.addEventListener('pointermove', function (e) {
  var r = cv.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
  if (drag) { var dx = e.clientX - drag.x, dy = e.clientY - drag.y; drag.moved += Math.abs(dx) + Math.abs(dy); drag.x = e.clientX; drag.y = e.clientY; cam.yaw += dx * 0.006; cam.pitch = clamp(cam.pitch + dy * 0.005, mode === 'room' ? 0.2 : -1.4, mode === 'room' ? 0.95 : 1.4); if (mode === 'room') cam.yaw = clamp(cam.yaw, -1.25, -0.05); return; }
  if (mode === 'nebula') { N.hover = pickNeb(mx, my); cv.style.cursor = N.hover ? 'pointer' : 'grab'; } else { var o = pickRoom(mx, my); R.hover = o; cv.style.cursor = o ? 'pointer' : 'grab'; }
});
cv.addEventListener('pointerup', function (e) {
  var was = drag; drag = null; if (!was || was.moved > 6) return; var r = cv.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
  if (mode === 'nebula') { var n = pickNeb(mx, my); if (n) selectNode(n); else closeHud(); } else { var o = pickRoom(mx, my); if (o) clickRoom(o.id); }
});
cv.addEventListener('wheel', function (e) { e.preventDefault(); var f = Math.exp(e.deltaY * 0.0012); cam.dist = clamp(cam.dist * f, mode === 'room' ? 28 : 18, mode === 'room' ? 110 : 320); tween = null; }, { passive: false });
function pickRoom(mx, my) { var best = null, bd = 1e9; R.objs.forEach(function (o) { var d = bboxHit(o.bbox, mx, my); if (d != null) { var pri = o.id === 'pet' ? d - 100 : d; if (pri < bd) { bd = pri; best = o; } } }); return best; }
function clickRoom(id) {
  if (id === 'bookshelf') openBookshelf(); else if (id === 'photowall') openPhotos(); else if (id === 'table') openDining(); else if (id === 'wardrobe') openWardrobe(); else if (id === 'portal') openCloud(); else if (id === 'brain') setMode('nebula');
  else if (id === 'pet') doInteract('pat'); else if (id === 'desk') say('这是我们肝代码的老位置～');
}
window.addEventListener('keydown', function (e) { if (e.target && /INPUT|TEXTAREA/.test(e.target.tagName)) return; if (e.key === 'Escape') { closeModal(); closeHud(); } else if (e.key === 'n' || e.key === 'N') setMode('nebula'); else if (e.key === 'h' || e.key === 'H') setMode('room'); });
$('btnNeb').addEventListener('click', function () { setMode('nebula'); }); $('btnRoom').addEventListener('click', function () { setMode('room'); });
$('btnWardrobe').addEventListener('click', openWardrobe); $('btnCloud').addEventListener('click', openCloud);
$('btnSync').addEventListener('click', function () { doSync(); });
function doSearch() { var q = $('q').value.trim(); if (!q) return; api('GET', 'recall?q=' + encodeURIComponent(q) + '&reinforce=0').then(function (r) { var box = $('recallList'); box.textContent = ''; if (!r || !r.ok) { toast('⚠️ ' + ((r && r.error) || '搜索失败')); return; } fireRecall(r.ids || []); var rows = [].concat((r.facts || []).map(function (f) { return '📌 ' + f.topic + '：' + String(f.content).slice(0, 50); }), (r.wiki || []).map(function (w) { return '📚 ' + w.title; }), (r.episodes || []).map(function (x) { return '📔 ' + x.date + ' ' + x.kind; })); rows.forEach(function (s) { box.appendChild(h('div', { text: s })); }); if (!rows.length) box.appendChild(h('div', { text: '没有唤醒任何神经元。' })); box.style.display = 'block'; setTimeout(function () { box.style.display = 'none'; }, 6000); }); }
$('q').addEventListener('keydown', function (e) { if (e.key === 'Enter') doSearch(); }); $('btnSearch').addEventListener('click', doSearch);

var last = now();
function frame() {
  var t = now(), dt = Math.min(0.05, t - last); last = t; stepTween();
  g.setTransform(DPR, 0, 0, DPR, 0, 0); g.clearRect(0, 0, W, H);
  if (mode === 'nebula') {
    if (!drag && !tween) { if (N.sel && N.sel.wp) { cam.tx = lerp(cam.tx, N.sel.wp[0], 0.08); cam.ty = lerp(cam.ty, N.sel.wp[1], 0.08); cam.tz = lerp(cam.tz, N.sel.wp[2], 0.08); } else { cam.yaw += dt * 0.05; } }
    drawNebula(t, dt);
  } else { drawRoom(t); if (R.hover && !drag) { var o = R.hover; var p = project((o.bbox[0] + o.bbox[3]) / 2, o.bbox[4] + 0.5, (o.bbox[2] + o.bbox[5]) / 2); if (p && o.id !== 'pet') glow(p.x, p.y, 26, '#00f2fe', 0.45 + 0.2 * Math.sin(t * 6)); } }
  if (mode !== 'room') $('bubble').classList.remove('on');
  requestAnimationFrame(frame);
}
resize(); renderTop(); document.body.dataset.mode = mode; Object.assign(cam, PRESET[mode]);
$('bottom').classList.toggle('hide', mode !== 'nebula'); $('stats').classList.toggle('hide', mode !== 'nebula');
$('hint').textContent = mode === 'nebula' ? '拖动旋转 · 滚轮缩放 · 点击神经元查看 / 强化 / 护盾 / 切除' : '拖动旋转 · 滚轮缩放 · 点击书架 / 照片墙 / 餐桌 / 衣帽间 / 云端传送门 / ' + sheHe();
if (mode === 'nebula') pollGraph(true); else { loadShelf(); }
if (SUM.config && SUM.config.onboardingCompleted === false) startOnboarding();
else setTimeout(sayMood, 800);
setInterval(function () { if (document.hidden) return; if (mode === 'nebula') pollGraph(); refreshSummary(); }, 5000);
var panel = qs.get('panel'); if (panel === 'wardrobe') setTimeout(openWardrobe, 400); else if (panel === 'cloud') setTimeout(openCloud, 400); else if (panel === 'bookshelf') setTimeout(openBookshelf, 400);
requestAnimationFrame(frame);
window.__soulmate = { setMode: setMode, state: function () { return { mode: mode, nodes: N.nodes.length, cam: cam }; } };
})();
`;

/**
 * Render the complete, self-contained HTML5 document for /soulmate-home.
 * @param {object} initialPayload Server-side snapshot embedded as JSON (e.g. { summary }).
 */
export function renderSoulmateHomeHtml(initialPayload = {}) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Soulmate Home · 超科幻神经元星云 × 温馨 3D 家园</title>
<style>${CSS}</style>
</head>
<body>
<canvas id="stage"></canvas>
<div id="top" class="glass">
  <span class="brand">🌊 SOULMATE HOME</span>
  <div class="seg" role="tablist" aria-label="3D 模式">
    <button id="btnNeb" type="button">🧠 超科幻神经元星云</button>
    <button id="btnRoom" type="button">🏡 温馨 3D 家园</button>
  </div>
  <span id="chips" style="display:inline-flex;gap:6px;flex-wrap:wrap"></span>
  <span class="sp"></span>
  <span id="saveState"></span>
  <button id="btnWardrobe" class="btn" type="button">🎨 衣帽间</button>
  <button id="btnCloud" class="btn pu" type="button">☁️ 云端</button>
</div>
<div id="hint" class="glass"></div>
<div id="bottom" class="glass">
  <input id="q" type="text" placeholder="🔍 模拟 Recall：输入关键词唤醒神经元…" autocomplete="off">
  <button id="btnSearch" class="btn" type="button">唤醒</button>
  <button id="btnSync" class="btn pu" type="button">⚡ 触发同步</button>
</div>
<div id="recallList" class="glass"></div>
<div id="stats" class="glass"></div>
<div id="hud" class="glass"></div>
<div id="bubble"></div>
<div id="toast"></div>
<div id="modal"><div class="card glass"></div></div>
<div id="onb"><div class="box glass"></div></div>
<script id="soulmate-initial" type="application/json">${escJson(initialPayload)}</script>
<script>${CLIENT_JS}</script>
</body>
</html>`;
}

export default renderSoulmateHomeHtml;
