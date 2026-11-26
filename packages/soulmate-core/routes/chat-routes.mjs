// Panel → DSH conversation requests.
// The panel never downloads anything itself: it asks the home session, and the agent
// there uses its own DSH tools (shell / network) to do the work the user asked for.

import { jsonOut } from '../http-plumbing.mjs';

const FFMPEG_ASK_TEXT = [
  '（桌面小伙伴）抽帧需要 ffmpeg，但这台电脑上没检测到。',
  '请帮我下载并安装 ffmpeg（Windows），装好后把可执行文件路径告诉我。',
  '装好后我会把路径填进「ffmpeg 路径」，抽帧就能用了。',
].join('\n');

const ELECTRON_ASK_TEXT = [
  '（桌面小伙伴）我想开「窗口桌宠」，但这台电脑上没找到 Electron 运行时。',
  '请帮我下载并安装 Electron 桌面版（Windows x64），放到 ~/.dsh/electron/，确保里面有 electron.exe；需要代理就用本机现有代理。',
  '务必一次性装完再让它出现在 ~/.dsh/electron/：先解压到临时目录，确认 electron.exe 与 resources/ 齐全后整体移动/改名过去。不要边解压边让 electron.exe 可见——桌宠会去启动半截文件（spawn ETXTBSY）。',
  '装好后把 electron.exe 的完整路径告诉我，我会填进「Electron 路径」，窗口桌宠就能起来了。',
].join('\n');

export function chatRoutes({ askHomeAgent }) {
  const ask = async (text) => {
    if (typeof askHomeAgent !== 'function') {
      return jsonOut(503, { ok: false, error: 'chat-home-unavailable' });
    }
    const res = await Promise.resolve()
      .then(() => askHomeAgent(text))
      .catch((err) => ({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    if (res && res.ok) return jsonOut(200, { ok: true, via: res.via || 'prompt' });
    return jsonOut(502, { ok: false, error: (res && res.error) || 'ask-failed' });
  };
  return [
    {
      method: 'POST',
      paths: ['/dsh-soulmate/api/ffmpeg-download'],
      handler: async () => ask(FFMPEG_ASK_TEXT),
    },
    {
      method: 'POST',
      paths: ['/dsh-soulmate/api/pet-electron-install'],
      handler: async () => ask(ELECTRON_ASK_TEXT),
    },
  ];
}