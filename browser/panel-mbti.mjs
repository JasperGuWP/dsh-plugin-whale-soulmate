// MBTI scheme handlers for the persona settings page (kept out of panel.mjs for size).
const { api } = require('./util.mjs')
const {
  draftFromSummary,
  defaultAxesForType,
  mbtiToTraits,
  typeFromAxes,
  normalizeMbtiAxes,
} = require('./panel-draft.mjs')

const QUIZ_COOLDOWN_MS = 10_000

function setMbtiTypeOnDraft(d, type) {
  if (!d) return d
  const axes = defaultAxesForType(type)
  return Object.assign({}, d, { mbti: { type, axes }, traits: mbtiToTraits(type, axes) })
}

function setMbtiAxisOnDraft(d, axis, value) {
  if (!d) return d
  const axes = normalizeMbtiAxes(Object.assign({}, (d.mbti && d.mbti.axes) || {}, { [axis]: value }), d.mbti && d.mbti.type)
  const type = typeFromAxes(axes)
  return Object.assign({}, d, { mbti: { type, axes }, traits: mbtiToTraits(type, axes) })
}

/** Persist a five↔mbti switch immediately so server-side snapshots land. */
async function persistTraitSchemeSwitch(next, ctx) {
  const { draftRef, setDraft, setBusy, setNote, setSnap, draftSig, savedSigRef } = ctx
  const current = draftRef.current
  if (!current || current.traitScheme === next) return
  setBusy(true)
  setNote(next === 'mbti' ? '切换到 16型人格…' : '切换回五维…')
  try {
    const res = await api('persona-evolve', { mode: 'user_customize', traitScheme: next })
    if (res && res.ok === false) {
      setNote('切换失败：' + (res.error || '未知错误'))
      return
    }
    const nextDraft = draftFromSummary(res)
    setDraft(nextDraft)
    draftRef.current = nextDraft
    savedSigRef.current = draftSig(nextDraft)
    if (res && res.config) setSnap(res)
    setNote(next === 'mbti' ? '已开启 16型人格' : '已恢复五维滑杆')
  } catch (err) {
    setNote('切换失败：' + (err && err.message ? err.message : String(err)))
  } finally {
    setBusy(false)
  }
}

async function startPersonaQuizRequest() {
  return api('persona-quiz-start', {})
}

/** Wired from entry.mjs via ctx.uiWorkspace.openSession — real host navigation. */
let hostOpenSession = null
function setHostOpenSession(fn) {
  // Soft unbind (null) from Cordis child teardown must NOT wipe the binder —
  // toast/quiz clicks still need openSession after a transient inject recycle.
  if (typeof fn === 'function') hostOpenSession = fn
}

/**
 * Best-effort host navigation. Prefer the Cordis uiWorkspace binder; only return true
 * when a real API appears to succeed — bare CustomEvent dispatch is NOT proof.
 */
function tryOpenSessionClient(sessionId) {
  if (!sessionId || typeof window === 'undefined') return false
  const id = String(sessionId)
  if (typeof hostOpenSession === 'function') {
    try {
      const out = hostOpenSession(id)
      if (out && typeof out.then === 'function') out.catch(() => {})
      return true
    } catch (_) { /* fall through to probes */ }
  }
  const dsh = window.dsh || window.__dsh || window.__DSH__ || window.DeepSeekHarness
  const calls = []
  if (dsh) {
    if (typeof dsh.openSession === 'function') calls.push(() => dsh.openSession(id))
    if (typeof dsh.focusSession === 'function') calls.push(() => dsh.focusSession(id))
    if (typeof dsh.selectSession === 'function') calls.push(() => dsh.selectSession(id))
    if (dsh.sessions && typeof dsh.sessions.open === 'function') calls.push(() => dsh.sessions.open(id))
    if (dsh.sessions && typeof dsh.sessions.focus === 'function') calls.push(() => dsh.sessions.focus(id))
    if (typeof dsh.navigate === 'function') calls.push(() => dsh.navigate({ kind: 'session', sessionId: id }))
    if (dsh.router && typeof dsh.router.push === 'function') calls.push(() => dsh.router.push('/session/' + id))
  }
  for (const fn of calls) {
    try {
      const out = fn()
      if (out && typeof out.then === 'function') {
        out.catch(() => {})
        return true
      }
      // undefined/null from a real method still means "we invoked host API"
      return true
    } catch (_) { /* try next */ }
  }
  try {
    window.dispatchEvent(new CustomEvent('dsh:open-session', { detail: { sessionId: id } }))
  } catch (_) { /* ignore */ }
  return false
}

function traitsCardInputs(ctx) {
  const {
    draft, effective, setTrait, setTraitScheme, setMbtiType, setMbtiAxis,
    quizBusy, setQuizBusy, quizMsg, setQuizMsg, quizMsgKind, setQuizMsgKind, snap,
  } = ctx
  return {
    draft, effective, setTrait, setTraitScheme, setMbtiType, setMbtiAxis,
    onStartPersonaQuiz: createOnStartPersonaQuiz({
      quizBusy, setQuizBusy, setQuizMsg, setQuizMsgKind,
    }),
    quizBusy,
    quizName: (snap && snap.displayName) || draft.name || 'soulmate',
    quizMsg,
    quizMsgKind,
  }
}

function createOnStartPersonaQuiz(ctx) {
  const { quizBusy, setQuizBusy, setQuizMsg, setQuizMsgKind } = ctx
  return async () => {
    if (quizBusy) return
    setQuizBusy(true)
    setQuizMsgKind('')
    setQuizMsg('正在打开专属窗并投递开场…')
    let keepCool = true
    try {
      const res = await startPersonaQuizRequest()
      if (!res) {
        setQuizMsgKind('bad')
        setQuizMsg('开启失败：没有返回（请重启 DSH 后再试）')
        keepCool = false
        return
      }
      if (res.ok === false) {
        setQuizMsgKind('bad')
        setQuizMsg('开启失败：' + (res.error || '未知错误'))
        keepCool = false
        return
      }
      const name = res.displayName || 'soulmate'
      let opened = !!res.focused
      if (!opened && res.sessionId) {
        opened = tryOpenSessionClient(res.sessionId)
      }
      setQuizMsgKind('ok')
      if (opened) {
        setQuizMsg('已跳到「' + name + '消息」开始测验（她会先出题）。按钮冷却 10 秒。')
      } else {
        setQuizMsg('测验已投进专属窗。请点左侧「' + name + '消息」继续（她会先出题）。按钮冷却 10 秒。')
      }
    } catch (err) {
      setQuizMsgKind('bad')
      setQuizMsg('开启失败：' + (err && err.message ? err.message : String(err)))
      keepCool = false
    } finally {
      if (keepCool) {
        setQuizMsg((prev) => {
          const base = typeof prev === 'string' ? prev : ''
          return base.indexOf('冷却') >= 0 ? base : (base + '（冷却中）')
        })
        setTimeout(() => {
          setQuizBusy(false)
          setQuizMsg((prev) => {
            if (!prev) return prev
            return String(prev).replace(/（冷却中）/g, '').replace(/按钮冷却 10 秒。?/g, '').trim()
          })
        }, QUIZ_COOLDOWN_MS)
      } else {
        setQuizBusy(false)
      }
    }
  }
}

function buildPersonaEvolvePayload(current) {
  const payload = {
    mode: 'user_customize',
    name: current.name.trim(),
    callUser: current.callUser.trim(),
    selfRef: current.selfRef.trim(),
    customBody: current.customBody,
    preset: current.preset,
    traitScheme: current.traitScheme === 'mbti' ? 'mbti' : 'five',
    traits: current.traits,
  }
  if (current.gender === 'male' || current.gender === 'female') payload.gender = current.gender
  if (current.mbti) payload.mbti = current.mbti
  return payload
}

/** Poll /api/state while the traits tab is open so chat-side evolve refreshes MBTI UI. */
function useTraitsStatePoll(React, tab, load) {
  React.useEffect(() => {
    if (tab !== 'traits') return undefined
    const timer = setInterval(() => { load() }, 4000)
    return () => clearInterval(timer)
  }, [tab, load])
}

module.exports = {
  setMbtiTypeOnDraft,
  setMbtiAxisOnDraft,
  persistTraitSchemeSwitch,
  buildPersonaEvolvePayload,
  startPersonaQuizRequest,
  createOnStartPersonaQuiz,
  traitsCardInputs,
  tryOpenSessionClient,
  setHostOpenSession,
  useTraitsStatePoll,
  QUIZ_COOLDOWN_MS,
}
