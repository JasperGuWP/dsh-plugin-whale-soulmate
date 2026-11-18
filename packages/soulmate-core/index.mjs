// Soulmate core plugin (Node half): ctx.soulmate service, 14 model tools, dynamic persona
// system-prompt section and the local REST routes.
//
// This file is ONLY the assembler: it builds the per-apply runtime domains (runtime/),
// the tool tables (tools/) and the route tables (routes/), then registers everything
// through ctx.effect so disposing the plugin removes tools, prompt section, routes,
// timers and dynamically mounted cloud capabilities.
//
// Zero external runtime deps: `defineTool` lives in tool-kit.mjs (same approach as
// dsh-project-memory/memory-plugin.js) so a missing optional peer never breaks activation.
//
// Module map:
//   tool-kit / small-utils / tool-cards / plugin-config / http-plumbing / assets / persona-arcs
//     — pure helpers, no ctx, no I/O beyond what the caller hands in.
//   runtime/  — prompt engine, memory service, usage metering, chat-home delivery,
//               proactive scheduler, summary projection, home bootstrap.
//   tools/    — model tool definitions, grouped by domain.
//   routes/   — HTTP route tables, grouped by domain.

import { loadConfig, resolveSoulmateHome } from './state.mjs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSelfUpdate } from './runtime/self-update.mjs';
import { BILI_EXTENSION_ID } from '../soulmate-bili/index.mjs';
import { IM_EXTENSION_ID } from '../soulmate-im/index.mjs';
import { resolvePluginConfig } from './plugin-config.mjs';
import { errMsg } from './small-utils.mjs';
import { makeToolFactory } from './tool-cards.mjs';
import { mountHttp } from './http-plumbing.mjs';
import { createPetWindowRuntime } from './runtime/pet-window-runtime.mjs';
import { createCloudGateway } from './cloud-gateway.mjs';
import { createPromptEngine } from './runtime/prompt-engine.mjs';
import { createMemoryService } from './runtime/memory-service.mjs';
import { createUsageRuntime } from './runtime/usage-runtime.mjs';
import { createChatHomeRuntime } from './runtime/chat-home-runtime.mjs';
import { deliverViaPrompt } from './chat-home.mjs';
import { createProactiveRuntime } from './runtime/proactive-runtime.mjs';
import { createSummaryProvider } from './runtime/summary.mjs';
import { bootstrapHome } from './runtime/bootstrap.mjs';
import { buildTools } from './tools/index.mjs';
import { buildRoutes } from './routes/index.mjs';

export { defineTool } from './tool-kit.mjs';

export const name = 'dsh-plugin-whale-soulmate';
export const inject = ['tools', 'systemPrompt'];
export const CARD_KIND = 'dsh-plugins-soulmate';

export function apply(ctx, config = {}) {
  const cfg = resolvePluginConfig(config);
  const home = resolveSoulmateHome(cfg.homeDir || ctx);
  const gateway = createCloudGateway(home, cfg.fetch ? { fetch: cfg.fetch } : {});
  const warn = (msg, err) => {
    try {
      const logger = typeof ctx.logger === 'function' ? ctx.logger('soulmate') : ctx.logger;
      logger?.warn?.(msg, err ? errMsg(err) : '');
    } catch {
      // logging must never break the plugin
    }
  };

  /** Run `fn` inside ctx.effect and hand back the disposer it produced. */
  const track = (fn) => {
    let disposer;
    const wrapped = () => {
      disposer = fn();
      return disposer;
    };
    if (typeof ctx.effect === 'function') ctx.effect(wrapped);
    else wrapped();
    return disposer;
  };

  // ------------------------------------------------------------------ activity feed (3D shockwaves)
  const events = [];
  let eventSeq = 0;
  const pushEvent = (type, extra = {}) => {
    eventSeq += 1;
    events.push({ seq: eventSeq, type, at: new Date().toISOString(), ...extra });
    if (events.length > 60) events.splice(0, events.length - 60);
    return eventSeq;
  };

  // Host services are read lazily: they may appear a moment after apply() runs.
  // Cordis: never touch ctx.x unless inject declares it — on a live ctx (one with .get)
  // a direct read of an absent service goes through the service proxy and throws.
  // Bare/test hosts without .get expose services as plain properties instead.
  const optional = (name) => (typeof ctx.get === 'function' ? ctx.get(name) : ctx[name]);
  const sessionController = () => optional('sessionController');
  const getLlm = () => optional('llm');

  // ------------------------------------------------------------------ runtime domains
  const promptEngine = createPromptEngine({ home, warn, sessionController, pushEvent });
  track(() => () => promptEngine.dispose());

  // ensureHomeSession is needed by the memory service (persona-change window rotate),
  // while the chat-home runtime needs the memory service's metered calls — wire lazily.
  let chatHome = null;
  const ensureHomeSession = (options) => chatHome.ensureHomeSession(options);

  const memory = createMemoryService({
    home, gateway, cfg, promptEngine, pushEvent, warn, track,
    registerTool: (tool) => ctx.tools.register(tool),
    ensureHomeSession,
    sessionController,
  });

  const usage = createUsageRuntime({ home, cfg, warn, pushEvent, sessionController, getLlm });

  chatHome = createChatHomeRuntime({
    home, ctx, sessionController, promptEngine, pushEvent, warn,
    meteredCall: usage.meteredCall,
  });

  /** Put a request into the home DSH conversation; the agent there runs its own tools. */
  const askHomeAgent = async (text) => {
    const controller = sessionController();
    if (!controller || typeof controller.prompt !== 'function') {
      return { ok: false, error: 'no-prompt-api' };
    }
    const ensured = await chatHome.ensureHomeSession({
      seedAfterRotate: false,
      forceRotate: false,
      rotateIfFull: false,
    }).catch((err) => ({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    if (!ensured || !ensured.ok || !ensured.sessionId) {
      return { ok: false, error: (ensured && ensured.error) || 'no-chat-home' };
    }
    const res = await deliverViaPrompt(controller, {
      sessionId: ensured.sessionId,
      kind: 'user-request',
      visibleText: text,
    });
    return res && res.ok ? { ok: true, via: res.via || 'prompt' } : { ok: false, error: (res && res.reason) || 'prompt-rejected' };
  };
  // Mirror EVERY DSH conversation reply → activity feed → Windows toast.
  track(() => chatHome.startReplyToastWatch());

  const proactive = createProactiveRuntime({ home, warn, pushEvent, promptEngine, usage, chatHome, cfg });

  const getSummary = createSummaryProvider({ home, warn, promptEngine, memory, eventSeq: () => eventSeq });

  // ------------------------------------------------------------------ service surface (ctx.soulmate)
  let readyPromise = Promise.resolve();
  const service = {
    getPersonaPrompt: promptEngine.getPersonaPrompt,
    getState: memory.getState,
    interact: memory.interact,
    evolvePersona: memory.evolvePersona,
    resetPersona: memory.resetPersona,
    retainFact: memory.retainFact,
    recordEpisode: memory.recordEpisode,
    recall: memory.recall,
    reflect: memory.reflect,
    forget: memory.forget,
    promiseAction: memory.promiseAction,
    resolveConflict: memory.resolveConflict,
    presenceDigest: memory.presenceDigest,
    getNeuralGraph: memory.getNeuralGraph,
    getUsageSnapshot: usage.getUsageSnapshot,
    setUsageConfig: usage.setUsageConfig,
    syncCloud: memory.syncCloud,
    runProactiveTick: proactive.runProactiveTick,
    runBootGreeting: chatHome.runBootGreeting,
    runBootGreetingWithRetry: chatHome.runBootGreetingWithRetry,
    ensureHomeSession: chatHome.ensureHomeSession,
    chatHomeStatus: chatHome.chatHomeStatus,
    maybeCaptureSessionStars: chatHome.maybeCaptureSessionStars,
    noteChatHomeSession: chatHome.noteChatHomeSession,
    /** Test hook: allow a second boot greeting in-process. */
    resetBootGreetingFlag: chatHome.resetBootGreetingFlag,
    registerExtension: memory.registerExtension,
    addMemento: memory.addMemento,
    listMementos: memory.readMementos,
    mountCapabilities: memory.mountCapabilities,
    home,
    events: (sinceSeq = 0) => events.filter((e) => e.seq > sinceSeq),
    /** Resolves once the persona prompt cache (and home dir) has been initialised. */
    get ready() {
      return readyPromise;
    },
  };

  // ------------------------------------------------------------------ expose ctx.soulmate
  try {
    ctx.provide?.('soulmate');
  } catch {
    // service may already be declared by the host
  }
  track(() => {
    ctx.set?.('soulmate', service);
    try {
      ctx.soulmate = service;
    } catch {
      // read-only service slot on some hosts; ctx.set already covered it
    }
    return () => {
      try {
        if (ctx.soulmate === service) ctx.set?.('soulmate', undefined);
      } catch {
        // ignore teardown errors
      }
    };
  });

  // ------------------------------------------------------------------ persona system prompt section
  const section = {
    name: 'soulmate:persona',
    order: 12,
    // Host assemble(): `typeof text === 'function' ? text(ctx) : text`. Must be a
    // function so each chat turn marks pet activity (getter-only never ran).
    text: (sessionContext = {}) => {
      // Session id before touch: the think-watch reads it synchronously on start.
      const sessionId = sessionContext?.sessionId ?? sessionContext?.id;
      if (sessionId) promptEngine.setSessionId(sessionId);
      promptEngine.touchPetActivity({ context: sessionContext });
      return promptEngine.promptText;
    },
    /** Always-fresh variant for hosts that accept an async renderer. */
    render: (sessionContext) => promptEngine.getPersonaPrompt(sessionContext),
    refresh: promptEngine.refreshPrompt,
  };
  track(() => ctx.systemPrompt.section(section));

  // ------------------------------------------------------------------ home bootstrap (ready gate)
  readyPromise = bootstrapHome({ home, warn, refreshPrompt: promptEngine.refreshPrompt });

  // ------------------------------------------------------------------ drift anchor (runtime context)
  // The full persona sits at the very top of the context; after enough turns the model mostly
  // conditions on its own recent output and slides back to a neutral assistant voice. Runtime
  // context is the one channel DSH re-projects as a user-role snapshot near the history tail
  // (replacing the previous snapshot in place) whenever its rendered text changes — exactly the
  // slot a periodic re-anchor wants. Guarded because only newer hosts expose context().
  const driftAnchor = {
    name: 'soulmate:drift-anchor',
    order: 300,
    text: (context) => {
      // Do not touchPetActivity here: mid-turn re-anchors were restarting the think
      // watch and delaying eureka long after the answer already landed in chat.
      return promptEngine.renderDriftAnchor(context);
    },
  };
  if (typeof ctx.systemPrompt?.context === 'function') {
    track(() => ctx.systemPrompt.context(driftAnchor));
  }

  // ------------------------------------------------------------------ model tools
  const makeTool = makeToolFactory({ cardKind: CARD_KIND, ready: readyPromise });
  const toolDeps = {
    makeTool, service, memory, home, cfg, ctx, pushEvent, warn, track, getSummary,
    meteredCall: usage.meteredCall,
    oneShotLlm: usage.oneShotLlm,
    listHostModels: usage.listHostModels,
    get chatHome() { return chatHome; },
    promptEngine,
  };
  const toolSet = buildTools(toolDeps);
  for (const tool of toolSet.tools) {
    track(() => ctx.tools.register(Object.assign({}, tool, {
      execute: async (args) => {
        promptEngine.touchPetActivity();
        try {
          const out = await tool.execute(args);
          promptEngine.markPetRanCommand();
          return out;
        } catch (err) {
          promptEngine.markPetRanCommand();
          throw err;
        }
      },
    })));
  }

  // ------------------------------------------------------------------ extension cards
  toolSet.mountIm({ extensionId: IM_EXTENSION_ID });
  track(() =>
    service.registerExtension({
      id: BILI_EXTENSION_ID,
      name: '📺 自主看视频 (Bilibili)',
      description: '读字幕 / 分镜 / 弹幕高能 / 热评，自己记小本本、挂照片墙、长神经元；分享默认关闭且有限额。',
      version: '0.1.0',
      enabledWhen: (conf) => conf.extensions?.biliEnabled !== false,
    })
  );

  // ------------------------------------------------------------------ HTTP routes
  // 3D 家园（/soulmate-home）暂停开发：路由不挂载，代码保留在 soulmate-home/ 待重启。
  // ------------------------------------------------------------------ self-update
  // 定时对照打包源目录的最新 tarball;面板一键 pnpm add + 桌面端自重启。
  const selfUpdate = createSelfUpdate({
    getConfig: () => loadConfig(home),
    home,
    packageRoot: cfg.updatePackageRoot || join(dirname(fileURLToPath(import.meta.url)), '..', '..'),
    warn,
    spawnImpl: cfg.updateSpawnImpl,
    execPath: cfg.updateExecPath,
  });

  const routes = buildRoutes({
    selfUpdate,
    home,
    gateway,
    service,
    memory,
    getSummary,
    pushEvent,
    warn,
    events,
    eventSeq: () => eventSeq,
    promptText: () => promptEngine.promptText,
    evolveOrReset: toolSet.evolveOrReset,
    startPersonaQuiz: chatHome.startPersonaQuiz,
    runBootGreetingWithRetry: chatHome.runBootGreetingWithRetry,
    refreshPresence: promptEngine.refreshPresence,
    usage,
    proactive,
    chatHome,
    askHomeAgent,
    evolvePersona: memory.evolvePersona,
    video: { videoWatch: toolSet.videoWatch, videoSurf: toolSet.videoSurf, videoShare: toolSet.videoShare, biliAuthManage: toolSet.biliAuthManage },
    imNet: toolSet.imNet,
  });

  /** Mount HTTP routes once webServer is ACTIVE. One-shot `ctx.get` races the host boot
   *  (strict get returns undefined while the webServer fiber is still starting) and leaves
   *  the floating widget on empty 404 → `Unexpected end of JSON input` / 「未连接」. */
  if (typeof ctx.inject === 'function') {
    // Child fork: parent soulmate fiber stays active on headless hosts; routes appear
    // as soon as webServer becomes available (and tear down if it goes away).
    track(() =>
      ctx.inject(['webServer'], (webCtx) => mountHttp(webCtx.webServer ?? webCtx.get?.('webServer'), { routes, ready: readyPromise, warn }))
    );
  } else {
    const webServer = typeof ctx.get === 'function' ? ctx.get('webServer') : ctx.webServer;
    if (webServer) track(() => mountHttp(webServer, { routes, ready: readyPromise, warn }));
    else warn('webServer unavailable — HTTP routes not mounted (widget will show 未连接)');
  }

  // ------------------------------------------------------------------ desktop window pet (config-gated)
  // 独立透明窗口形态:与页内 widget 共用同一套浏览器引擎与路由,开关 pet.windowEnabled。
  const petWindow = createPetWindowRuntime({
    home, routes, ready: readyPromise, warn,
    // host 级注入(测试/嵌入宿主用);用户配置走 pet.windowElectronPath
    spawnImpl: cfg.petWindowSpawnImpl, electronPath: cfg.petWindowElectronPath,
  });
  petWindow.begin();
  // track 会立即执行 fn 取 disposer:这里返回 dispose 函数本身, teardown 时才调用
  track(() => petWindow.dispose);
  selfUpdate.begin();
  track(() => selfUpdate.dispose);

  // ------------------------------------------------------------------ background auto-sync (consent-gated)
  if (cfg.autoSync) {
    track(() => {
      let busy = false;
      const timer = setInterval(async () => {
        if (busy) return;
        busy = true;
        try {
          const conf = await loadConfig(home);
          if (conf.cloud.consentGiven === true && conf.cloud.enabled === true) await service.syncCloud();
        } catch (err) {
          warn('auto sync failed', err);
        } finally {
          busy = false;
        }
      }, cfg.syncIntervalSec * 1000);
      timer.unref?.();
      return () => clearInterval(timer);
    });
  }

  // ------------------------------------------------------------------ proactive scheduler (local only)
  //
  // One tick per `proactiveIntervalSec`. The gate itself is the rate limiter (daily quota +
  // per-kind gap), so a frequent tick is cheap and keeps the greeting close to its slot
  // without waking the process faster than the design's quietest window.
  if (cfg.proactive !== false) {
    track(() => {
      let busy = false;
      const timer = setInterval(async () => {
        if (busy) return;
        busy = true;
        try {
          await proactive.runProactiveTick(Date.now());
        } catch (err) {
          warn('proactive tick failed', err);
        } finally {
          busy = false;
        }
      }, Math.max(30, Number(cfg.proactiveIntervalSec) || 120) * 1000);
      timer.unref?.();
      return () => clearInterval(timer);
    });
  }

  // ------------------------------------------------------------------ boot greeting (once per process)
  //
  // Delayed + retried: sessionController / default model often are not ready at first tick.
  // Content is AI-authored via sessionController.prompt into the dedicated soulmate window.
  track(() => {
    const timer = setTimeout(() => {
      readyPromise
        .then(() => chatHome.runBootGreetingWithRetry({ delaysMs: [0, 4000, 10000] }))
        .catch((err) => warn('boot greeting failed', err));
    }, 3500);
    timer.unref?.();
    return () => clearTimeout(timer);
  });
}
