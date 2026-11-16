// Surf journal API — platform-scoped (bilibili / douyin / …).

import { jsonOut } from '../http-plumbing.mjs';
import { listSurfLog, SURF_PLATFORMS } from '../surf-log.mjs';

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
        const limit = Number(query.get('limit')) || 40;
        const entries = await listSurfLog(home, { platform, filter, limit });
        return jsonOut(200, { ok: true, platform, filter, entries });
      },
    },
  ];
}
