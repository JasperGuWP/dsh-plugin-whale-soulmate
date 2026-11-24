// README showcase harness: mounts the REAL browser panel (browser/ modules, React 18
// UMD from CDN) against a synthetic demo API, so docs screenshots/GIFs show the actual
// shipped UI without a DSH host or any real user data. All ids below are fictional.
//
//   node server-mock/panel-showcase-harness.mjs   → http://127.0.0.1:4399/?tab=dsbot
//
// Query `tab` presets the panel tab via the same sessionStorage key the plugin uses.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { collectModules, moduleTableSource } from '../browser/build.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = 4399;

const now = Date.now();
const iso = (msAgo) => new Date(now - msAgo).toISOString();

// Fictional openids (32 hex) — never real user data in a public showcase.
const OWNER = 'A1B2C3D4E5F60718293A4B5C6D7E8F90';
const GROUP = 'F0E1D2C3B4A5968778695A4B3C2D1E0F';
const MEMBER = '0F1E2D3C4B5A69788796A5B4C3D2E1F0';

const config = {
  persona: {
    name: '大肥鱼', callUser: '主人', selfRef: '本鱼', preset: 'guard-whale',
    gender: 'female', city: '上海', traitScheme: 'five',
    traits: { tsundere: 78, clinginess: 72, sassiness: 66, curiosity: 70, brevity: 60 },
    allowSelfEvolution: true,
  },
  appearance: { formPreset: 'whale-girl', scale: 1 },
  proactive: { intentEnabled: true, intentLlmDailyCap: 24, intentMaxActsPerDay: 3, quietHours: ['00:00-07:00'], tzOffsetMinutes: 480 },
  extensions: {
    imProactiveEnabled: true,
    imProactivePerConvDaily: 20, imProactiveDailyTotal: 40, imProactiveMinGapMinutes: 5,
    imOwnerQq: OWNER,
    imProactiveWhitelist: [
      { platform: 'qq', to: OWNER, groupId: '', label: 'QQ私聊 · 等风' },
      { platform: 'qq', to: '', groupId: GROUP, label: 'QQ群 · 深海夜航' },
    ],
    qqbotBridge: true, weatherEnabled: true,
  },
  notify: { enabled: true },
  pet: { skin: 'hanfu' },
};

const state = {
  ok: true,
  displayName: '大肥鱼',
  config,
  state: { mood: 'happy', energy: 82, affection: 68, interactionCount: 412 },
  interactionCount: 412,
};

const groupThread = [
  { at: iso(9 * 60000), role: 'user', peerLabel: '主人', text: '在吗' },
  { at: iso(8.6 * 60000), role: 'bot', peerLabel: '', text: '在。我怀疑你在测我掉没掉线——测吧，稳着，一时半会儿死不了。' },
  { at: iso(6 * 60000), role: 'user', peerLabel: '星野', text: '今晚有人一起排位吗' },
  { at: iso(5.4 * 60000), role: 'bot', peerLabel: '', text: '主人今晚要盯盘，你们别吵他。想开黑先过我这道关。' },
  { at: iso(2 * 60000), role: 'bot', peerLabel: '', text: '刚把那个乱带节奏的怼回去了。别以为群里人多我就护不住你，谁敢阴阳怪气，直接报我名。' },
];

const imChat = {
  ok: true,
  contacts: [
    { peerId: GROUP, peerLabel: 'QQ群 · 深海夜航', groupId: GROUP, lastAt: iso(2 * 60000), lastText: '刚把那个乱带节奏的怼回去了…' },
    { peerId: OWNER, peerLabel: 'QQ私聊 · 等风', groupId: '', lastAt: iso(40 * 60000), lastText: '晚安，别熬太晚。' },
  ],
  messages: groupThread.map((r) => ({ ...r, platform: 'qq', peerId: GROUP, groupId: GROUP })),
};

const routes = {
  state,
  engine: { ok: true, engine: { preset: 'guard-whale', drift: 0.12 } },
  'pet/skins': { ok: true, skins: [] },
  'proactive/status': { ok: true, enabled: true, intentEnabled: true, nextAt: iso(-12 * 60000), todayActs: 2 },
  'im/status': {
    ok: true,
    note: '官方 QQ Bot 是独立通道：内置 IM 全关 ≠ QQ 不能说话。',
    platforms: { weixin: { enabled: false, configured: false }, qq: { enabled: false } },
    officialQqBot: { bound: true, appId: '1900000001' },
    imProactive: { enabled: true, whitelist: config.extensions.imProactiveWhitelist },
  },
  'im/chat': imChat,
  'im/known': {
    ok: true,
    conversations: [
      { platform: 'qq', to: OWNER, groupId: '', label: 'QQ私聊 · 等风', nickname: '等风' },
      { platform: 'qq', to: '', groupId: GROUP, label: 'QQ群 · 深海夜航', nickname: '' },
    ],
    speakers: [
      { id: OWNER, name: '等风' },
      { id: MEMBER, name: '星野' },
    ],
  },
  'qqbot/sync': { ok: true, imported: 5, conversations: 2 },
  usage: { ok: true, days: [], today: { total: 18, byKind: { chat: 9, 'intent-llm': 4, 'im-proactive': 3, 'engage-llm': 2 } }, cap: { daily: 60 } },
  experience: { ok: true, notes: [{ kind: 'im-group', period: 'night', lesson: '夜里群里主人回得短，主动话头收着点', samples: 4, at: iso(86400000) }] },
  growth: {
    ok: true,
    weeks: [
      { week: '2026-W45', at: iso(14 * 86400000), traits: { clinginess: 50, sassiness: 60, curiosity: 55, brevity: 50, tsundere: 40 }, nodes: 40, wikiStars: 2, facts: 30 },
      { week: '2026-W46', at: iso(7 * 86400000), traits: { clinginess: 54, sassiness: 60, curiosity: 58, brevity: 50, tsundere: 40 }, nodes: 62, wikiStars: 3, facts: 48 },
      { week: '2026-W47', at: iso(86400000), traits: { clinginess: 54, sassiness: 63, curiosity: 58, brevity: 50, tsundere: 36 }, nodes: 78, wikiStars: 3, facts: 60 },
    ],
  },
  'surf-log': { ok: true, rows: [], entries: [] },
  'intent/log': { ok: true, rows: [] },
  mem: { ok: true, nodes: [], facts: [], wiki: [] },
};

const { sources, deps } = await collectModules('./entry.mjs');
const table = moduleTableSource('./entry.mjs', sources, deps, 'showcase');

const HTML = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<title>soulmate panel showcase</title>
<script crossorigin src="https://unpkg.com/react@18.3.1/umd/react.production.min.js"></script>
<script crossorigin src="https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js"></script>
<style>html,body{margin:0;background:#f4f7fd;font-family:system-ui,"Microsoft YaHei",sans-serif}
#root{max-width:1120px;margin:0 auto;padding:16px}</style></head><body>
<div id="root"></div>
<script>
(function () {
  var tab = new URLSearchParams(location.search).get('tab') || 'dsbot';
  try { sessionStorage.setItem('soulmate.pendingTab', tab); } catch (e) {}
  var hostRequire = function (id) {
    if (id === 'react') return window.React;
    if (id === 'react-dom') return window.ReactDOM;
    throw new Error('no host module ' + id);
  };
${table}
  var panel = __makeRequire('')('./panel.mjs');
  var styles = __makeRequire('')('./styles.mjs');
  styles.injectStyles();
  var root = ReactDOM.createRoot(document.getElementById('root'));
  root.render(React.createElement(panel.SoulmatePanelPage, {}));
  window.__showcaseReady = true;
})();
</script></body></html>`;

const server = createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const json = (obj) => { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
  try {
    if (u.pathname === '/' || u.pathname === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(HTML);
    }
    if (u.pathname.startsWith('/dsh-soulmate/api/')) {
      const key = u.pathname.slice('/dsh-soulmate/api/'.length);
      if (key === 'im/chat') {
        // Group thread vs DM thread by peer param, like the real route.
        const peer = u.searchParams.get('peer') || '';
        if (peer && peer !== GROUP) {
          return json({ ok: true, contacts: imChat.contacts, messages: [
            { at: iso(42 * 60000), role: 'user', peerLabel: '主人', text: '今天好累' },
            { at: iso(41 * 60000), role: 'bot', peerLabel: '', text: '累就靠过来。今天的破事我替你记着，明天再算账。' },
            { at: iso(40 * 60000), role: 'bot', peerLabel: '', text: '晚安，别熬太晚。' },
          ] });
        }
        return json(imChat);
      }
      if (key === 'config') return json({ ok: true });
      if (routes[key]) return json(routes[key]);
      return json({ ok: true });
    }
    if (u.pathname.startsWith('/qqbot/im-qqbot/')) {
      const key = u.pathname.slice('/qqbot/im-qqbot/'.length);
      if (key === 'bind') return json({ ok: true, phase: 'bound', appId: '1900000001' });
      if (key === 'config') return json({ ok: true, config: { requireMention: false, groupMode: 'allowlist' } });
      return json({ ok: true });
    }
    if (u.pathname === '/dsh-soulmate/api/sprite' || u.pathname === '/dsh-soulmate/api/sprite-male') {
      const buf = await readFile(join(ROOT, 'assets', u.pathname.endsWith('-male') ? '小鲸-male.jpg' : '小鲸.png'));
      res.writeHead(200, { 'content-type': 'image/png' });
      return res.end(buf);
    }
    res.writeHead(404); res.end('not found');
  } catch (err) {
    res.writeHead(500); res.end(String(err));
  }
});
server.listen(PORT, '127.0.0.1', () => console.log('panel showcase on http://127.0.0.1:' + PORT + '/?tab=dsbot'));