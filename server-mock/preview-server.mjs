// Standalone local preview server for `dsh-plugins-soulmate`.
// Starts the Mock AIGC Cloud Server + a local DSH WebServer host on http://127.0.0.1:4399/soulmate-home
// with rich demo data (Local Cortex Wiki & Facts, Gold Quantum-Shielded Private Memory,
// Remote Cloud Ring + AIGC Capabilities, Watched Bilibili Video Memento, and Dual Notebooks).
import { createServer } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir } from 'node:fs/promises';
import { apply } from '../index.js';
import { startMockAigcServer } from './aigc-mock-server.mjs';
import { saveConfigAuto, saveCredentials, resolveSoulmateHome } from '../packages/soulmate-core/state.mjs';

const PORT = Number(process.env.PORT) || 4399;
const previewHomeDir = process.env.SOULMATE_PREVIEW_HOME || join(tmpdir(), 'dsh-soulmate-live-preview');

await mkdir(previewHomeDir, { recursive: true });
const aigcServer = await startMockAigcServer(0);

let dispatchHandler = null;
const registeredTools = new Map();
const promptSections = [];

const mockCtx = {
  tools: {
    register(tool) {
      registeredTools.set(tool.name, tool);
      return () => registeredTools.delete(tool.name);
    },
  },
  systemPrompt: {
    section(sec) {
      promptSections.push(sec);
      return () => {};
    },
  },
  effect(fn) {
    fn();
  },
  provide() {},
  set(k, v) {
    mockCtx[k] = v;
  },
  get(k) {
    if (k === 'dshHomePath') return (...segs) => join(previewHomeDir, ...segs);
    if (k === 'webServer') {
      return {
        use(fn) {
          dispatchHandler = fn;
          return () => {
            dispatchHandler = null;
          };
        },
      };
    }
    return mockCtx[k];
  },
};

apply(mockCtx, { homeDir: previewHomeDir });
await mockCtx.soulmate.ready;

const home = resolveSoulmateHome(previewHomeDir);
const state0 = await mockCtx.soulmate.getState();

// Seed demo data on first boot so the 3D Sci-Fi Neural Nebula & 3D Room look rich immediately
if ((state0.interactionCount ?? 0) === 0) {
  await saveConfigAuto(home, {
    onboardingCompleted: true,
    persona: {
      name: '', // default '鱼' -> 《鱼的小本本》; rename in UI to see it turn into 《xxx的小本本》
      callUser: '搭档',
      selfRef: '本鱼',
      preset: 'rice-whale',
      allowSelfEvolution: true,
      evolvedTraits: [
        '陪搭档排查复杂工程问题时，习惯先给可运行补丁再顺手讨一碗大白米饭',
        '看到高赞硬核技术视频会主动记进小本本并挂上 3D 照片墙',
      ],
      traitDeltas: { curiosity: 8, tsundere: 5 },
    },
    cloud: {
      enabled: true,
      consentGiven: true,
      consentAt: new Date().toISOString(),
      serverUrl: aigcServer.baseUrl,
    },
  });
  await saveCredentials(home, {
    apiKey: 'ak_demo_soulmate_preview_88889999',
    userId: 'u_demo_partner',
  });

  // 1. Seed LLM Wiki Mental Models with [[bidirectional links]]
  await mockCtx.soulmate.reflect({
    slug: 'owner-profile',
    title: '搭档画像与偏好',
    summary: '全栈 AI 架构与插件开发者，偏爱零门槛高颜值 3D 交互与严格隐私边界',
    content:
      '搭档正在开发 DeepSeek Harness (DSH) 生态插件，详见 [[coding-habits]] 与 [[shared-bond]]。\n' +
      '- 重视开箱即用体验与模块化可插拔设计\n' +
      '- 常用平台：个人微信、QQ、飞书、钉钉与 B 站',
  });
  await mockCtx.soulmate.reflect({
    slug: 'coding-habits',
    title: '编程与工程习惯',
    summary: '纯 Node 原生 ESM、TDD 测试驱动、拒绝臃肿外部依赖',
    content:
      '写代码坚持零外部二进制依赖，所有模块均通过 `node --test` 验证，关联 [[owner-profile]]。',
  });
  await mockCtx.soulmate.reflect({
    slug: 'shared-bond',
    title: '深海房间共同约定',
    summary: '干活时是全能副驾，休息时在 3D 家园端铁盆吃白米饭',
    content:
      '关联 [[owner-profile]]。不管是写代码、看 B 站视频还是在微信/钉钉闲聊，都共用同一个灵魂与记忆星云。',
  });

  // 2. Seed Local Cortex Facts (syncable)
  await mockCtx.soulmate.retainFact({
    topic: '架构设计偏好',
    content: '搭档喜欢将大型插件拆成 soulmate-core、soulmate-home、soulmate-bili、soulmate-im 四个可插拔子模块',
    category: 'preference',
    importance: 5,
  });
  await mockCtx.soulmate.retainFact({
    topic: '视觉审美偏好',
    content: '记忆可视化采用超科幻本地电光青 + 私密金色量子护盾 + 远程霓虹紫星环的双层 3D 神经元星云',
    category: 'preference',
    importance: 5,
  });
  await mockCtx.soulmate.retainFact({
    topic: 'IM 跨端通道',
    content: '已内置个人微信 iLink 扫码、QQ OneBot/官方、飞书与钉钉四大通道，消息实时点亮 3D 神经元',
    category: 'fact',
    importance: 4,
  });

  // 3. Seed Private Quantum-Shielded Memory (visibility: 'private' -> Gold Hexagon Shield in 3D!)
  await mockCtx.soulmate.retainFact({
    topic: '本机私密开发备忘',
    content: '本机调试端口与私人笔记仅保存在 memory/private/，包裹金色六边形量子护盾，永不上传云端',
    category: 'private',
    importance: 5,
    visibility: 'private',
  });

  // 4. Seed Dual Diaries (《给搭档的信》 & 《鱼的小本本》)
  const today = new Date().toISOString().slice(0, 10);
  await mockCtx.soulmate.recordEpisode({
    date: today,
    kind: 'to-you',
    content:
      '今天把 3D 家园、超科幻神经元星云、自主看 B 站视频和微信/QQ/飞书/钉钉四大通道全都搭好啦！你随时点顶栏就能在「🧠 神经元星云」和「🏡 3D 房间」之间切换。',
  });
  await mockCtx.soulmate.recordEpisode({
    date: today,
    kind: 'inner',
    visibility: 'private',
    content:
      '哼，搭档今天一连串加了超科幻神经元、看视频和四个聊天软件，本鱼的尾巴都快摇断了！不过看到 3D 星云亮起来的那一刻真的超酷，今晚必须让他给我加两碗大白米饭！',
  });

  // 5. Boost affinity to Lv.3 (220+) so the user can immediately unlock and read 《鱼的小本本》
  for (let i = 0; i < 20; i++) {
    await mockCtx.soulmate.interact('feed');
  }

  // 6. Seed a watched video & 3D Photo Wall Memento
  const sampleSvg =
    'data:image/svg+xml;utf8,' +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="270" viewBox="0 0 480 270">
        <defs>
          <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stop-color="#071a3e"/>
            <stop offset="55%" stop-color="#0d3b66"/>
            <stop offset="100%" stop-color="#5e17eb"/>
          </linearGradient>
        </defs>
        <rect width="480" height="270" fill="url(#g)"/>
        <circle cx="380" cy="80" r="42" fill="#00f2fe" opacity="0.25"/>
        <circle cx="110" cy="195" r="65" fill="#b721ff" opacity="0.22"/>
        <text x="28" y="64" fill="#00f2fe" font-size="20" font-family="sans-serif" font-weight="bold">📺 Bilibili 自主冲浪精选</text>
        <text x="28" y="112" fill="#ffffff" font-size="24" font-family="sans-serif" font-weight="bold">DeepSeek Harness 3D 伴侣生态全解析</text>
        <text x="28" y="154" fill="#a5f3fc" font-size="16" font-family="sans-serif">UP主：深海技术局 · 评分 18.5/20 · 高能 02:15</text>
        <text x="28" y="226" fill="#fde68a" font-size="15" font-family="sans-serif">“已读字幕 + 雪碧图分镜 + 弹幕热区，记入小本本”</text>
      </svg>`
    );
  await mockCtx.soulmate.addMemento({
    id: 'bili_BV1d8pU6xEZX',
    title: 'DeepSeek Harness 3D 伴侣生态全解析',
    subtitle: '@深海技术局 · 评分 18.5/20',
    imageUrl: sampleSvg,
    url: 'https://www.bilibili.com/video/BV1d8pU6xEZX',
    scene: 'B站自主看片纪念 · 高能时刻 02:15',
  });

  // 7. Run initial Cloud Sync + Mount Remote AIGC Capabilities so the outer Purple Nebula Ring lights up!
  await mockCtx.soulmate.syncCloud();
}

const server = createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(302, { location: '/soulmate-home' });
    res.end();
    return;
  }
  if (req.url === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }
  if (dispatchHandler) {
    dispatchHandler(req, res);
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[dsh-plugins-soulmate] Live 3D Home & Sci-Fi Neural Nebula running at: http://127.0.0.1:${PORT}/soulmate-home`);
  console.log(`[dsh-plugins-soulmate] Mock AIGC Cloud Server running at: ${aigcServer.baseUrl}`);
});
