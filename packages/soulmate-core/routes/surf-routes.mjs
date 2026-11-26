// Surf journal API — platform-scoped (bilibili / douyin / …).

import { jsonOut } from '../http-plumbing.mjs';
import { loadConfig } from '../state.mjs';
import {
  deleteSurfLogEntry,
  listSurfLogDates,
  listSurfLogPage,
  SURF_PLATFORMS,
} from '../surf-log.mjs';
import {
  listPendingLongConsents,
  longVideoConsentMinutes,
} from '../../soulmate-bili/long-consent.mjs';

function platformOr400(raw) {
  const platform = String(raw || 'bilibili').trim() || 'bilibili';
  if (!SURF_PLATFORMS.includes(platform)) {
    return { error: `platform 须为 ${SURF_PLATFORMS.join(' | ')}` };
  }
  return { platform };
}

export function surfRoutes({ home, video }) {
  return [
    {
      // 超长视频待确认队列：自动巡片不会自己看，等用户在这里点头。
      method: 'GET',
      paths: ['/dsh-soulmate/api/long-video-consent'],
      handler: async () => {
        const conf = await loadConfig(home).catch(() => null);
        return jsonOut(200, {
          ok: true,
          thresholdMinutes: longVideoConsentMinutes(conf?.extensions ?? {}),
          pending: await listPendingLongConsents(home),
        });
      },
    },
    {
      method: 'POST',
      paths: ['/dsh-soulmate/api/long-video-consent'],
      handler: async ({ body }) => {
        const action = String(body?.action || '').trim();
        if (action !== 'approve' && action !== 'decline') {
          return jsonOut(400, { ok: false, error: 'action 须为 approve | decline' });
        }
        if (typeof video?.videoConsent !== 'function') {
          return jsonOut(503, { ok: false, error: 'consent runtime not ready' });
        }
        const res = await video.videoConsent({ action, bvid: body?.bvid });
        return jsonOut(res?.ok === false ? 400 : 200, res);
      },
    },
    {
      method: 'GET',
      paths: ['/dsh-soulmate/api/surf-log'],
      handler: async ({ query }) => {
        const checked = platformOr400(query.get('platform'));
        if (checked.error) return jsonOut(400, { ok: false, error: checked.error });
        const { platform } = checked;
        const filter = String(query.get('filter') || 'all').trim() || 'all';
        const day = String(query.get('day') || '').trim();
        const wantDates = query.get('dates') === '1' || query.get('dates') === 'true';
        if (wantDates) {
          const dates = await listSurfLogDates(home, { platform, filter });
          return jsonOut(200, { ok: true, platform, filter, dates });
        }
        const limit = Number(query.get('limit')) || 20;
        const offset = Number(query.get('offset')) || 0;
        const page = await listSurfLogPage(home, { platform, filter, day, limit, offset });
        return jsonOut(200, {
          ok: true,
          platform,
          filter,
          day: page.day,
          entries: page.entries,
          total: page.total,
          offset: page.offset,
          limit: page.limit,
          hasMore: page.hasMore,
        });
      },
    },
    {
      method: 'POST',
      paths: ['/dsh-soulmate/api/surf-log'],
      handler: async ({ body }) => {
        const action = String(body?.action || '').trim();
        if (action !== 'delete') {
          return jsonOut(400, { ok: false, error: 'action 须为 delete' });
        }
        const checked = platformOr400(body?.platform);
        if (checked.error) return jsonOut(400, { ok: false, error: checked.error });
        const res = await deleteSurfLogEntry(home, {
          platform: checked.platform,
          id: body?.id,
          videoId: body?.videoId || body?.bvid,
          at: body?.at,
        });
        return jsonOut(res.ok ? 200 : (res.error === 'not-found' ? 404 : 400), res);
      },
    },
  ];
}
