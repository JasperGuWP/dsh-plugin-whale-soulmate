// Keep QQ conversations on the model the user last picked in a DSH conversation.
//
// The official QQ plugin binds a per-peer session to a DSH session and can
// record a model of its own. DSH's loop, however, freezes the model at the
// start of each step; changing the desktop picker later does not reach an
// already-created QQ session. `agent/inbox/claimed` fires synchronously just
// before that freeze, so syncing there makes the next step use the latest
// desktop choice without copying any of the official session logic.
//
// The source is the selected Session's `modelSelection` projection, not the
// profile default. A live `model/selection` event updates the tracker at once;
// on startup, the Session list supplies the latest persisted projection.
//
// A QQ `/model` override stays authoritative: when model-prefs.json has an
// override for the peer, this module never touches the session model.
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'

export function defaultPrefsPath() {
  return resolve(homedir(), '.dsh-qqbot', 'model-prefs.json')
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Parse the official plugin's preference file into lookup tables. */
export function parseModelPrefs(raw) {
  const data = JSON.parse(raw)
  const sessionIdToKey = new Map()
  const overrides = new Set()
  if (!isRecord(data)) return { sessionIdToKey, overrides }

  if (isRecord(data.sessionIds)) {
    for (const [key, sessionId] of Object.entries(data.sessionIds)) {
      if (key && typeof sessionId === 'string' && sessionId) sessionIdToKey.set(sessionId, key)
    }
  }
  if (isRecord(data.overrides)) {
    for (const [key, route] of Object.entries(data.overrides)) {
      if (!key || !isRecord(route)) continue
      if (typeof route.provider === 'string' && route.provider
        && typeof route.model === 'string' && route.model) {
        overrides.add(key)
      }
    }
  }
  return { sessionIdToKey, overrides }
}

/**
 * Read the preference file, reusing the last parse while its mtime and size
 * are unchanged. A missing or malformed file yields null so callers can skip.
 */
export function createPrefsReader(file) {
  let stamp
  let cached = null
  return function readPrefs() {
    try {
      const stat = statSync(file)
      const nextStamp = `${stat.mtimeMs}:${stat.size}`
      if (cached !== null && stamp === nextStamp) return cached
      const parsed = parseModelPrefs(readFileSync(file, 'utf8'))
      stamp = nextStamp
      cached = parsed
      return parsed
    } catch {
      stamp = undefined
      cached = null
      return null
    }
  }
}

/** Accept only a complete provider/model selection from the host service. */
export function normalizeSelection(value) {
  if (!isRecord(value)) return undefined
  if (typeof value.provider !== 'string' || !value.provider) return undefined
  if (typeof value.model !== 'string' || !value.model) return undefined
  return {
    provider: value.provider,
    model: value.model,
    ...(typeof value.reasoningEffort === 'string' && value.reasoningEffort
      ? { reasoningEffort: value.reasoningEffort }
      : {}),
  }
}

export function sameSelection(left, right) {
  if (!left || !right) return false
  return left.provider === right.provider
    && left.model === right.model
    && (left.reasoningEffort ?? '') === (right.reasoningEffort ?? '')
}

/** Read the model selection carried by one Session-list summary. */
export function selectionFromSummary(summary) {
  const projection = summary?.projections?.values?.modelSelection
  if (!isRecord(projection)) return undefined
  return normalizeSelection(projection.next ?? projection.lastUsed)
}

function excludesSummary(summary, qqSessionIds) {
  const sessionId = typeof summary?.sessionId === 'string' ? summary.sessionId : ''
  if (!sessionId || qqSessionIds.has(sessionId)) return true
  if (summary.origin === 'subagent' || summary.parentSessionId !== undefined) return true
  return false
}

/**
 * Pick the newest ordinary desktop Session that carries a recorded selection.
 * QQ-bound and subagent Sessions are not a source for the QQ model.
 */
export function pickLatestDesktopSelection(summaries, prefs) {
  if (!Array.isArray(summaries) || !prefs) return undefined
  const ordered = [...summaries].sort(
    (left, right) => (Number(right?.updatedAt) || 0) - (Number(left?.updatedAt) || 0),
  )
  for (const summary of ordered) {
    if (excludesSummary(summary, prefs.sessionIdToKey)) continue
    const selection = selectionFromSummary(summary)
    if (!selection) continue
    return {
      selection,
      sessionId: summary.sessionId,
      at: Number(summary.updatedAt) || 0,
    }
  }
  return undefined
}

/**
 * Keep the newest selection seen from a live Session event. A startup scan is
 * accepted only when no live selection arrived while the scan was running.
 */
export function createLatestSelectionTracker(readPrefs) {
  let latest
  let version = 0

  const isExcludedSession = (session, prefs) => {
    if (!session || typeof session.id !== 'string') return true
    if (prefs.sessionIdToKey.has(session.id)) return true
    const header = session.header
    return header?.origin === 'subagent' || header?.parentSession !== undefined
  }

  return {
    observe(session, event) {
      if (event?.type !== 'model/selection') return
      const prefs = readPrefs()
      if (!prefs || isExcludedSession(session, prefs)) return
      const selection = normalizeSelection(event.data)
      if (!selection) return
      latest = {
        selection,
        sessionId: session.id,
        at: Number(event.time) || Date.now(),
      }
      version++
    },
    beginScan() {
      return version
    },
    seed(candidate, scanVersion) {
      if (!candidate || scanVersion !== version) return false
      latest = candidate
      return true
    },
    current() {
      if (!latest) return undefined
      const prefs = readPrefs()
      if (!prefs || prefs.sessionIdToKey.has(latest.sessionId)) return undefined
      return latest.selection
    },
    currentSession() {
      if (!latest) return undefined
      const prefs = readPrefs()
      if (!prefs || prefs.sessionIdToKey.has(latest.sessionId)) return undefined
      return latest.sessionId
    },
  }
}

/**
 * Apply the latest host selection to one QQ agent.
 * @returns why the model was left alone, or "synced".
 */
export function syncAgentModel(agent, prefs, latest, logger) {
  if (!agent || typeof agent.id !== 'string' || !prefs) return 'skip'
  const sessionKey = prefs.sessionIdToKey.get(agent.id)
  if (sessionKey === undefined) return 'skip'
  if (prefs.overrides.has(sessionKey)) return 'override'

  const selection = normalizeSelection(latest)
  if (!selection) return 'skip'
  const model = agent.model
  if (!model || typeof model.select !== 'function') return 'skip'

  let current
  try {
    current = typeof model.current === 'function' ? model.current() : undefined
  } catch {
    current = undefined
  }
  if (sameSelection(current, selection)) return 'same'

  model.select(selection)
  logger?.debug?.(`im-qqbot: synced ${sessionKey} to ${selection.provider}/${selection.model}`
    + `${selection.reasoningEffort ? ` (${selection.reasoningEffort})` : ''}`)
  return 'synced'
}

/**
 * Install the lightweight sync on a Cordis context.
 * @returns a disposer that removes both listeners.
 */
export function installQqModelSync(ctx, options = {}) {
  const logger = options.logger ?? ctx.logger
  const readPrefs = options.readPrefs ?? createPrefsReader(options.prefsPath ?? defaultPrefsPath())
  const tracker = options.tracker ?? createLatestSelectionTracker(readPrefs)
  const cancellation = new AbortController()
  let warned = false

  const sync = (agent) => {
    try {
      const latest = tracker.current()
      syncAgentModel(agent, readPrefs(), latest, logger)
    } catch (error) {
      // A model sync failure must never break the QQ turn it was preparing.
      if (!warned) {
        warned = true
        logger?.warn?.(`im-qqbot: model sync skipped: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  const offSelection = ctx.on('session/event', (session, event) => {
    try {
      tracker.observe(session, event)
    } catch (error) {
      if (!warned) {
        warned = true
        logger?.warn?.(`im-qqbot: selection tracking skipped: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }, { global: true })
  const offClaimed = ctx.on('agent/inbox/claimed', ({ agent }) => sync(agent))

  const scanVersion = tracker.beginScan()
  const retryMs = options.retryMs ?? 250
  const retryLimit = options.retryLimit ?? 60

  // sessionController is mounted later than this plugin, so the first few
  // probes return undefined while the loader is still activating services.
  const listOnce = async () => {
    if (typeof options.listSessions === 'function') {
      return options.listSessions(cancellation.signal)
    }
    for (let attempt = 0; attempt < retryLimit; attempt++) {
      if (cancellation.signal.aborted) return undefined
      const controller = ctx.get?.('sessionController')
      if (typeof controller?.list === 'function') {
        return controller.list(cancellation.signal)
      }
      await new Promise((resolveDelay) => {
        const timer = setTimeout(resolveDelay, retryMs)
        timer.unref?.()
      })
    }
    return undefined
  }

  Promise.resolve().then(listOnce).then((result) => {
    if (result === undefined) return
    const summaries = Array.isArray(result) ? result : result?.items
    const candidate = pickLatestDesktopSelection(summaries, readPrefs())
    tracker.seed(candidate, scanVersion)
  }).catch((error) => {
    if (!cancellation.signal.aborted) {
      logger?.debug?.(`im-qqbot: selection scan skipped: ${error instanceof Error ? error.message : String(error)}`)
    }
  })

  return () => {
    cancellation.abort()
    offSelection?.()
    offClaimed?.()
  }
}
