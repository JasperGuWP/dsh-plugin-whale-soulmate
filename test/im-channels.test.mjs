import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, createPrivateKey, createPublicKey, verify as edVerify } from 'node:crypto';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../index.js';
import {
  clearImEventDedupe,
  clearImTokenCache,
  handleDingtalkWebhook,
  handleInboundImMessage,
  isSafeDingtalkWebhook,
  loadImCredentials,
  openDingtalkStreamTicket,
  parseOneBotEvent,
  pollWeixinQrStatus,
  pollWeixinUpdatesOnce,
  saveImCredentials,
  sendDingtalkMessage,
  sendFeishuMessage,
  sendQqMessage,
  sendWeixinMessage,
  startWeixinQrLogin,
} from '../packages/soulmate-im/index.mjs';
import { readPrivacyAudit } from '../packages/soulmate-core/privacy-firewall.mjs';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function createMockCtx(dir) {
  const registeredTools = new Map();
  const routes = new Map();
  const disposers = [];
  const mockCtx = {
    tools: {
      register(tool) {
        registeredTools.set(tool.name, tool);
        return () => registeredTools.delete(tool.name);
      },
    },
    systemPrompt: { section: () => () => {} },
    effect(fn) {
      const dispose = fn();
      if (typeof dispose === 'function') disposers.push(dispose);
    },
    provide() {},
    set(name, val) {
      mockCtx[name] = val;
    },
    get(name) {
      if (name === 'dshHomePath') return (...segs) => join(dir, ...segs);
      if (name === 'webServer') {
        return {
          registerRoute(method, path, handler) {
            routes.set(`${method} ${path}`, handler);
            return () => routes.delete(`${method} ${path}`);
          },
        };
      }
      return mockCtx[name];
    },
  };
  return {
    mockCtx,
    registeredTools,
    routes,
    dispose: () => {
      while (disposers.length) disposers.pop()();
    },
  };
}

/** Injectable fetch: handlers keyed by "METHOD origin+pathname" (query ignored); returns plain data or {__status, data}. */
function createMockNet(handlers) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const method = (init.method ?? 'GET').toUpperCase();
    const key = `${method} ${u.origin}${u.pathname}`;
    const call = {
      method,
      url: String(url),
      query: u.searchParams,
      key,
      headers: init.headers ?? {},
      body: init.body ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const handler = handlers[key];
    if (handler === undefined) return new Response(JSON.stringify({ error: `no mock for ${key}` }), { status: 404 });
    const out = typeof handler === 'function' ? handler(call, calls) : handler;
    const status = out?.__status ?? 200;
    return new Response(JSON.stringify(out?.__status ? out.data : out), { status });
  };
  return { fetchImpl, calls, to: (key) => calls.filter((c) => c.key === key) };
}

async function withIm(handlers, fn, pluginCfg = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'soulmate-im-'));
  clearImTokenCache();
  clearImEventDedupe();
  const net = createMockNet(handlers);
  const bundle = createMockCtx(dir);
  apply(bundle.mockCtx, { autoSync: false, imFetch: net.fetchImpl, ...pluginCfg });
  const service = bundle.mockCtx.soulmate;
  await service.ready;
  const call = (method, path, payload, headers) => {
    const route = bundle.routes.get(`${method} ${path}`);
    assert.ok(route, `route ${method} ${path} is registered`);
    return route({ method, url: path, ...(method === 'POST' ? { body: payload } : {}), ...(headers ? { headers } : {}) });
  };
  const ctx = {
    ...bundle,
    dir,
    net,
    service,
    home: service.home,
    opts: { fetchImpl: net.fetchImpl },
    GET: (path, headers) => call('GET', path, undefined, headers),
    /** Hit a route the way a host with path params would (req.params). */
    POSTP: (path, payload, params) => bundle.routes.get(`POST ${path}`)({ method: 'POST', url: path, body: payload, params }),
    POST: (path, payload, headers) => call('POST', path, payload, headers),
  };
  try {
    await fn(ctx);
  } finally {
    await service.ready.catch(() => {});
    bundle.dispose();
    await rm(dir, { recursive: true, force: true });
  }
}

const json = (out) => JSON.parse(out.body);
const allFiles = async (home) => [
  await readFile(home.configPath, 'utf8'),
  await readFile(home.credentialsPath, 'utf8'),
];
const readCreds = async (home) => JSON.parse(await readFile(home.credentialsPath, 'utf8'));
const enable = (ctx, platform, credentials, extra = {}) =>
  ctx.POST('/dsh-soulmate/api/im/config', { action: 'configure', platform, credentials, ...extra });
const imNodes = async (service, platform) => (await service.getNeuralGraph()).nodes.filter((n) => n.label.startsWith(`[im:${platform}]`));
const WX = 'https://ilinkai.weixin.qq.com';
const WX_EDGE = 'https://ilink-edge.weixin.qq.com';
const noSecretLeak = (blob, secrets) => {
  for (const s of secrets) assert.ok(!blob.includes(s), `secret "${s.slice(0, 8)}…" must not appear in output`);
};

// ---------------------------------------------------------------------------
// 1. WeChat (iLink)
// ---------------------------------------------------------------------------

test('weixin: QR login -> token only in credentials.json -> long-poll -> [im:weixin] neuron -> reply with context_token', async () => {
  const TOKEN = 'wxbot_TOPSECRET_token_0123456789';
  let statusPolls = 0;
  let updatePolls = 0;
  await withIm(
    {
      [`GET ${WX}/ilink/bot/get_bot_qrcode`]: { ret: 0, qrcode: 'QR123', qrcode_img_content: 'https://liteapp.weixin.qq.com/q/QR123' },
      [`GET ${WX}/ilink/bot/get_qrcode_status`]: () =>
        ++statusPolls < 2
          ? { status: 'wait' }
          : { status: 'confirmed', bot_token: TOKEN, ilink_bot_id: 'bot123@im.bot', ilink_user_id: 'owner456@im.wechat', baseurl: WX_EDGE },
      [`POST ${WX_EDGE}/ilink/bot/getupdates`]: (call) => {
        updatePolls += 1;
        if (updatePolls === 1) {
          assert.equal(call.body.get_updates_buf, '');
          return {
            ret: 0,
            get_updates_buf: 'BUF2',
            msgs: [
              { from_user_id: 'owner456@im.wechat', message_type: 1, context_token: 'ctx-1', item_list: [{ type: 1, text_item: { text: '今天想聊聊独立开发的事' } }] },
              { from_user_id: 'bot123@im.bot', message_type: 2, item_list: [{ type: 1, text_item: { text: '我自己发的，必须被忽略' } }] },
            ],
          };
        }
        assert.equal(call.body.get_updates_buf, 'BUF2', 'the saved sync buffer is sent back');
        return { ret: 0, get_updates_buf: 'BUF3', msgs: [] };
      },
      [`POST ${WX_EDGE}/ilink/bot/sendmessage`]: { ret: 0 },
    },
    async (ctx) => {
      const { service, home, opts, net } = ctx;
      await service.retainFact({ topic: '独立开发', content: '用户想成为独立开发者，喜欢小而美的产品' });

      // QR code request
      const qr = await startWeixinQrLogin(home, opts);
      assert.equal(qr.ok, true);
      assert.equal(qr.qrcode, 'QR123');
      assert.equal(qr.qrcodeImgContent, 'https://liteapp.weixin.qq.com/q/QR123');
      assert.equal(qr.pollIntervalSec, 1);
      assert.match(qr.qrDataUrl || '', /^data:image\/png;base64,/);
      const qrCall = net.calls[0];
      assert.equal(qrCall.query.get('bot_type'), '3');
      assert.equal(qrCall.headers['Content-Type'], 'application/json');
      assert.equal(qrCall.headers.AuthorizationType, 'ilink_bot_token');
      assert.match(Buffer.from(qrCall.headers['X-WECHAT-UIN'], 'base64').toString(), /^\d+$/);
      assert.equal(qrCall.headers.Authorization, undefined, 'no bearer before login');

      // QR status: wait -> confirmed
      assert.deepEqual(await pollWeixinQrStatus(home, 'QR123', opts), { ok: true, status: 'wait' });
      assert.equal(net.calls[1].query.get('qrcode'), 'QR123');
      assert.equal(net.calls[1].headers['iLink-App-ClientVersion'], '1');
      const confirmed = await pollWeixinQrStatus(home, 'QR123', opts);
      assert.equal(confirmed.ok, true);
      assert.equal(confirmed.status, 'confirmed');
      assert.equal(confirmed.accountId, 'bot123@im.bot');
      assert.equal(confirmed.userId, 'owner456@im.wechat');
      assert.match(confirmed.tokenMasked, /\*\*\*\*/);
      noSecretLeak(JSON.stringify(confirmed), [TOKEN]);

      // token stored ONLY in credentials.json (0600), platform enabled in config.json
      const creds = await readCreds(home);
      assert.equal(creds.im.weixin.token, TOKEN);
      assert.equal(creds.im.weixin.baseUrl, WX_EDGE);
      if (process.platform !== 'win32') assert.equal((await stat(home.credentialsPath)).mode & 0o777, 0o600);
      const config = JSON.parse(await readFile(home.configPath, 'utf8'));
      assert.equal(config.extensions.imPlatforms.weixin.enabled, true);
      noSecretLeak(JSON.stringify(config), [TOKEN]);

      // other QR end states pass straight through
      const expired = createMockNet({ [`GET ${WX}/ilink/bot/get_qrcode_status`]: { status: 'expired' } });
      assert.deepEqual(await pollWeixinQrStatus(home, 'Q', { fetchImpl: expired.fetchImpl }), { ok: true, status: 'expired' });

      // long-poll: one user message in, bot echo ignored
      const polled = await pollWeixinUpdatesOnce(service, opts);
      assert.equal(polled.ok, true, JSON.stringify(polled));
      assert.equal(polled.received, 1);
      assert.equal(polled.handled, 1);
      const handled = polled.results[0];
      assert.equal(handled.platform, 'weixin');
      assert.equal(handled.recalled.facts >= 1, true, 'memory recalled');
      assert.match(handled.reply, /独立开发/);
      assert.equal(handled.dispatched.ok, true, JSON.stringify(handled.dispatched));

      const updCall = net.to(`POST ${WX_EDGE}/ilink/bot/getupdates`)[0];
      assert.equal(updCall.headers.Authorization, `Bearer ${TOKEN}`);
      assert.deepEqual(updCall.body.base_info, { channel_version: 'dsh-soulmate' });

      // reply was sent with the context_token of that user
      const sent = net.to(`POST ${WX_EDGE}/ilink/bot/sendmessage`)[0];
      assert.equal(sent.headers.Authorization, `Bearer ${TOKEN}`);
      assert.equal(sent.body.msg.to_user_id, 'owner456@im.wechat');
      assert.equal(sent.body.msg.from_user_id, '');
      assert.equal(sent.body.msg.context_token, 'ctx-1');
      assert.equal(sent.body.msg.message_type, 2);
      assert.equal(sent.body.msg.message_state, 2);
      assert.match(sent.body.msg.client_id, /^[0-9a-f]{16,}$/);
      assert.deepEqual(sent.body.msg.item_list, [{ type: 1, text_item: { text: handled.reply } }]);

      // sync buffer + context token persisted; neuron grows in the 3D graph
      const after = (await readCreds(home)).im.weixin;
      assert.equal(after.syncBuf, 'BUF2');
      assert.equal(after.contextTokens['owner456@im.wechat'], 'ctx-1');
      const nodes = await imNodes(service, 'weixin');
      assert.equal(nodes.length, 1);
      assert.equal(nodes[0].kind, 'fact_neuron');
      assert.match(nodes[0].content, /想聊聊独立开发/);
      assert.ok(service.events(0).some((e) => e.type === 'retain' && e.ids.includes(nodes[0].id)), 'a shockwave event was queued');

      // the chat nudged the mood/affinity state machine
      assert.equal(handled.state.affinity > 20, true);

      // second poll sends the stored buffer and handles nothing
      const second = await pollWeixinUpdatesOnce(service, opts);
      assert.deepEqual([second.ok, second.received, second.handled], [true, 0, 0]);
      assert.equal((await readCreds(home)).im.weixin.syncBuf, 'BUF3');

      // proactive send: saved context token, then an explicit one
      assert.equal((await sendWeixinMessage(home, { toUserId: 'owner456@im.wechat', text: '晚安' }, opts)).ok, true);
      assert.equal((await sendWeixinMessage(home, { toUserId: 'owner456@im.wechat', text: '再见', contextToken: 'ctx-explicit' }, opts)).ok, true);
      const sends = net.to(`POST ${WX_EDGE}/ilink/bot/sendmessage`);
      assert.equal(sends[1].body.msg.context_token, 'ctx-1');
      assert.equal(sends[2].body.msg.context_token, 'ctx-explicit');

      // nothing the API hands out contains the token
      const status = ctx.GET('/dsh-soulmate/api/im/status');
      const statusBody = (await status).body;
      noSecretLeak(statusBody, [TOKEN]);
      assert.equal(JSON.parse(statusBody).platforms.weixin.configured, true);
    }
  );
});

test('weixin: expired session surfaces as an error and a non-confirmed QR never writes credentials', async () => {
  await withIm(
    { [`POST ${WX}/ilink/bot/getupdates`]: { ret: -14, errcode: -14, errmsg: 'session timeout' } },
    async ({ service, home, opts }) => {
      assert.equal((await pollWeixinUpdatesOnce(service, opts)).ok, false, 'not logged in');
      await saveImCredentials(home, 'weixin', { token: 'tok_abcdefghijkl' });
      const res = await pollWeixinUpdatesOnce(service, opts);
      assert.equal(res.ok, false);
      assert.equal(res.sessionExpired, true);
      const missing = await sendWeixinMessage(home, { text: 'hi' }, opts);
      assert.equal(missing.ok, false, 'no recipient and no context');
    }
  );
});

// ---------------------------------------------------------------------------
// 2. QQ
// ---------------------------------------------------------------------------

test('qq onebot: webhook -> recall + mood -> reply via /send_private_msg and /send_group_msg (mention-only groups, owner-only memories)', async () => {
  const OB = 'http://127.0.0.1:3000';
  const ACCESS = 'napcat-ACCESS-token-abc';
  await withIm(
    {
      [`POST ${OB}/send_private_msg`]: { status: 'ok', retcode: 0, data: { message_id: 1 } },
      [`POST ${OB}/send_group_msg`]: { status: 'ok', retcode: 0, data: { message_id: 2 } },
    },
    async (ctx) => {
      const { service, home, net, POST } = ctx;
      await service.retainFact({ topic: '咖啡偏好', content: '用户喜欢冰美式，不加糖' });
      const cfg = await enable(ctx, 'qq', { mode: 'onebot', onebotHttpUrl: OB, onebotAccessToken: ACCESS, ownerId: '10001' });
      assert.equal(cfg.status, 200);
      assert.equal(json(cfg).platforms.qq.mode, 'onebot');
      noSecretLeak(cfg.body, [ACCESS]);

      // private message from the owner
      const priv = await POST('/dsh-soulmate/api/im/webhook/qq', {
        post_type: 'message', message_type: 'private', self_id: 99999, user_id: 10001, message_id: 7,
        raw_message: '你还记得我的咖啡偏好吗', sender: { nickname: '阿澈' },
      }, { authorization: `Bearer ${ACCESS}` });
      assert.equal(priv.status, 200);
      const sentPrivate = net.to(`POST ${OB}/send_private_msg`);
      assert.equal(sentPrivate.length, 1);
      assert.equal(sentPrivate[0].headers.Authorization, `Bearer ${ACCESS}`);
      assert.equal(String(sentPrivate[0].body.user_id), '10001');
      assert.match(sentPrivate[0].body.message, /冰美式/, 'owner gets her recalled memory');
      assert.equal((await imNodes(service, 'qq')).length, 1);

      // group message with an @ mention -> group reply; strangers never get the owner's memories
      const grp = await POST('/dsh-soulmate/api/im/webhook/qq', {
        post_type: 'message', message_type: 'group', self_id: 99999, user_id: 20002, group_id: 555000, message_id: 8,
        raw_message: '[CQ:at,qq=99999] 说说咖啡偏好', sender: { card: '路人甲', nickname: 'x' },
      }, { authorization: `Bearer ${ACCESS}` });
      assert.equal(grp.status, 200);
      const sentGroup = net.to(`POST ${OB}/send_group_msg`);
      assert.equal(sentGroup.length, 1);
      assert.equal(String(sentGroup[0].body.group_id), '555000');
      assert.ok(!/冰美式/.test(sentGroup[0].body.message), 'a stranger must not see the owner\'s memory');
      assert.ok(!sentGroup[0].body.message.includes('[CQ:'), 'CQ codes are stripped from the text the brain sees');

      // group chatter without @ is ignored
      const quiet = await POST('/dsh-soulmate/api/im/webhook/qq', {
        post_type: 'message', message_type: 'group', self_id: 99999, user_id: 20002, group_id: 555000, raw_message: '大家好',
      }, { authorization: `Bearer ${ACCESS}` });
      assert.equal(quiet.status, 200);
      assert.equal(net.to(`POST ${OB}/send_group_msg`).length, 1);

      // wrong or missing access token is rejected; meta events are ignored
      const bad = await POST('/dsh-soulmate/api/im/webhook/qq', { post_type: 'message', message_type: 'private', user_id: 1, raw_message: 'x' }, { authorization: 'Bearer wrong' });
      assert.equal(bad.status, 403);
      const noAuth = await POST('/dsh-soulmate/api/im/webhook/qq', { post_type: 'message', message_type: 'private', user_id: 1, raw_message: 'x' });
      assert.equal(noAuth.status, 403, 'a configured access token must not be bypassed by omitting the header');
      assert.equal((await POST('/dsh-soulmate/api/im/webhook/qq', { post_type: 'meta_event' }, { authorization: `Bearer ${ACCESS}` })).status, 200);

      // direct sender (and OneBot-level failure)
      assert.equal((await sendQqMessage(home, { userId: '10001', text: 'hi' }, ctx.opts)).ok, true);
      const failing = createMockNet({ [`POST ${OB}/send_private_msg`]: { status: 'failed', retcode: 100 } });
      assert.equal((await sendQqMessage(home, { userId: '10001', text: 'hi' }, { fetchImpl: failing.fetchImpl })).ok, false);
    }
  );
});

test('parseOneBotEvent: private, group @ mention, array segments, self / non-message events', () => {
  const priv = parseOneBotEvent({ post_type: 'message', message_type: 'private', user_id: 42, raw_message: '你好', sender: { nickname: 'n' } });
  assert.deepEqual(
    { senderId: priv.senderId, groupId: priv.groupId, senderName: priv.senderName, text: priv.text },
    { senderId: '42', groupId: '', senderName: 'n', text: '你好' }
  );
  const seg = parseOneBotEvent({
    post_type: 'message', message_type: 'group', self_id: 9, user_id: 5, group_id: 77,
    message: [{ type: 'at', data: { qq: '9' } }, { type: 'text', data: { text: ' 在吗 &amp; 你好' } }],
    sender: { card: '群名片', nickname: 'nick' },
  });
  assert.equal(seg.groupId, '77');
  assert.equal(seg.senderName, '群名片', 'card wins over nickname');
  assert.equal(seg.text, '在吗 & 你好');
  assert.equal(parseOneBotEvent({ post_type: 'message', message_type: 'group', self_id: 9, user_id: 5, group_id: 1, raw_message: '[CQ:at,qq=1234] hi' }), null);
  assert.equal(parseOneBotEvent({ post_type: 'message', message_type: 'private', self_id: 9, user_id: 9, raw_message: 'echo' }), null);
  assert.equal(parseOneBotEvent({ post_type: 'notice' }), null);
});

test('qq onebot: without onebotHttpUrl the reply is returned as an OneBot quick operation', async () => {
  await withIm({}, async (ctx) => {
    await enable(ctx, 'qq', { mode: 'onebot', ownerId: '10001' });
    const res = await ctx.POST('/dsh-soulmate/api/im/webhook/qq', { post_type: 'message', message_type: 'private', user_id: 10001, raw_message: '在吗' });
    assert.equal(res.status, 200);
    assert.ok(json(res).reply.length > 0);
    assert.equal(ctx.net.calls.length, 0);
  });
});

test('qq official: access token exchange (cached) + C2C and group sends + webhook validation signature + C2C event', async () => {
  const SECRET = 'qq-official-SECRET-0123456789abcdef';
  const API = 'https://api.sgroup.qq.com';
  await withIm(
    {
      'POST https://bots.qq.com/app/getAppAccessToken': { access_token: 'QQTOK', expires_in: '7200' },
      [`POST ${API}/v2/users/OPENID_U/messages`]: { id: 'm-c2c' },
      [`POST ${API}/v2/groups/OPENID_G/messages`]: { id: 'm-grp' },
    },
    async (ctx) => {
      const { home, net, opts, POST } = ctx;
      const cfg = await enable(ctx, 'qq', { mode: 'official', appId: '1020304', appSecret: SECRET });
      noSecretLeak(cfg.body, [SECRET]);
      assert.equal(json(cfg).platforms.qq.mode, 'official');

      const c2c = await sendQqMessage(home, { userId: 'OPENID_U', text: '早安', msgId: 'in-1' }, opts);
      assert.deepEqual([c2c.ok, c2c.mode], [true, 'official']);
      const grp = await sendQqMessage(home, { groupId: 'OPENID_G', text: '大家早' }, opts);
      assert.equal(grp.ok, true);
      assert.equal(net.to('POST https://bots.qq.com/app/getAppAccessToken').length, 1, 'token is cached');
      const tokenCall = net.to('POST https://bots.qq.com/app/getAppAccessToken')[0];
      assert.deepEqual(tokenCall.body, { appId: '1020304', clientSecret: SECRET });
      const sent = net.to(`POST ${API}/v2/users/OPENID_U/messages`)[0];
      assert.equal(sent.headers.Authorization, 'QQBot QQTOK');
      assert.deepEqual([sent.body.content, sent.body.msg_type, sent.body.msg_id], ['早安', 0, 'in-1']);

      // callback validation (op 13): Ed25519 signature derived from the app secret
      const validation = await POST('/dsh-soulmate/api/im/webhook/qq', { op: 13, d: { plain_token: 'PLAIN', event_ts: '1700000000' } });
      assert.equal(validation.status, 200);
      const { plain_token: plain, signature } = json(validation);
      assert.equal(plain, 'PLAIN');
      const seed = Buffer.from(SECRET.repeat(2).slice(0, 32));
      const priv = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
      assert.equal(edVerify(null, Buffer.from('1700000000PLAIN'), createPublicKey(priv), Buffer.from(signature, 'hex')), true);

      // C2C event -> reply through the official API
      const evt = await POST('/dsh-soulmate/api/im/webhook/qq', {
        op: 0, t: 'C2C_MESSAGE_CREATE', d: { id: 'ev-1', content: '你好呀', author: { user_openid: 'OPENID_U' } },
      });
      assert.equal(evt.status, 200);
      assert.equal(net.to(`POST ${API}/v2/users/OPENID_U/messages`).length, 2);
      assert.equal(net.to(`POST ${API}/v2/users/OPENID_U/messages`)[1].body.msg_id, 'ev-1');
      assert.equal((await imNodes(ctx.service, 'qq')).length, 1);
    }
  );
});

// ---------------------------------------------------------------------------
// 3. Feishu
// ---------------------------------------------------------------------------

test('feishu: challenge handshake (no CSRF header) -> token verification -> im.message.receive_v1 -> tenant token + reply', async () => {
  const SECRET = 'feishu-APP-SECRET-xyz789';
  const VT = 'vt-VERIFY-123456';
  const FS = 'https://open.feishu.cn';
  await withIm(
    {
      [`POST ${FS}/open-apis/auth/v3/tenant_access_token/internal`]: { code: 0, tenant_access_token: 't-TENANT', expire: 7200 },
      [`POST ${FS}/open-apis/im/v1/messages/om_1/reply`]: { code: 0, data: { message_id: 'om_reply' } },
      [`POST ${FS}/open-apis/im/v1/messages`]: { code: 0, data: { message_id: 'om_new' } },
    },
    async (ctx) => {
      const { service, home, net, opts, POST } = ctx;

      // handshake works before anything is configured, and with browser-less headers
      const hs = await POST('/dsh-soulmate/api/im/webhook/feishu', { type: 'url_verification', challenge: 'ch-abc', token: 'whatever' }, { 'content-type': 'text/plain' });
      assert.equal(hs.status, 200);
      assert.deepEqual(json(hs), { challenge: 'ch-abc' });
      assert.equal((await POST('/dsh-soulmate/api/im/webhook/lark', { challenge: 'ch-2' }, { origin: 'https://open.feishu.cn', host: 'me.local' })).status, 200);
      assert.deepEqual(json(await ctx.POSTP('/dsh-soulmate/api/im/webhook/:platform', { challenge: 'ch-3' }, { platform: 'feishu' })), { challenge: 'ch-3' });

      await service.retainFact({ topic: '周末计划', content: '用户周末想去爬山' });
      const cfg = await enable(ctx, 'feishu', { appId: 'cli_a1b2c3d4e5', appSecret: SECRET, verificationToken: VT, ownerId: 'ou_owner' });
      noSecretLeak(cfg.body, [SECRET, VT]);

      const event = (token, id = 'ev-1') => ({
        schema: '2.0',
        header: { event_id: id, event_type: 'im.message.receive_v1', token },
        event: {
          sender: { sender_id: { open_id: 'ou_owner' }, sender_type: 'user' },
          message: { message_id: 'om_1', chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text: '周末计划有什么安排' }) },
        },
      });

      assert.equal((await POST('/dsh-soulmate/api/im/webhook/feishu', event('wrong-token'))).status, 403);
      assert.equal(net.calls.length, 0, 'a rejected event triggers no network I/O');

      const ok = await POST('/dsh-soulmate/api/im/webhook/feishu', event(VT));
      assert.equal(ok.status, 200);
      assert.deepEqual(json(ok), { code: 0 });
      const tokenCalls = net.to(`POST ${FS}/open-apis/auth/v3/tenant_access_token/internal`);
      assert.equal(tokenCalls.length, 1);
      assert.deepEqual(tokenCalls[0].body, { app_id: 'cli_a1b2c3d4e5', app_secret: SECRET });
      const reply = net.to(`POST ${FS}/open-apis/im/v1/messages/om_1/reply`)[0];
      assert.equal(reply.headers.Authorization, 'Bearer t-TENANT');
      assert.equal(reply.body.msg_type, 'text');
      assert.match(JSON.parse(reply.body.content).text, /爬山/);
      assert.equal((await imNodes(service, 'feishu')).length, 1);

      // Feishu retries are de-duplicated; group messages need an @mention
      const dup = await POST('/dsh-soulmate/api/im/webhook/feishu', event(VT));
      assert.equal(dup.status, 200);
      assert.equal(net.to(`POST ${FS}/open-apis/im/v1/messages/om_1/reply`).length, 1);
      const groupEvt = event(VT, 'ev-2');
      groupEvt.event.message.chat_type = 'group';
      groupEvt.event.message.message_id = 'om_2';
      await POST('/dsh-soulmate/api/im/webhook/feishu', groupEvt);
      assert.equal(net.to(`POST ${FS}/open-apis/im/v1/messages/om_2/reply`).length, 0);

      // proactive send: tenant token is cached, receive_id_type in the query
      const sent = await sendFeishuMessage(home, { receiveId: 'ou_owner', receiveIdType: 'open_id', text: '该喝水啦' }, opts);
      assert.deepEqual([sent.ok, sent.messageId], [true, 'om_new']);
      assert.equal(net.to(`POST ${FS}/open-apis/auth/v3/tenant_access_token/internal`).length, 1);
      const create = net.to(`POST ${FS}/open-apis/im/v1/messages`)[0];
      assert.equal(create.query.get('receive_id_type'), 'open_id');
      assert.equal(create.body.receive_id, 'ou_owner');
      assert.deepEqual(JSON.parse(create.body.content), { text: '该喝水啦' });

      // Lark international domain
      clearImTokenCache();
      const lark = createMockNet({
        'POST https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal': { code: 0, tenant_access_token: 'lt', expire: 7200 },
        'POST https://open.larksuite.com/open-apis/im/v1/messages': { code: 0, data: { message_id: 'lm' } },
      });
      assert.equal((await sendFeishuMessage(home, { receiveId: 'ou_x', text: 'hello' }, { fetchImpl: lark.fetchImpl, domain: 'lark' })).ok, true);
    }
  );
});

// ---------------------------------------------------------------------------
// 4. DingTalk
// ---------------------------------------------------------------------------

test('dingtalk: callback -> sessionWebhook auto-reply, SSRF guard, OAuth2 + proactive batchSend, Stream ticket, signature check', async () => {
  const SECRET = 'ding-CLIENT-SECRET-abc123';
  const API = 'https://api.dingtalk.com';
  const HOOK = 'https://oapi.dingtalk.com/robot/sendBySession';
  await withIm(
    {
      [`POST ${HOOK}`]: { errcode: 0, errmsg: 'ok' },
      [`POST ${API}/v1.0/oauth2/accessToken`]: { accessToken: 'DT-TOKEN', expireIn: 7200 },
      [`POST ${API}/v1.0/robot/oToMessages/batchSend`]: { processQueryKey: 'pqk-1', flowControlledStaffIdList: [], invalidStaffIdList: [] },
      [`POST ${API}/v1.0/gateway/connections/open`]: { endpoint: 'wss://wss-open-connection.dingtalk.com:443/connect', ticket: 'TICKET-1' },
    },
    async (ctx) => {
      const { service, home, net, opts, POST } = ctx;
      await service.retainFact({ topic: '项目周报', content: '用户每周五提交项目周报' });
      noSecretLeak(
        (await enable(ctx, 'dingtalk', { clientId: 'dingabcdefgh1234', clientSecret: SECRET, robotCode: 'dingabcdefgh1234' })).body,
        [SECRET]
      );
      const hookKey = `POST ${HOOK}`;
      net.to; // (calls recorded under the hook key below)
      const payload = (extra = {}) => ({
        msgtype: 'text', text: { content: ' 项目周报怎么写 ' }, senderStaffId: 'staff-001', senderNick: '阿澈',
        conversationType: '1', msgId: `msg-${Math.random()}`, sessionWebhook: `${HOOK}?session=abc`, ...extra,
      });
      const ts = String(Date.now());
      const sign = createHmac('sha256', SECRET).update(`${ts}\n${SECRET}`).digest('base64');
      const signed = { timestamp: ts, sign };

      // unsigned callbacks are rejected (fail closed); a valid signature passes
      assert.equal((await POST('/dsh-soulmate/api/im/webhook/dingtalk', payload())).status, 403);
      const res = await POST('/dsh-soulmate/api/im/webhook/dingtalk', payload(), signed);
      assert.equal(res.status, 200);
      const hook = net.to(hookKey);
      assert.equal(hook.length, 1);
      assert.equal(hook[0].body.msgtype, 'text');
      assert.match(hook[0].body.text.content, /项目周报/);
      assert.equal(hook[0].query.get('session'), 'abc');
      assert.equal(net.to(`POST ${API}/v1.0/oauth2/accessToken`).length, 0, 'sessionWebhook reply needs no OAuth');
      assert.equal((await imNodes(service, 'dingtalk')).length, 1);

      // an attacker-supplied sessionWebhook must never be called; it falls back to the OpenAPI
      const evil = await POST('/dsh-soulmate/api/im/webhook/dingtalk', payload({ sessionWebhook: 'http://127.0.0.1:8080/steal' }), signed);
      assert.equal(evil.status, 200);
      assert.equal(net.calls.some((c) => c.url.startsWith('http://127.0.0.1')), false);
      assert.equal(net.to(hookKey).length, 1);
      const batch = net.to(`POST ${API}/v1.0/robot/oToMessages/batchSend`);
      assert.equal(batch.length, 1);
      assert.equal(isSafeDingtalkWebhook('https://oapi.dingtalk.com/x'), true);
      assert.equal(isSafeDingtalkWebhook('https://evil-dingtalk.com.attacker.io/x'), false);
      assert.equal(isSafeDingtalkWebhook('http://oapi.dingtalk.com/x'), false);

      // proactive OpenAPI send
      const proactive = await sendDingtalkMessage(home, { userIds: ['staff-001'], text: '记得提交周报' }, opts);
      assert.deepEqual([proactive.ok, proactive.via], [true, 'openapi']);
      assert.equal(net.to(`POST ${API}/v1.0/oauth2/accessToken`).length, 1, 'access token is cached');
      assert.deepEqual(net.to(`POST ${API}/v1.0/oauth2/accessToken`)[0].body, { appKey: 'dingabcdefgh1234', appSecret: SECRET });
      const last = net.to(`POST ${API}/v1.0/robot/oToMessages/batchSend`).at(-1);
      assert.equal(last.headers['x-acs-dingtalk-access-token'], 'DT-TOKEN');
      assert.equal(last.body.robotCode, 'dingabcdefgh1234');
      assert.deepEqual(last.body.userIds, ['staff-001']);
      assert.equal(last.body.msgKey, 'sampleText');
      assert.deepEqual(JSON.parse(last.body.msgParam), { content: '记得提交周报' });

      // webhook direct mode + markdown title
      assert.equal((await sendDingtalkMessage(home, { sessionWebhook: `${HOOK}?session=zzz`, text: '直接回复', title: '标题' }, opts)).via, 'webhook');
      assert.equal(net.to(hookKey).at(-1).body.msgtype, 'markdown');
      const blocked = await sendDingtalkMessage(home, { sessionWebhook: 'https://example.com/hook', text: 'x' }, opts);
      assert.equal(blocked.ok, false);

      // Stream gateway ticket
      const ticket = await openDingtalkStreamTicket(home, opts);
      assert.deepEqual(ticket, { ok: true, endpoint: 'wss://wss-open-connection.dingtalk.com:443/connect', ticket: 'TICKET-1' });
      const tc = net.to(`POST ${API}/v1.0/gateway/connections/open`)[0];
      assert.deepEqual(tc.body, {
        clientId: 'dingabcdefgh1234',
        clientSecret: SECRET,
        subscriptions: [{ type: 'CALLBACK', topic: '/v1.0/im/bot/messages/get' }],
      });
      noSecretLeak(JSON.stringify(ticket), [SECRET]);

      // signed callbacks: right signature passes, wrong one is rejected
      assert.equal((await POST('/dsh-soulmate/api/im/webhook/dingtalk', payload(), signed)).status, 200);
      assert.equal((await POST('/dsh-soulmate/api/im/webhook/dingtalk', payload(), { timestamp: ts, sign: 'forged' })).status, 403);
      // unsigned is only accepted through the explicit Stream-relay opt-in
      const relayed = await handleDingtalkWebhook(service, payload(), { ...opts, allowUnsignedDingtalk: true });
      assert.equal(relayed.status, 200);
    }
  );
});

// ---------------------------------------------------------------------------
// 5. Brain bridge, privacy & security
// ---------------------------------------------------------------------------

test('privacy: IM credentials never reach /im/status, /state, /config or config.json; secrets in messages never enter memory', async () => {
  const SECRETS = ['wxSECRETtoken0123456789', 'napcat-SECRET-access', 'qq-SECRET-appsecret-xyz', 'fs-SECRET-appsecret-xyz', 'fs-SECRET-verify-token', 'dd-SECRET-clientsecret-xyz', 'dd-SECRET-robot-webhook'];
  await withIm(
    {
      'POST http://127.0.0.1:3000/send_private_msg': { status: 'ok', retcode: 0 },
      [`POST ${WX}/ilink/bot/sendmessage`]: { ret: 0 },
    },
    async (ctx) => {
      const { service, home, net, POST, GET } = ctx;
      await saveImCredentials(home, 'weixin', {
        token: SECRETS[0],
        userId: 'owner',
        accountId: 'acc',
        // iLink requires a session ticket before sendmessage; privacy scrub still runs first.
        contextTokens: { owner: 'ctx-privacy-test' },
      });
      await enable(ctx, 'qq', { mode: 'onebot', onebotHttpUrl: 'http://127.0.0.1:3000', onebotAccessToken: SECRETS[1], appSecret: SECRETS[2], ownerId: '10001' });
      await enable(ctx, 'feishu', { appId: 'cli_a1b2c3d4e5', appSecret: SECRETS[3], verificationToken: SECRETS[4] });
      await enable(ctx, 'dingtalk', { clientId: 'dingabcdefgh1234', clientSecret: SECRETS[5], defaultWebhook: `https://oapi.dingtalk.com/robot/send?access_token=${SECRETS[6]}` });

      // unknown keys are dropped, secrets live in credentials.json only
      await saveImCredentials(home, 'qq', { bogus: 'nope' });
      const creds = await readCreds(home);
      assert.equal(creds.im.qq.bogus, undefined);
      assert.equal(creds.im.qq.onebotAccessToken, SECRETS[1]);
      assert.equal(creds.im.dingtalk.defaultWebhook.includes(SECRETS[6]), true);
      assert.equal((await loadImCredentials(home)).feishu.appSecret, SECRETS[3]);

      const config = await readFile(home.configPath, 'utf8');
      noSecretLeak(config, SECRETS);
      for (const path of ['/dsh-soulmate/api/im/status', '/dsh-soulmate/api/state', '/dsh-soulmate/api/config']) {
        noSecretLeak((await GET(path)).body, SECRETS);
      }
      const status = json(await GET('/dsh-soulmate/api/im/status'));
      assert.deepEqual(Object.keys(status.platforms), ['weixin', 'qq', 'feishu', 'dingtalk']);
      assert.equal(status.platforms.qq.hasAccessToken, true);
      assert.equal(status.platforms.feishu.hasVerificationToken, true);
      assert.equal(status.platforms.dingtalk.hasDefaultWebhook, true);
      assert.match(status.platforms.weixin.tokenMasked, /\*\*\*\*/);
      assert.ok(Object.values(status.platforms).every((p) => p.enabled === true || p === status.platforms.weixin));

      // the model tool is equally masked
      const toolOut = await ctx.registeredTools.get('soulmate_im_manage').execute({ action: 'status' });
      assert.equal(toolOut.ok, true);
      noSecretLeak(JSON.stringify(toolOut), SECRETS);

      // an inbound message with a high-risk secret is blocked by the firewall
      const LEAK = 'sk-testonly-privacy-firewall-sample-key04';
      const res = await POST('/dsh-soulmate/api/im/webhook/qq', {
        post_type: 'message', message_type: 'private', user_id: 10001, raw_message: `我的密钥是 ${LEAK} 帮我记一下`,
      }, { authorization: `Bearer ${SECRETS[1]}` });
      assert.equal(res.status, 200);
      const sent = net.to('POST http://127.0.0.1:3000/send_private_msg');
      assert.equal(sent.length, 1);
      assert.match(sent[0].body.message, /没有记下来/);
      noSecretLeak(sent[0].body.message, [LEAK]);
      assert.equal((await imNodes(service, 'qq')).length, 0, 'no neuron for a blocked message');
      const graph = JSON.stringify(await service.getNeuralGraph());
      noSecretLeak(graph, [LEAK]);
      const recall = await service.recall('密钥');
      noSecretLeak(JSON.stringify(recall), [LEAK]);
      const audit = await readPrivacyAudit(home, 20);
      assert.ok(audit.some((a) => a.action === 'im_inbound_blocked' && a.platform === 'qq'));
      noSecretLeak(JSON.stringify(audit), [LEAK]);
      const blocked = await handleInboundImMessage(service, { platform: 'weixin', senderId: 'owner', text: `token ${LEAK}` }, { dispatchReply: false });
      assert.deepEqual([blocked.blocked, blocked.recorded], [true, false]);

      // outbound: the model cannot leak a secret through soulmate_im_send, PII is scrubbed
      const before = net.calls.length;
      const sendTool = ctx.registeredTools.get('soulmate_im_send');
      const refused = await sendTool.execute({ platform: 'weixin', text: `key=${LEAK}` });
      assert.equal(refused.ok, false);
      assert.ok(refused.blockedReason);
      assert.equal(net.calls.length, before, 'blocked text never reaches the network');
      const ok = await sendTool.execute({ platform: 'weixin', text: '文件在 C:\\Users\\Alice\\notes\\todo.txt 里', to: 'owner' });
      assert.equal(ok.ok, true, JSON.stringify(ok));
      const wxSend = net.to(`POST ${WX}/ilink/bot/sendmessage`).at(-1);
      assert.match(wxSend.body.msg.item_list[0].text_item.text, /<HOME>/);
      assert.ok(!wxSend.body.msg.item_list[0].text_item.text.includes('Alice'));
      const viaRoute = await POST('/dsh-soulmate/api/im/send', { platform: 'weixin', text: `password: hunter2hunter2` });
      assert.equal(viaRoute.status, 422);
      assert.equal((await POST('/dsh-soulmate/api/im/send', { platform: 'telegram', text: 'x' })).status, 400);
    }
  );
});

test('brain bridge: whitelist, disabled platform, imEnabled switch, custom replyGenerator and extension card', async () => {
  const OB = 'http://127.0.0.1:3000';
  await withIm({ [`POST ${OB}/send_private_msg`]: { status: 'ok', retcode: 0 } }, async (ctx) => {
    const { service, net, POST, GET } = ctx;
    const msg = (uid, text = '你好') => ({ post_type: 'message', message_type: 'private', user_id: uid, raw_message: text });

    // disabled platform -> rejected
    assert.equal((await POST('/dsh-soulmate/api/im/webhook/qq', msg(10001))).status, 403);
    assert.equal((await ctx.POSTP('/dsh-soulmate/api/im/webhook/:platform', {}, { platform: 'telegram' })).status, 400);

    await enable(ctx, 'qq', { mode: 'onebot', onebotHttpUrl: OB }, { whitelist: ['10001'] });
    const wl = await service.getState();
    assert.ok(wl);

    // whitelist: strangers get nothing (no reply, no neuron, no mood change)
    const before = (await service.getState()).interactionCount;
    assert.equal((await POST('/dsh-soulmate/api/im/webhook/qq', msg(20002))).status, 200);
    assert.equal(net.calls.length, 0);
    assert.equal((await service.getState()).interactionCount, before);
    assert.equal((await imNodes(service, 'qq')).length, 0);

    // listed sender is answered; chat grows affinity and a rolling neuron
    const ignored = await handleInboundImMessage(service, { platform: 'qq', senderId: '20002', text: 'hi' }, { dispatchReply: false });
    assert.equal(ignored.reason, 'not_whitelisted');
    assert.equal((await POST('/dsh-soulmate/api/im/webhook/qq', msg(10001, '第一句'))).status, 200);
    assert.equal((await POST('/dsh-soulmate/api/im/webhook/qq', msg(10001, '第二句'))).status, 200);
    assert.equal(net.to(`POST ${OB}/send_private_msg`).length, 2);
    const nodes = await imNodes(service, 'qq');
    assert.equal(nodes.length, 1, 'one rolling neuron per contact');
    assert.match(nodes[0].content, /第一句[\s\S]*第二句/);
    assert.equal((await service.getState()).interactionCount, before + 2);

    // custom reply generator receives persona / mood / memories and may replace the template
    const seen = [];
    const custom = await handleInboundImMessage(
      service,
      { platform: 'qq', senderId: '10001', text: '你是谁' },
      { dispatchReply: false, replyGenerator: (c) => { seen.push(c); return `我是${c.persona.name}`; } }
    );
    assert.equal(custom.reply, '我是soulmate');
    assert.equal(seen[0].platform, 'qq');
    assert.ok(seen[0].mood);
    const broken = await handleInboundImMessage(
      service,
      { platform: 'qq', senderId: '10001', text: '再来' },
      { dispatchReply: false, replyGenerator: () => { throw new Error('llm down'); } }
    );
    assert.equal(broken.ok, true);
    assert.match(broken.reply, /我/, 'falls back to the persona template');

    // global switch
    await ctx.POST('/dsh-soulmate/api/im/config', { action: 'configure', imEnabled: false });
    assert.equal((await POST('/dsh-soulmate/api/im/webhook/qq', msg(10001))).status, 403);

    // extension card is registered and mirrors the live switch (not a hardcoded "active")
    const state = json(await GET('/dsh-soulmate/api/state'));
    const ext = state.extensions.find((e) => e.id === 'soulmate-im');
    assert.ok(ext);
    assert.equal(ext.name, '💬 跨端分身 (微信 / QQ / 飞书 / 钉钉)');
    assert.equal(state.config.extensions.imEnabled, false);
    assert.equal(ext.enabled, false);
    assert.equal(ext.status, 'disabled');
  });
});

test('security: DNS-rebinding Host guard, feishu token required, memories fail closed without owner', async () => {
  await withIm({}, async (ctx) => {
    const { service, POST, GET } = ctx;

    // a rebinding page sends its own domain as Host — local routes must refuse it
    assert.equal((await GET('/dsh-soulmate/api/state', { host: 'evil.example' })).status, 403);
    assert.equal((await POST('/dsh-soulmate/api/im/config', { action: 'status' }, { host: 'evil.example', 'content-type': 'application/json' })).status, 403);
    // loopback names and literal IPs (incl. LAN) stay usable
    for (const host of ['localhost:3000', '127.0.0.1:3000', '[::1]:3000', '192.168.1.5:3000']) {
      assert.equal((await GET('/dsh-soulmate/api/state', { host })).status, 200, host);
    }

    // feishu events without a configured verificationToken are refused (handshake still works)
    assert.equal((await POST('/dsh-soulmate/api/im/webhook/feishu', { challenge: 'ch-x' })).status, 200);
    await enable(ctx, 'feishu', { appId: 'cli_a1b2c3d4e5', appSecret: 'feishu-APP-SECRET-xyz789' });
    const evt = {
      schema: '2.0',
      header: { event_id: 'ev-x', event_type: 'im.message.receive_v1', token: 'anything' },
      event: {
        sender: { sender_id: { open_id: 'ou_x' }, sender_type: 'user' },
        message: { message_id: 'om_x', chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text: '在吗' }) },
      },
    };
    assert.equal((await POST('/dsh-soulmate/api/im/webhook/feishu', evt)).status, 403);

    // no owner / whitelist configured -> a stranger's reply must not quote memories
    await service.retainFact({ topic: '咖啡偏好', content: '用户喜欢冰美式，不加糖' });
    await enable(ctx, 'qq', { mode: 'onebot' });
    const msg = { post_type: 'message', message_type: 'private', user_id: 777, raw_message: '你还记得我的咖啡偏好吗', sender: { nickname: '陌生人' } };
    const stranger = await POST('/dsh-soulmate/api/im/webhook/qq', msg);
    assert.equal(stranger.status, 200);
    assert.ok(!json(stranger).reply.includes('冰美式'), 'unconfigured owner must not make everyone trusted');
    // once the owner is set, the owner gets her memory back
    await enable(ctx, 'qq', { mode: 'onebot', ownerId: '777' });
    const owner = await POST('/dsh-soulmate/api/im/webhook/qq', { ...msg, message_id: 2 });
    assert.equal(owner.status, 200);
    assert.match(json(owner).reply, /冰美式/);
  });
});

test('im tools & routes: 10 built-in tools, manage tool actions, config validation', async () => {
  await withIm(
    { [`GET ${WX}/ilink/bot/get_bot_qrcode`]: { ret: 0, qrcode: 'QRX', qrcode_img_content: 'img' } },
    async (ctx) => {
      const { registeredTools, routes } = ctx;
      assert.equal(registeredTools.size, 23, '10 v1 + bili_manage + bili_action + video_consent + 2 trust + weather + 7 official-qq tools');
    assert.ok(registeredTools.has('soulmate_memory_promise'));
      assert.ok(registeredTools.has('soulmate_memory_resolve_conflict'));
      for (const name of ['soulmate_im_send', 'soulmate_im_manage']) assert.ok(registeredTools.has(name));
      for (const key of ['GET /dsh-soulmate/api/im/status', 'POST /dsh-soulmate/api/im/config', 'POST /dsh-soulmate/api/im/send', 'POST /dsh-soulmate/api/im/webhook/:platform']) {
        assert.ok(routes.has(key), key);
      }

      const manage = registeredTools.get('soulmate_im_manage');
      const qr = await manage.execute({ action: 'weixin_qr_start' });
      assert.equal(qr.qrcode, 'QRX');
      assert.equal((await manage.execute({ action: 'stream_ticket' })).ok, false, 'dingtalk not configured');
      await assert.rejects(() => manage.execute({ action: 'explode' }), /must be one of/);
      const cfg = await manage.execute({ action: 'configure', platform: 'feishu', credentials: { appId: 'cli_x1234567', appSecret: 's3cr3t-value' }, enabled: false });
      assert.equal(cfg.platforms.feishu.configured, true);
      assert.equal(cfg.platforms.feishu.enabled, false);
      const card = manage.output.presentationMeta({}, cfg);
      assert.equal(card.tool, 'soulmate_im_manage');

      const sendTool = registeredTools.get('soulmate_im_send');
      await assert.rejects(() => sendTool.execute({ platform: 'weixin' }), /missing required argument "text"/);
      await assert.rejects(() => sendTool.execute({ platform: 'irc', text: 'x' }), /must be one of/);
      const unconfigured = await sendTool.execute({ platform: 'qq', text: 'hello' });
      assert.equal(unconfigured.ok, false);

      // route validation
      assert.equal((await ctx.POST('/dsh-soulmate/api/im/config', { action: 'configure', platform: 'irc' })).status, 400);
      assert.equal((await ctx.POST('/dsh-soulmate/api/im/send', { platform: 'qq' })).status, 400);
      const qrRoute = await ctx.POST('/dsh-soulmate/api/im/config', { action: 'weixin_qr_start' });
      assert.equal(json(qrRoute).qrcode, 'QRX');
      // CSRF: a cross-origin browser POST to a management route is refused, the webhook is not subject to it
      const cross = await ctx.POST('/dsh-soulmate/api/im/config', { action: 'status' }, { origin: 'https://evil.example', host: 'localhost:3000', 'content-type': 'application/json' });
      assert.equal(cross.status, 403);
    }
  );
});

test('plugin config validation for IM options fails loudly', () => {
  const dir = join(tmpdir(), 'soulmate-im-never-created');
  for (const bad of [{ imFetch: 'nope' }, { imReplyGenerator: 1 }, { imAutoPoll: 'yes' }, { imMemoryVisibility: 'public' }]) {
    const { mockCtx } = createMockCtx(dir);
    assert.throws(() => apply(mockCtx, bad), /\[soulmate\] config\.im/);
  }
});
