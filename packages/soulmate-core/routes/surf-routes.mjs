// Surf journal API — platform-scoped (bilibili / douyin / …).

import { jsonOut } from '../http-plumbing.mjs';
import { listSurfLogDates, listSurfLogPage, SURF_PLATFORMS } from '../surf-log.mjs';

export function surfRoutes({ home }) {
  return [
    {
      method: 'GET',
      paths: ['/dsh-soulmate/api/surf-log'],
      handler: async ({ query }) => {
        const platform = String(query.get('platform') || 'bilibili').trim() || 'bilibili';
        if (!SURF_PLATFORMS.includes(platform)) {
          return jsonOut(400, { ok: false, error: `platform 须为 ${SURF_PLATFORMS.join(' | ')}` });
        }
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
  ];
}
