// Server-only mount point for the official QQ bot.
//
// The bundle patch loads the QQ bot through this subpath instead of the package
// root. The host's client registry only loads a browser surface when
// `<spec>/package.json` resolves, so rooting the patch at the official package
// made DSH also mount its standalone sidebar (id `im-qqbot`). Soulmate ships its
// own QQ column that drives the same `/qqbot/im-qqbot/*` routes, so the extra
// sidebar is redundant.
//
// The official node half stays authoritative: routes, QR binding, credential
// persistence and message routing all still come from upstream. Soulmate only
// wraps apply to keep each QQ step on the model last picked in the DSH
// conversation picker.
import { apply as applyOfficial } from '@tencent-connect/dsh-qqbot'
import { QQBot } from '@tencent-connect/qqbot-nodejs'
import { installQqModelSync } from './qqbot-model-sync.mjs'
import { startQqMsgIdMirror } from './qqbot-msgid-mirror.mjs'

export { name, inject, Config } from '@tencent-connect/dsh-qqbot'

export async function apply(ctx, config) {
  installQqModelSync(ctx)
  // Mirror the official SDK's in-memory reply-id cache to disk so the proactive
  // sender can use REAL QQ msg_ids (the session transcript only has DSH-internal ids,
  // which the platform rejects with "msg_id 无效或越权").
  startQqMsgIdMirror(ctx, QQBot)
  await applyOfficial(ctx, config)
}
