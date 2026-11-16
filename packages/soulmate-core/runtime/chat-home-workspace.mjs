// Workspace attach for the dedicated companion window:「{人设名}消息」grouping
// plus the handoff distillation writer. Split out of chat-home-runtime.mjs to
// keep every runtime module under the 600-line ceiling.

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { appendJsonl, loadConfig } from '../state.mjs';
import { getDisplayName } from '../persona.mjs';
import { loadFacts, recordEpisode as recordEpisodeImpl, retainFact as retainFactImpl } from '../memory-engine.mjs';
import { errMsg } from '../small-utils.mjs';

const str = (v) => (v == null ? '' : String(v));

/** Case-insensitive path compare (Windows); strip trailing separators. */
function pathsEqual(a, b) {
  const norm = (p) => str(p).replace(/[/\\]+$/, '').toLowerCase();
  const x = norm(a);
  const y = norm(b);
  return Boolean(x && y && x === y);
}

export function createChatHomeWorkspace({ home, ctx, pushEvent, warn }) {
  const logWarn = typeof warn === 'function' ? warn : () => {};

  /** Sidebar group title follows the persona name set in the panel, e.g.「小海消息」. */
  const chatHomeWorkspaceTitle = async () => {
    try {
      const conf = await loadConfig(home);
      const name = getDisplayName(conf.persona).trim() || 'soulmate';
      return `${name}消息`;
    } catch {
      return '鱼消息';
    }
  };

  const workspaceRegistry = () => {
    if (typeof ctx.get === 'function') {
      const viaGet = ctx.get('workspaceRegistry');
      if (viaGet) return viaGet;
    }
    return ctx.workspaceRegistry;
  };

  /**
   * Find or create the durable「{人设名}消息」workspace rooted at plugin-sessions.
   * Never falls back to an unrelated project workspace (that spilled sessions into「未分组」
   * or into「agent」/「AIProjects」).
   */
  const ensureChatHomeWorkspace = async () => {
    const reg = workspaceRegistry();
    if (!reg || typeof reg.list !== 'function') return null;
    const pluginDir = home?.rootDir ? join(home.rootDir, 'plugin-sessions') : '';
    if (!pluginDir) return null;
    await mkdir(pluginDir, { recursive: true });

    const wantTitle = await chatHomeWorkspaceTitle();
    const list = typeof reg.list === 'function' ? reg.list() : [];
    const workspaces = Array.isArray(list) ? list : [];

    let found = workspaces.find((w) => pathsEqual(w?.path, pluginDir)) || null;
    if (!found) {
      found = workspaces.find((w) => {
        const t = str(w?.title).trim();
        return t === wantTitle || t === '插件消息';
      }) || null;
    }

    if (!found && typeof reg.create === 'function') {
      try {
        const created = await reg.create(pluginDir, wantTitle);
        found = created?.id ? created : (created?.workspace || created);
        // Some hosts return a view `{ id }` rather than the live entity — re-list.
        if (!found?.attachSession) {
          const again = Array.isArray(reg.list?.()) ? reg.list() : [];
          found = again.find((w) => pathsEqual(w?.path, pluginDir) || str(w?.id) === str(found?.id)) || found;
        }
      } catch (err) {
        logWarn('chat-home workspace create failed', err);
        return null;
      }
    }

    if (!found?.id) return null;

    if (str(found.title).trim() !== wantTitle && typeof found.setTitle === 'function') {
      try { await found.setTitle(wantTitle); } catch (err) {
        logWarn('chat-home workspace rename failed', err);
      }
    }

    return { workspace: found, workspaceId: str(found.id), pluginDir, title: wantTitle };
  };

  /**
   * Attach dedicated sessions into「{人设名}消息」. Host requires session cwd to match
   * the workspace path — our creates always use that path via workspaceId, and existing
   * soulmate sessions already live under plugin-sessions.
   */
  const attachSessionsToChatHome = async (sessionIds = []) => {
    const ids = [...new Set((Array.isArray(sessionIds) ? sessionIds : []).map((id) => str(id).trim()).filter(Boolean))];
    if (!ids.length) return { ok: true, attached: [], skipped: [], failed: [] };

    const ensured = await ensureChatHomeWorkspace();
    if (!ensured?.workspace) return { ok: false, reason: 'no-workspace', attached: [], skipped: [], failed: ids };

    const ws = ensured.workspace;
    const members = new Set(
      (Array.isArray(ws.sessionIds) ? ws.sessionIds : []).map((id) => str(id).trim()).filter(Boolean),
    );
    const attached = [];
    const skipped = [];
    const failed = [];

    for (const id of ids) {
      if (members.has(id)) {
        skipped.push(id);
        continue;
      }
      if (typeof ws.attachSession !== 'function') {
        failed.push(id);
        continue;
      }
      try {
        await ws.attachSession(id);
        attached.push(id);
        members.add(id);
      } catch (err) {
        failed.push(id);
        logWarn(`chat-home attach ${id} failed`, err);
      }
    }

    if (attached.length) {
      pushEvent('chat-home-workspace-attach', {
        workspaceId: ensured.workspaceId,
        title: ensured.title,
        attached,
        skipped: skipped.length,
        failed: failed.length,
      });
    }

    return { ok: failed.length === 0, workspaceId: ensured.workspaceId, attached, skipped, failed };
  };

  /**
   * Create-request for sessionController.create: always the dedicated workspace.
   * Empty object means "no workspace yet" — never point at an unrelated project folder.
   */
  const resolveChatHomeCreateRequest = async () => {
    try {
      const ensured = await ensureChatHomeWorkspace();
      if (ensured?.workspaceId) return { workspaceId: ensured.workspaceId };
    } catch (err) {
      logWarn('chat-home resolve create request failed', err);
    }
    return {};
  };

  /**
   * Handoff distillation when the dedicated window is full: diary + high-weight fact.
   * Shared memory (not the old transcript) keeps the next window familiar.
   */
  const runHandoffDistill = async (summary, meta = {}) => {
    const content = String(summary || '').trim();
    if (!content) return { ok: false, reason: 'empty' };
    const episode = await recordEpisodeImpl(home, {
      kind: 'to-you',
      title: '专属窗交接',
      content: content.slice(0, 4000),
      source: 'handoff',
      sessionId: meta.fromSessionId || null,
    }).catch((err) => ({ ok: false, error: errMsg(err) }));
    // Roll handoff facts forward: supersede the previous active「专属窗交接」
    // so timestamp-heavy excerpts never park a 保留新/旧 conflict.
    let supersedesId = '';
    try {
      const { pub, priv } = await loadFacts(home);
      const prev = [...pub, ...priv].find(
        (f) => String(f.topic || '') === '专属窗交接' && !f.invalidatedAt && !f.deletedAt,
      );
      if (prev?.id) supersedesId = prev.id;
    } catch { /* degrade: retain without supersede */ }
    const fact = await retainFactImpl(home, {
      topic: '专属窗交接',
      content: content.slice(0, 800),
      importance: 4,
      source: 'handoff',
      sessionId: meta.fromSessionId || null,
      ...(supersedesId ? { supersedesId } : {}),
    }).catch((err) => ({ ok: false, error: errMsg(err) }));
    pushEvent('chat-home-handoff', {
      from: meta.fromSessionId || '',
      reason: meta.reason || '',
      episodeOk: episode?.ok === true,
      factOk: fact?.ok === true,
    });
    await appendJsonl(home.proactiveLogPath, {
      at: new Date().toISOString(),
      kind: 'handoff',
      speak: false,
      reason: meta.reason || 'rotate',
      fromSessionId: meta.fromSessionId || '',
      delivered: 'memory',
    }).catch(() => {});
    return { ok: episode?.ok === true || fact?.ok === true, episode, fact };
  };

  return {
    chatHomeWorkspaceTitle,
    ensureChatHomeWorkspace,
    attachSessionsToChatHome,
    resolveChatHomeCreateRequest,
    runHandoffDistill,
  };
}
