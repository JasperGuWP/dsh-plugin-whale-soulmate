// 自更新路由:状态查询 / 一键安装新 tarball / 桌面端自重启。
import { jsonOut } from '../http-plumbing.mjs';

export function updateRoutes({ selfUpdate }) {
  return [
    {
      method: 'GET',
      paths: ['/dsh-soulmate/api/update-status'],
      handler: async () => jsonOut(200, { ok: true, ...selfUpdate.status() }),
    },
    {
      // 面板「检查更新」：立即探测三渠道后返回最新状态（GET status 只读缓存）。
      method: 'POST',
      paths: ['/dsh-soulmate/api/update-check'],
      handler: async () => {
        try {
          if (typeof selfUpdate.checkNow === 'function') await selfUpdate.checkNow();
          return jsonOut(200, { ok: true, ...selfUpdate.status() });
        } catch (err) {
          return jsonOut(200, { ok: false, error: err instanceof Error ? err.message : String(err), ...selfUpdate.status() });
        }
      },
    },
    {
      method: 'POST',
      paths: ['/dsh-soulmate/api/self-update'],
      handler: async () => jsonOut(200, await selfUpdate.install()),
    },
    {
      method: 'POST',
      paths: ['/dsh-soulmate/api/self-restart'],
      handler: async () => jsonOut(200, await selfUpdate.restart()),
    },
  ];
}