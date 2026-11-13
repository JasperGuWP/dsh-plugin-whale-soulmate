// Route assembly: domain route tables gathered in mount order.
// 3D 家园（/soulmate-home）暂停开发：路由不挂载，代码保留在 soulmate-home/ 待重启。

import { personaRoutes } from './persona-routes.mjs';
import { memoryRoutes } from './memory-routes.mjs';
import { assetRoutes } from './asset-routes.mjs';
import { proactiveRoutes } from './proactive-routes.mjs';
import { extensionRoutes } from './extension-routes.mjs';
import { cloudRoutes } from './cloud-routes.mjs';
import { usageRoutes } from './usage-routes.mjs';
import { eventRoutes } from './event-routes.mjs';

export function buildRoutes(deps) {
  return [
    ...personaRoutes(deps),
    ...memoryRoutes(deps),
    ...usageRoutes(deps),
    ...proactiveRoutes(deps),
    ...assetRoutes(deps),
    ...extensionRoutes(deps),
    ...cloudRoutes(deps),
    ...eventRoutes(deps),
  ];
}
