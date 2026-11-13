// Bilibili + IM extension routes (auth, status, config, send, platform webhooks).

import { getBiliAuthStatus } from '../../soulmate-bili/index.mjs';
import { getImStatus, handleImWebhook, manageIm, normalizePlatform, sendImMessage } from '../../soulmate-im/index.mjs';
import { jsonOut, statusOf } from '../http-plumbing.mjs';
import { errMsg } from '../small-utils.mjs';

export function extensionRoutes({ home, service, pushEvent, eventSeq, video, imNet }) {
  const { videoWatch, videoSurf, videoShare, biliAuthManage } = video;
  return [
    {
      method: 'POST',
      paths: ['/dsh-soulmate/api/video-watch'],
      handler: async ({ body }) => {
        const action = body.action ?? (typeof body.target === 'string' && body.target.trim() ? 'watch' : 'surf');
        let res;
        try {
          if (action === 'watch') {
            if (typeof body.target !== 'string' || !body.target.trim()) res = { ok: false, error: 'target is required' };
            else res = await videoWatch(body);
          } else if (action === 'surf') res = await videoSurf(body);
          else if (action === 'share') res = await videoShare(body);
          else res = { ok: false, error: `unknown action "${action}" (watch | surf | share)` };
        } catch (err) {
          res = { ok: false, error: errMsg(err) };
        }
        return jsonOut(statusOf(res), { ...res, eventSeq: eventSeq() });
      },
    },
    {
      method: 'GET',
      paths: ['/dsh-soulmate/api/bili/auth'],
      handler: async () => jsonOut(200, await getBiliAuthStatus(home)),
    },
    {
      method: 'POST',
      paths: ['/dsh-soulmate/api/bili/auth'],
      handler: async ({ body }) => {
        const res = await biliAuthManage({ ...body, action: body.action ?? 'status' });
        return jsonOut(statusOf(res), res);
      },
    },
    {
      method: 'GET',
      paths: ['/dsh-soulmate/api/im/status'],
      handler: async () => jsonOut(200, await getImStatus(home)),
    },
    {
      method: 'POST',
      paths: ['/dsh-soulmate/api/im/config'],
      handler: async ({ body }) => {
        const res = await manageIm(service, { ...body, action: body.action ?? 'configure' }, imNet());
        if (res.ok) pushEvent('im_config', { platform: normalizePlatform(body.platform) ?? '' });
        return jsonOut(statusOf(res), res);
      },
    },
    {
      method: 'POST',
      paths: ['/dsh-soulmate/api/im/send'],
      handler: async ({ body }) => {
        if (typeof body.platform !== 'string' || !body.platform.trim()) return jsonOut(400, { ok: false, error: 'platform is required' });
        if (typeof body.text !== 'string' || !body.text.trim()) return jsonOut(400, { ok: false, error: 'text is required' });
        const res = await sendImMessage(home, body.platform, body, imNet());
        if (res.ok) pushEvent('im_send', { platform: res.platform });
        return jsonOut(statusOf(res), res);
      },
    },
    {
      // Called by the IM platforms themselves (no browser origin / CSRF header): authenticity is
      // checked per platform (Feishu verification token, DingTalk signature, OneBot access token).
      method: 'POST',
      external: true,
      paths: [
        '/dsh-soulmate/api/im/webhook/:platform',
        ...['qq', 'feishu', 'lark', 'dingtalk'].map((p) => `/dsh-soulmate/api/im/webhook/${p}`),
      ],
      handler: async ({ req, query, body }) => {
        const last = String(new URL(req?.url ?? req?.originalUrl ?? '/', 'http://soulmate.local').pathname.split('/').pop() ?? '');
        const platform = req?.params?.platform ?? (normalizePlatform(last) ? last : query.get('platform') ?? last);
        const res = await handleImWebhook(service, platform, body, { ...imNet(), headers: req?.headers ?? {} });
        const payload = res.ok === false ? { ok: false, error: res.error } : (res.response ?? {});
        return jsonOut(res.status ?? 200, payload);
      },
    },
  ];
}
