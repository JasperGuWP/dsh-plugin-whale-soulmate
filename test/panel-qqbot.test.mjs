import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

// QQ bot column: reuses the official @tencent-connect/dsh-qqbot bind routes.
// Minimal React shim mounts the component body (same pattern as panel-soul-share.test).

function makeReact(seed = {}) {
  const slots = [];
  let i = 0;
  return {
    createElement: (type, props, ...children) => {
      // Shallow-render nested function components so stubs mount like real children.
      if (typeof type === 'function') return type(props || {});
      return { type, props: props || {}, children: children.flat(Infinity).filter((c) => c != null && c !== false) };
    },
    useState: (init) => {
      const idx = i++;
      if (!(idx in slots)) slots[idx] = idx in seed ? seed[idx] : (typeof init === 'function' ? init() : init);
      return [slots[idx], (v) => { slots[idx] = typeof v === 'function' ? v(slots[idx]) : v; }];
    },
    useRef: (init) => ({ current: init }),
    useEffect: () => {},
    useCallback: (fn) => fn,
  };
}

const walk = (node, out = []) => {
  if (node == null || node === false) return out;
  if (typeof node === 'string') { out.push(node); return out; }
  if (typeof node !== 'object') return out;
  if (Array.isArray(node)) { node.forEach((n) => walk(n, out)); return out; }
  out.push(node);
  if (node.children) walk(node.children, out);
  return out;
};
const buttons = (tree) => walk(tree).filter((n) => n.type === 'button');
const texts = (tree) => walk(tree).filter((n) => typeof n === 'string');
const jsonResponse = (obj, status = 200) => ({ status, text: async () => JSON.stringify(obj) });

async function loadQqModule(seed = {}, fetchImpl = async () => jsonResponse({})) {
  const src = await readFile(new URL('../browser/panel-qqbot.mjs', import.meta.url), 'utf8');
  const react = makeReact(seed);
  const calls = [];
  const module = { exports: {} };
  vm.runInNewContext(src, {
    module,
    exports: module.exports,
    fetch: async (url, init) => { calls.push({ url, init }); return fetchImpl(url, init); },
    setInterval: () => 0,
    clearInterval: () => {},
    require: (id) => {
      if (id === 'react') return react;
      throw new Error('unexpected require ' + id);
    },
    console,
  }, { filename: 'panel-qqbot.mjs' });
  return { mod: module.exports, calls };
}

async function loadDsBotCard(seed = {}) {
  const src = await readFile(new URL('../browser/panel-dsbot.mjs', import.meta.url), 'utf8');
  const react = makeReact(seed);
  const module = { exports: {} };
  vm.runInNewContext(src, {
    module,
    exports: module.exports,
    setInterval: () => 0,
    clearInterval: () => {},
    require: (id) => {
      if (id === 'react') return react;
      if (id === './util.mjs') return { api: async () => ({ ok: true, platforms: {} }) };
      if (id === './panel-qqbot.mjs') return { QqBotColumn: () => ({ type: 'qqbot-stub', props: {}, children: [] }) };
      if (id === './panel-engage-quota.mjs') return { biliQuotaSection: () => null, ImProactiveSection: () => null };
      throw new Error('unexpected require ' + id);
    },
    console,
  }, { filename: 'panel-dsbot.mjs' });
  return module.exports.DsBotCard;
}

test('qqbot phaseLabel covers every official bind wire phase', async () => {
  const { mod } = await loadQqModule();
  assert.equal(mod.phaseLabel(null), '加载中…');
  assert.equal(mod.phaseLabel({ phase: 'starting' }), '正在生成二维码…');
  assert.equal(mod.phaseLabel({ phase: 'waiting' }), '请用手机 QQ 扫码授权');
  assert.equal(mod.phaseLabel({ phase: 'saving' }), '已扫码，正在保存凭据…');
  assert.equal(mod.phaseLabel({ phase: 'failed', reason: '二维码过期' }), '绑定失败：二维码过期');
  assert.equal(mod.phaseLabel({ phase: 'bound', appId: '1900000001' }), '已绑定 · AppID 1900000001');
});

test('qqbot configSummary echoes model routing and mention mode', async () => {
  const { mod } = await loadQqModule();
  assert.equal(
    mod.configSummary({ provider: 'qwen', model: 'deepseek', requireMention: true }),
    '模型 qwen / deepseek · 群聊需 @',
  );
  assert.equal(mod.configSummary({ requireMention: false }), '模型跟随 DSH 最近选择 · 群聊无需 @');
  assert.equal(mod.configSummary(null), '');
});

test('qqApi targets the official same-origin routes', async () => {
  const { mod, calls } = await loadQqModule({}, async () => jsonResponse({ phase: 'bound', appId: 'x' }));
  const state = await mod.qqApi('bind');
  assert.equal(state.phase, 'bound');
  assert.equal(calls[0].url, '/qqbot/im-qqbot/bind');
  assert.equal(calls[0].init.method, undefined);
  await mod.qqApi('bind/refresh', {});
  assert.equal(calls[1].url, '/qqbot/im-qqbot/bind/refresh');
  assert.equal(calls[1].init.method, 'POST');
});

test('qqApi degrades to ok:false on non-JSON responses', async () => {
  const { mod } = await loadQqModule({}, async () => ({ status: 404, text: async () => '<html>not found</html>' }));
  const res = await mod.qqApi('bind');
  assert.equal(res.ok, false);
  assert.ok(res.error.includes('非 JSON'));
});

test('QqBotColumn renders the official QR data URL while waiting', async () => {
  const qr = 'data:image/svg+xml;base64,PHN2Zz4=';
  const state = { phase: 'waiting', url: 'https://q.qq.com/x', qrSvg: qr, issuedAt: 1 };
  const { mod } = await loadQqModule({ 0: state }, async () => jsonResponse(state));
  const tree = mod.QqBotColumn();
  const imgs = walk(tree).filter((n) => n.type === 'img');
  assert.equal(imgs.length, 1);
  assert.equal(imgs[0].props.src, qr);
  const labels = buttons(tree).map((b) => b.children.join(''));
  assert.ok(labels.includes('刷新二维码'), 'waiting state offers QR refresh');
  assert.ok(!labels.includes('解绑'), 'no unbind before bound');
});

test('QqBotColumn bound state shows appId, disables QR and unbinds via POST', async () => {
  const { mod, calls } = await loadQqModule(
    { 0: { phase: 'bound', appId: '1900000001' } },
    async (url) => (url.endsWith('/unbind')
      ? jsonResponse({ ok: true, message: '已解绑' })
      : jsonResponse({ phase: 'starting' })),
  );
  const tree = mod.QqBotColumn();
  assert.ok(texts(tree).some((t) => String(t).includes('1900000001')), 'appId echoed');
  const unbindBtn = buttons(tree).find((b) => b.children.join('') === '解绑');
  assert.ok(unbindBtn, 'unbind button present when bound');
  const qrBtn = buttons(tree).find((b) => String(b.children.join('')).includes('二维码'));
  assert.equal(qrBtn.props.disabled, true, 'QR button disabled when bound');
  await unbindBtn.props.onClick();
  assert.ok(calls.some((c) => c.url === '/qqbot/im-qqbot/bind/unbind' && c.init.method === 'POST'));
});

test('DsBot gate offers QQ bot beside WeChat', async () => {
  const Card = await loadDsBotCard();
  const tree = Card();
  const labels = buttons(tree).map((b) => b.children.join(''));
  assert.ok(labels.includes('微信 Bot'), 'WeChat gate button');
  assert.ok(labels.includes('QQ 机器人'), 'QQ gate button beside WeChat');
});

test('DsBot shows one platform at a time: QQ open hides WeChat (exclusive view)', async () => {
  // useState slot 7 is openQq (right after openWx at slot 6).
  const Card = await loadDsBotCard({ 7: true });
  const tree = Card();
  const nodes = walk(tree);
  assert.ok(nodes.some((n) => n.type === 'qqbot-stub'), 'QQ column mounted');
  assert.ok(!nodes.some((n) => n.props && n.props['data-platform'] === 'weixin'), 'WeChat column hidden while QQ open');
  const labels = buttons(tree).map((b) => b.children.join(''));
  assert.ok(labels.includes('QQ 机器人'));
  assert.ok(labels.includes('微信 Bot'));
  assert.ok(!labels.some((l) => l.includes('收起') || l.includes('展开')), 'no toggle bar in exclusive view');
});
