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