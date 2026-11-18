// Panel → DSH conversation requests.
// The panel never downloads anything itself: it asks the home session, and the agent
// there uses its own DSH tools (shell / network) to do the work the user asked for.

import { jsonOut } from '../http-plumbing.mjs';

const FFMPEG_ASK_TEXT = [
  '（桌面小伙伴）抽帧需要 ffmpeg，但这台电脑上没检测到。',
  '请帮我下载并安装 ffmpeg（Windows），装好后把可执行文件路径告诉我。',
  '装好后我会把路径填进「ffmpeg 路径」，抽帧就能用了。',
].join('\n');

export function chatRoutes({ askHomeAgent }) {
  return [
    {
      method: 'POST',
      paths: ['/dsh-soulmate/api/ffmpeg-download'],
      handler: async () => {
        if (typeof askHomeAgent !== 'function') {
          return jsonOut(503, { ok: false, error: 'chat-home-unavailable' });
        }
        const res = await Promise.resolve()
          .then(() => askHomeAgent(FFMPEG_ASK_TEXT))
          .catch((err) => ({ ok: false, error: err instanceof Error ? err.message : String(err) }));
        if (res && res.ok) return jsonOut(200, { ok: true, via: res.via || 'prompt' });
        return jsonOut(502, { ok: false, error: (res && res.error) || 'ask-failed' });
      },
    },
  ];
}