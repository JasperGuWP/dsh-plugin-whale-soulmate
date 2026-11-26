// Scheduled Bilibili patrol: one read-only surf round on the auto-surf interval,
// with her persona-authored engage (comment/like/fav/follow/coin behind quotas).
// Extracted from proactive-runtime to keep the tick file under the 600-line ceiling.

import { appendJsonl, loadConfig, saveConfigAuto } from '../state.mjs';
import { shouldAutoSurf } from '../proactive.mjs';
import { runAutonomousSurfRound } from '../../soulmate-bili/index.mjs';
import { createHostVisionSummarize } from '../../soulmate-bili/host-vision.mjs';
import { refreshSurfKeywords, mergeSurfKeywords } from '../../soulmate-bili/keyword-learn.mjs';
import { clampSurfMaxPick, resolveSurfIntervalMinutes } from '../surf-schedule.mjs';
import { errMsg } from '../small-utils.mjs';
import { createBiliLlmAdapters } from './bili-llm-adapter.mjs';

export function createSurfRuntime({ home, warn, pushEvent, usage, chatHome, cfg, getService }) {
  const { oneShotLlm, listHostModels } = usage;
  const biliLlm = createBiliLlmAdapters({ home, usage });

  // Scheduled Bilibili patrol: read-only surf round on the auto-surf interval.
  // Watching writes local notes + seen ledger only; sharing / writes stay opt-in elsewhere.
  async function runAutoSurfIfDue({ conf, tz, at }) {
    const ext = conf.extensions ?? {};
    const decision = shouldAutoSurf({
      nowMs: at,
      tzOffsetMinutes: tz,
      config: { ...ext, quietHours: conf.proactive?.quietHours ?? [] },
      lastAutoSurfAt: ext.lastAutoSurfAt ?? '',
    });
    if (!decision.surf) return { ok: true, ran: false, reason: decision.reason };
    const maxPick = clampSurfMaxPick(ext.biliAutoSurfMaxPick, resolveSurfIntervalMinutes(ext));
    const deepWatch = ext.biliAutoSurfDeepWatch === true;
    let keywordsRefresh = null;
    try {
      keywordsRefresh = await refreshSurfKeywords(home, {
        nowMs: at,
        oneShotLlm,
        listHostModels,
        sessionController: typeof chatHome.getSessionController === 'function'
          ? chatHome.getSessionController
          : undefined,
      });
    } catch (err) {
      warn('surf keyword refresh failed', err);
      keywordsRefresh = { ok: false, error: errMsg(err) };
    }
    const live = await loadConfig(home).catch(() => conf);
    const kwExt = live?.extensions ?? ext;
    const keywords = mergeSurfKeywords(
      kwExt.biliKeywordsSeed?.length ? kwExt.biliKeywordsSeed : kwExt.biliKeywords,
      kwExt.biliLearnedKeywords,
    );
    let res;
    try {
      const llmController = typeof chatHome.getSessionController === 'function'
        ? chatHome.getSessionController()
        : null;
      const visionSummarize = createHostVisionSummarize({
        controller: llmController,
        chatHome,
        fetchImpl: cfg?.biliFetch,
        model: live?.extensions?.biliVisionModel || '',
        soulmateRoot: home?.rootDir || '',
        warn,
      });
      // Comments authored in character from her watch notes; heuristic keeps the action flags.
      const decideEngage = biliLlm.decideEngageFor(live?.extensions);
      // watchAndRecordVideo needs the ctx.soulmate service (retainFact/interact/mementos);
      // a bare { home } makes every watch throw and the round silently pick 0.
      const service = typeof getService === 'function' ? getService() : null;
      if (!service || typeof service.retainFact !== 'function') {
        throw new Error('[soulmate] auto-surf unavailable: ctx.soulmate service not ready');
      }
      res = await runAutonomousSurfRound(
        service,
        {
          maxPick,
          deepWatch,
          keywords,
          ...(decideEngage ? { decideEngage } : {}),
          ...(cfg?.biliFetch ? { fetchImpl: cfg.biliFetch } : {}),
          ...(cfg?.biliBaseUrl ? { baseUrl: cfg.biliBaseUrl } : {}),
          ...(llmController ? { llmController } : {}),
          ...(visionSummarize ? { visionSummarize } : {}),
          judgeOneShot: oneShotLlm,
        }
      );
    } catch (err) {
      res = { ok: false, error: errMsg(err) };
    }
    // Stamp the attempt even on failure so a broken network cannot retry every tick.
    await saveConfigAuto(home, { extensions: { lastAutoSurfAt: new Date(at).toISOString() } });
    await appendJsonl(home.proactiveLogPath, {
      at: new Date(at).toISOString(),
      dateKey: decision.dateKey,
      kind: 'auto-surf',
      speak: false,
      reason: decision.reason,
      delivered: res.ok ? ((res.pickedCount ?? 0) > 0 ? 'watched' : (res.heldCount ?? 0) > 0 ? 'needs-consent' : 'no-picks') : 'failed',
      picked: res.pickedCount ?? 0,
      held: res.heldCount ?? 0,
      ...(res.error ? { error: res.error } : {}),
      ...(res.ok && (res.pickedCount ?? 0) === 0 && res.errors?.length ? { errors: res.errors.slice(0, 5) } : {}),
      keywordsChanged: keywordsRefresh?.changed === true,
      keywords: Array.isArray(keywordsRefresh?.keywords) ? keywordsRefresh.keywords.slice(0, 8) : undefined,
    }).catch((err) => warn('auto-surf ledger append failed', err));
    if (res.ok && (res.pickedCount ?? 0) > 0) {
      pushEvent('video-surf', {
        auto: true,
        deepWatch,
        pickedCount: res.pickedCount,
        keywords: Array.isArray(keywords) ? keywords.slice(0, 8) : undefined,
        videos: (res.videos || []).filter((v) => v.ok).slice(0, 3).map((v) => (
          deepWatch
            ? { title: v.title, worthScore: v.worthScore, depth: v.coverage?.depth, howIWatched: v.howIWatched }
            : { title: v.title, worthScore: v.worthScore }
        )),
      });
    }
    if (res.ok && (res.heldCount ?? 0) > 0) {
      pushEvent('bili-consent', {
        count: res.heldCount,
        items: (res.pendingConsent || []).slice(0, 3).map((x) => ({
          bvid: x.bvid,
          title: x.title,
          durationSec: x.durationSec,
        })),
      });
    }
    return {
      ok: res.ok !== false,
      ran: true,
      picked: res.pickedCount ?? 0,
      held: res.heldCount ?? 0,
      reason: decision.reason,
      error: res.error,
      keywordsRefresh,
      // Full ok-videos for the intent layer (video-found opportunities); the pushEvent
      // above stays a trimmed preview for toasts.
      surfVideos: (res.videos || []).filter((v) => v && v.ok).slice(0, 3),
    };
  }

  return { runAutoSurfIfDue };
}
