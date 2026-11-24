// Star-sea extras: weekly growth trajectory + the independent neuron window lifecycle.
// Growth rows are written by growth-runtime at each weekly gate; history starts the week
// that shipped and cannot be backfilled — an empty list is honest, not an error.

import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { readJsonlTail } from '../state.mjs';
import { jsonOut } from '../http-plumbing.mjs';
import { errMsg } from '../small-utils.mjs';

export function neuronRoutes({ home, neuronWindow }) {
  return [
    {
      method: 'GET',
      paths: ['/dsh-soulmate/api/growth'],
      handler: async () => {
        const rows = await readJsonlTail(join(home.rootDir, 'logs', 'growth.jsonl'), 120).catch(() => []);
        // One row per ISO week (the gate is idempotent); keep the last per week defensively.
        const byWeek = new Map();
        for (const r of rows) if (r && r.week) byWeek.set(r.week, r);
        return jsonOut(200, { ok: true, weeks: [...byWeek.values()] });
      },
    },
    {
      // Her learned lessons — visible where the user looks, deletable by wiping the file.
      method: 'GET',
      paths: ['/dsh-soulmate/api/experience'],
      handler: async () => {
        try {
          const data = JSON.parse(await readFile(join(home.rootDir, 'memory', 'experience.json'), 'utf8'));
          return jsonOut(200, { ok: true, notes: Array.isArray(data?.notes) ? data.notes : [], updatedAt: data?.updatedAt || '' });
        } catch {
          return jsonOut(200, { ok: true, notes: [], updatedAt: '' });
        }
      },
    },
    {
      method: 'GET',
      paths: ['/dsh-soulmate/api/neuron-window'],
      handler: async () => jsonOut(200, { ok: true, ...(neuronWindow ? neuronWindow.status() : { running: false }) }),
    },
    {
      method: 'POST',
      paths: ['/dsh-soulmate/api/neuron-window/open'],
      handler: async () => {
        if (!neuronWindow) return jsonOut(200, { ok: false, error: 'neuron window unavailable' });
        try {
          return jsonOut(200, await neuronWindow.open());
        } catch (err) {
          return jsonOut(200, { ok: false, error: errMsg(err) });
        }
      },
    },
    {
      // The window posts its bounds on close so the next open lands where it was.
      method: 'POST',
      paths: ['/dsh-soulmate/api/neuron-window/bounds'],
      handler: async ({ body }) => jsonOut(200, await neuronWindow.rememberBounds(body ?? {})),
    },
  ];
}