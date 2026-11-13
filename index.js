// dsh-plugin-whale-soulmate — Node half (DeepSeek Harness bundle entry).
//
// The implementation lives in packages/soulmate-core (microkernel) and
// packages/soulmate-home (3D home page); this file is the stable package entry that the
// `cordis.patch.yml` row `name: dsh-plugin-whale-soulmate` resolves to.
//
// Zero external imports at runtime: no `@deepseek-ai/dsh-tools`, no Python/uv/ffmpeg.
export { name, inject, apply, defineTool, CARD_KIND } from './packages/soulmate-core/index.mjs';
export { renderSoulmateHomeHtml } from './packages/soulmate-home/room3d-page.mjs';
export {
  parseVideoTarget,
  digestBiliVideo,
  watchAndRecordVideo,
  runAutonomousSurfRound,
  shareVideoToUser,
  saveBiliCredentials,
} from './packages/soulmate-bili/index.mjs';
export {
  IM_EXTENSION_ID,
  IM_PLATFORMS,
  saveImCredentials,
  loadImCredentials,
  getImStatus,
  startWeixinQrLogin,
  pollWeixinQrStatus,
  pollWeixinUpdatesOnce,
  sendWeixinMessage,
  startWeixinPollLoop,
  sendQqMessage,
  parseOneBotEvent,
  handleQqWebhook,
  sendFeishuMessage,
  handleFeishuWebhook,
  sendDingtalkMessage,
  openDingtalkStreamTicket,
  handleDingtalkWebhook,
  sendImMessage,
  handleInboundImMessage,
  manageIm,
  handleImWebhook,
} from './packages/soulmate-im/index.mjs';
