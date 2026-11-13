// Token accounting: today's spend, the 7-day trend, and the editable daily cap.

import { jsonOut } from '../http-plumbing.mjs';
import { errMsg } from '../small-utils.mjs';

export function usageRoutes({ usage }) {
  const { getUsageSnapshot, setUsageConfig } = usage;
  return [
    {
      method: 'GET',
      paths: ['/dsh-soulmate/api/usage'],
      handler: async () => jsonOut(200, await getUsageSnapshot()),
    },
    {
      method: 'POST',
      paths: ['/dsh-soulmate/api/usage'],
      handler: async ({ body }) => {
        try {
          const res = await setUsageConfig(body ?? {});
          return jsonOut(200, res);
        } catch (err) {
          return jsonOut(400, { ok: false, error: errMsg(err) });
        }
      },
    },
  ];
}
