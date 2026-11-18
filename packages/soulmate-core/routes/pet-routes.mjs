// Desktop-pet window status for the settings card.
// Read-only: the switch itself still lives in config.pet.windowEnabled.

import { jsonOut } from '../http-plumbing.mjs';

export function petRoutes({ petWindowStatus }) {
  return [
    {
      method: 'GET',
      paths: ['/dsh-soulmate/api/pet-window'],
      handler: async () => {
        const status = typeof petWindowStatus === 'function' ? petWindowStatus() : null;
        if (!status) return jsonOut(200, { ok: true, available: false });
        return jsonOut(200, { ok: true, available: true, ...status });
      },
    },
  ];
}