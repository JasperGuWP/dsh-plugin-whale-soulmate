import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, utimesSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createPrefsReader,
  installQqModelSync,
  normalizeSelection,
  parseModelPrefs,
  pickLatestDesktopSelection,
  sameSelection,
  selectionFromSummary,
  syncAgentModel,
} from '../packages/soulmate-core/qqbot-model-sync.mjs'

const PREFS = JSON.stringify({
  sessionIds: {
    'qqbot:123:c2c:peer-a': 'session-a',
    'qqbot:123:group:group-a': 'session-b',
  },
  overrides: {
    'qqbot:123:c2c:peer-a': { provider: 'qq-provider', model: 'qq-model' },
  },
})

function fakeAgent(id, current) {
  const calls = []
  return {
    id,
    calls,
    model: {
      current: () => current,
      select: (selection) => calls.push(selection),
    },
  }
}

function summary(sessionId, updatedAt, selection, extra = {}) {
  return {
    sessionId,
    updatedAt,
    projections: {
      values: {
        modelSelection: { lastUsed: selection, next: selection },
      },
    },
    ...extra,
  }
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve))
}

test('parseModelPrefs maps session ids and only valid overrides', () => {
  const prefs = parseModelPrefs(PREFS)
  assert.equal(prefs.sessionIdToKey.get('session-a'), 'qqbot:123:c2c:peer-a')
  assert.equal(prefs.sessionIdToKey.get('session-b'), 'qqbot:123:group:group-a')
  assert.ok(prefs.overrides.has('qqbot:123:c2c:peer-a'))
  assert.equal(prefs.overrides.size, 1)
})

test('parseModelPrefs tolerates empty or malformed shapes', () => {
  for (const raw of ['{}', 'null', '[]', '{"sessionIds":[],"overrides":"x"}']) {
    const prefs = parseModelPrefs(raw)
    assert.equal(prefs.sessionIdToKey.size, 0)
    assert.equal(prefs.overrides.size, 0)
  }
  assert.throws(() => parseModelPrefs('{'), SyntaxError)
})

test('normalizeSelection requires provider and model and keeps effort', () => {
  assert.deepEqual(
    normalizeSelection({ provider: 'p', model: 'm', reasoningEffort: 'high' }),
    { provider: 'p', model: 'm', reasoningEffort: 'high' },
  )
  assert.deepEqual(normalizeSelection({ provider: 'p', model: 'm', reasoningEffort: '' }), { provider: 'p', model: 'm' })
  assert.equal(normalizeSelection({ provider: '', model: 'm' }), undefined)
  assert.equal(normalizeSelection({ provider: 'p' }), undefined)
  assert.equal(normalizeSelection(null), undefined)
})

test('sameSelection compares effort as well as route', () => {
  assert.ok(sameSelection({ provider: 'p', model: 'm' }, { provider: 'p', model: 'm' }))
  assert.ok(!sameSelection({ provider: 'p', model: 'm', reasoningEffort: 'high' }, { provider: 'p', model: 'm' }))
  assert.ok(!sameSelection(null, { provider: 'p', model: 'm' }))
})

test('sync follows the latest DSH selection including reasoning effort', () => {
  const prefs = parseModelPrefs(JSON.stringify({
    sessionIds: { 'qqbot:123:c2c:peer-a': 'session-a' },
  }))
  const agent = fakeAgent('session-a', { provider: 'old', model: 'old-model' })
  const result = syncAgentModel(agent, prefs, {
    provider: 'deepseek-official',
    model: 'deepseek-v4.1-flash-1017',
    reasoningEffort: 'max',
  })
  assert.equal(result, 'synced')
  assert.deepEqual(agent.calls, [{
    provider: 'deepseek-official',
    model: 'deepseek-v4.1-flash-1017',
    reasoningEffort: 'max',
  }])
})

test('sync never overrides a QQ /model preference', () => {
  const prefs = parseModelPrefs(PREFS)
  const agent = fakeAgent('session-a', { provider: 'qq-provider', model: 'qq-model' })
  const result = syncAgentModel(agent, prefs, { provider: 'ds', model: 'latest' })
  assert.equal(result, 'override')
  assert.deepEqual(agent.calls, [])
})

test('sync ignores sessions that are not QQ peers and equal selections', () => {
  const prefs = parseModelPrefs(PREFS)
  const desktop = fakeAgent('desktop-session', { provider: 'ds', model: 'latest' })
  assert.equal(syncAgentModel(desktop, prefs, { provider: 'ds', model: 'latest' }), 'skip')
  assert.deepEqual(desktop.calls, [])

  const qq = fakeAgent('session-b', { provider: 'ds', model: 'latest' })
  assert.equal(syncAgentModel(qq, prefs, { provider: 'ds', model: 'latest' }), 'same')
  assert.deepEqual(qq.calls, [])
})

test('sync skips safely when prefs or the host selection are unavailable', () => {
  const agent = fakeAgent('session-b', { provider: 'old', model: 'old' })
  assert.equal(syncAgentModel(agent, null, { provider: 'ds', model: 'latest' }), 'skip')
  assert.equal(syncAgentModel(agent, parseModelPrefs(PREFS), undefined), 'skip')
  assert.deepEqual(agent.calls, [])
})

test('summary selection uses the pending choice before the last used one', () => {
  const pending = { provider: 'new', model: 'next', reasoningEffort: 'max' }
  const last = { provider: 'old', model: 'previous' }
  assert.deepEqual(selectionFromSummary({
    projections: { values: { modelSelection: { lastUsed: last, next: pending } } },
  }), pending)
  assert.deepEqual(selectionFromSummary({
    projections: { values: { modelSelection: { lastUsed: last, next: null } } },
  }), last)
  assert.equal(selectionFromSummary({ projections: { values: {} } }), undefined)
})

test('latest desktop selection ignores QQ peers, subagents, and newer blank rows', () => {
  const prefs = parseModelPrefs(PREFS)
  const picked = pickLatestDesktopSelection([
    summary('session-a', 500, { provider: 'qq', model: 'wrong' }),
    summary('session-child', 400, { provider: 'child', model: 'wrong' }, { origin: 'subagent' }),
    summary('session-empty', 300, null),
    summary('session-desktop', 200, {
      provider: 'deepseek-official',
      model: 'deepseek-v4.1-flash-1017',
      reasoningEffort: 'max',
    }),
  ], prefs)
  assert.deepEqual(picked, {
    sessionId: 'session-desktop',
    at: 200,
    selection: {
      provider: 'deepseek-official',
      model: 'deepseek-v4.1-flash-1017',
      reasoningEffort: 'max',
    },
  })
})

test('prefs reader caches by mtime and size, then picks up changes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-prefs-'))
  const file = join(dir, 'model-prefs.json')
  try {
    writeFileSync(file, JSON.stringify({ sessionIds: { 'qqbot:1:c2c:a': 's1' } }))
    const read = createPrefsReader(file)
    assert.equal(read().sessionIdToKey.get('s1'), 'qqbot:1:c2c:a')

    writeFileSync(file, JSON.stringify({ sessionIds: { 'qqbot:1:c2c:a': 's2' } }))
    const future = new Date(Date.now() + 5000)
    utimesSync(file, future, future)
    assert.equal(read().sessionIdToKey.get('s2'), 'qqbot:1:c2c:a')
    assert.equal(read().sessionIdToKey.has('s1'), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('install listens before each step claim and survives a broken prefs file', async () => {
  const handlers = new Map()
  const warnings = []
  const ctx = {
    logger: { debug: () => {}, warn: (message) => warnings.push(message) },
    get: () => undefined,
    on: (name, handler) => {
      handlers.set(name, handler)
      return () => handlers.delete(name)
    },
  }

  const agent = fakeAgent('session-a', { provider: 'old', model: 'old' })
  const uninstall = installQqModelSync(ctx, {
    prefsPath: join(tmpdir(), 'qqbot-prefs-missing.json'),
  })
  await tick()
  assert.equal(typeof handlers.get('agent/inbox/claimed'), 'function')
  assert.equal(typeof handlers.get('session/event'), 'function')
  handlers.get('agent/inbox/claimed')({ agent })
  assert.deepEqual(agent.calls, [])
  assert.deepEqual(warnings, [])

  uninstall()
  assert.equal(handlers.has('agent/inbox/claimed'), false)
  assert.equal(handlers.has('session/event'), false)
})

test('install follows the Session selection instead of the profile default', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-sync-'))
  const file = join(dir, 'model-prefs.json')
  try {
    writeFileSync(file, JSON.stringify({ sessionIds: { 'qqbot:1:c2c:a': 'session-a' } }))
    const handlers = new Map()
    const warnings = []
    const ctx = {
      logger: { debug: () => {}, warn: (message) => warnings.push(message) },
      get: (name) => name === 'agentDefaultModel'
        ? { currentSelection: () => ({ provider: 'qwen-token-plan-cn', model: 'deepseek-v4.1-flash-1017' }) }
        : undefined,
      on: (name, handler) => {
        handlers.set(name, handler)
        return () => handlers.delete(name)
      },
    }
    installQqModelSync(ctx, {
      prefsPath: file,
      listSessions: async () => ({
        items: [summary('session-desktop', 10, {
          provider: 'deepseek-official',
          model: 'deepseek-v4.1-flash-1017',
          reasoningEffort: 'max',
        })],
      }),
    })
    await tick()

    const agent = fakeAgent('session-a', { provider: 'old', model: 'old' })
    handlers.get('agent/inbox/claimed')({ agent })
    assert.deepEqual(agent.calls, [{
      provider: 'deepseek-official',
      model: 'deepseek-v4.1-flash-1017',
      reasoningEffort: 'max',
    }])

    const qqSession = {
      id: 'session-a',
      header: {},
    }
    handlers.get('session/event')(qqSession, {
      type: 'model/selection',
      time: 30,
      data: { provider: 'qq-only', model: 'must-not-win' },
    })
    handlers.get('session/event')({ id: 'session-desktop-2', header: {} }, {
      type: 'model/selection',
      time: 20,
      data: { provider: 'desktop-new', model: 'latest-picked', reasoningEffort: 'high' },
    })
    handlers.get('agent/inbox/claimed')({ agent })
    assert.deepEqual(agent.calls[1], {
      provider: 'desktop-new',
      model: 'latest-picked',
      reasoningEffort: 'high',
    })

    const broken = {
      id: 'session-a',
      get model() { throw new Error('boom') },
    }
    handlers.get('agent/inbox/claimed')({ agent: broken })
    handlers.get('agent/inbox/claimed')({ agent: broken })
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /model sync skipped: boom/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a live selection is not overwritten by an older startup scan', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-live-'))
  const file = join(dir, 'model-prefs.json')
  try {
    writeFileSync(file, JSON.stringify({ sessionIds: { 'qqbot:1:c2c:a': 'session-a' } }))
    const handlers = new Map()
    let finishScan
    const ctx = {
      logger: { debug: () => {}, warn: () => {} },
      get: () => undefined,
      on: (name, handler) => {
        handlers.set(name, handler)
        return () => handlers.delete(name)
      },
    }
    const uninstall = installQqModelSync(ctx, {
      prefsPath: file,
      listSessions: () => new Promise((resolve) => { finishScan = resolve }),
    })
    handlers.get('session/event')({ id: 'session-live', header: {} }, {
      type: 'model/selection',
      time: 100,
      data: { provider: 'live', model: 'chosen-now' },
    })
    await tick()
    finishScan({ items: [summary('session-old', 10, { provider: 'old', model: 'stale' })] })
    await tick()

    const agent = fakeAgent('session-a', { provider: 'before', model: 'before' })
    handlers.get('agent/inbox/claimed')({ agent })
    assert.deepEqual(agent.calls, [{ provider: 'live', model: 'chosen-now' }])
    uninstall()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('startup scan calls the host Session list with only an abort signal', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-list-'))
  const file = join(dir, 'model-prefs.json')
  try {
    writeFileSync(file, JSON.stringify({ sessionIds: { 'qqbot:1:c2c:a': 'session-a' } }))
    const handlers = new Map()
    const received = []
    const ctx = {
      logger: { debug: () => {}, warn: () => {} },
      get: (name) => (name === 'sessionController'
        ? {
            list: async (...args) => {
              received.push(args)
              return [summary('session-desktop', 10, { provider: 'picked', model: 'from-list' })]
            },
          }
        : undefined),
      on: (name, handler) => {
        handlers.set(name, handler)
        return () => handlers.delete(name)
      },
    }
    const uninstall = installQqModelSync(ctx, { prefsPath: file })
    await tick()
    await tick()

    assert.equal(received.length, 1)
    assert.equal(received[0].length, 1)
    assert.ok(received[0][0] instanceof AbortSignal)
    assert.equal(received[0][0].aborted, false)

    const agent = fakeAgent('session-a', { provider: 'old', model: 'old' })
    handlers.get('agent/inbox/claimed')({ agent })
    assert.deepEqual(agent.calls, [{ provider: 'picked', model: 'from-list' }])
    uninstall()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('startup scan retries until sessionController is mounted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-late-'))
  const file = join(dir, 'model-prefs.json')
  try {
    writeFileSync(file, JSON.stringify({ sessionIds: { 'qqbot:1:c2c:a': 'session-a' } }))
    const handlers = new Map()
    let probes = 0
    const ctx = {
      logger: { debug: () => {}, warn: () => {} },
      get: (name) => {
        if (name !== 'sessionController') return undefined
        probes++
        return probes >= 3
          ? { list: async () => [summary('session-desktop', 10, { provider: 'late', model: 'mounted' })] }
          : undefined
      },
      on: (name, handler) => {
        handlers.set(name, handler)
        return () => handlers.delete(name)
      },
    }
    const uninstall = installQqModelSync(ctx, { prefsPath: file, retryMs: 5 })
    await new Promise((resolve) => setTimeout(resolve, 60))

    const agent = fakeAgent('session-a', { provider: 'old', model: 'old' })
    handlers.get('agent/inbox/claimed')({ agent })
    assert.deepEqual(agent.calls, [{ provider: 'late', model: 'mounted' }])
    uninstall()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
