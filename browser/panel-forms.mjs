// Editable settings forms (称呼与预设 / 自进化边界 / 五维滑杆 / 形象与桌宠).
const React = require('react')
const h = React.createElement
const {
  TRAIT_LABELS,
  MBTI_TYPES,
  MBTI_AXES,
  MBTI_AXIS_LABELS,
  MBTI_BLURBS,
} = require('./panel-draft.mjs')
const { companionPronoun, api } = require('./util.mjs')
const { paintBalloonMini } = require('./balloon-sprite.mjs')
const { field, BUNDLED_LOOKS, skinFrameUrl, lookPetCard } = require('./panel-pet.mjs')
const { AsrSettings } = require('./panel-asr.mjs')

/** Hint under «真看抽帧»: only surfaces blockers (login / missing ffmpeg with a download link). */
function LiveFrameReadyHint() {
  const [status, setStatus] = React.useState(null)
  const [asking, setAsking] = React.useState(false)
  const [askHint, setAskHint] = React.useState('')
  React.useEffect(() => {
    let alive = true
    api('bili/auth').then((s) => { if (alive && s && s.ok !== false) setStatus(s) }).catch(() => {})
    return () => { alive = false }
  }, [])
  const askDownload = React.useCallback(async () => {
    if (asking) return
    setAsking(true)
    setAskHint('')
    try {
      const res = await api('ffmpeg-download', {})
      if (!res || res.ok === false) setAskHint((res && res.error) || '请求发送失败')
      else setAskHint('已请 DSH 在对话里下载 ffmpeg，装好后把路径填到下面。')
    } catch (err) {
      setAskHint(err && err.message ? err.message : '请求发送失败')
    } finally {
      setAsking(false)
    }
  }, [asking])
  if (!status) return null
  if (!status.loggedIn) {
    return h('p', { className: 'sm-panel-muted' }, '登录 B 站后才能抽真实帧。')
  }
  if (!status.ffmpegReady) {
    return h('p', { className: 'sm-panel-muted' }, [
      h('span', { key: 't' }, '未检测到 ffmpeg'),
      h('button', {
        key: 'd', type: 'button', className: 'sm-link', disabled: asking,
        onClick: askDownload,
      }, asking ? '正在请求…' : '下载 ffmpeg'),
      askHint ? h('span', { key: 'h', style: { marginLeft: 6, opacity: 0.85 } }, askHint) : null,
    ])
  }
  return null
}

/** Settings-page gender pick: same inflated ♂/♀ balloons as onboarding (not flat circles). */
function GenderBalloonBtn({ gender, selected, label, onClick }) {
  const ref = React.useRef(null)
  React.useEffect(() => {
    if (ref.current) paintBalloonMini(ref.current, gender)
  }, [gender])
  return h('button', {
    type: 'button',
    className: 'sm-gender-balloon ' + gender + (selected ? ' on' : ''),
    title: label,
    'aria-label': '选择' + label,
    'aria-pressed': String(!!selected),
    onClick,
  }, [
    h('canvas', { key: 'cv', ref, width: 156, height: 156, className: 'sm-gender-balloon-cv' }),
    h('span', { key: 'lb', className: 'sm-gender-balloon-label' }, label),
  ])
}

/** Collapsible preset group; remounts open state when current gender changes. */
function PresetGenderFold({ genderKey, currentGender, label, presets, draftPreset, onPick }) {
  const [open, setOpen] = React.useState(() => currentGender === genderKey)
  React.useEffect(() => {
    setOpen(currentGender === genderKey)
  }, [currentGender, genderKey])
  return h('details', {
    className: 'sm-preset-fold',
    open,
    onToggle: (event) => setOpen(event.currentTarget.open),
  }, [
    h('summary', { key: 's' }, label),
    h('div', { key: 'chips', className: 'sm-chips' }, presets.map((preset) => h('button', {
      key: preset.id,
      type: 'button',
      className: 'sm-chip' + (draftPreset === preset.id ? ' on' : ''),
      onClick: () => onPick(preset),
    }, [
      (preset.emoji ? preset.emoji + ' ' : '') + (preset.name || preset.id),
      preset.defaultCallUser ? h('small', { key: 'small' }, '叫你「' + preset.defaultCallUser + '」') : null,
    ]))),
  ])
}

function identityCard(view) {
  const { draft, presets, activePreset, patchPersona, choosePreset, switchGender } = view
  const gender = draft.gender === 'male' || draft.gender === 'female' ? draft.gender : null
  const pronoun = companionPronoun(gender).third
  const female = presets.filter((p) => p.gender === 'female')
  const male = presets.filter((p) => p.gender === 'male')

  function pickPreset(nextGender, preset) {
    if (gender === nextGender) choosePreset(preset)
    else if (switchGender) switchGender(nextGender, preset)
  }

  return h('div', { key: 'identity', className: 'sm-panel-card' }, [
    h('h3', { key: 'h', className: 'sm-panel-h3' }, '称呼与预设'),
    h('div', { key: 'gender-pick', className: 'sm-gender-pick' }, [
      h(GenderBalloonBtn, {
        key: 'male',
        gender: 'male',
        label: '男生',
        selected: gender === 'male',
        onClick: () => {
          if (gender !== 'male' && switchGender) switchGender('male')
        },
      }),
      h(GenderBalloonBtn, {
        key: 'female',
        gender: 'female',
        label: '女生',
        selected: gender === 'female',
        onClick: () => {
          if (gender !== 'female' && switchGender) switchGender('female')
        },
      }),
    ]),
    h('div', { key: 'row', className: 'sm-panel-row' }, [
      field('name', '名字（留空就是「鱼」）', h('input', {
        key: 'control', className: 'sm-panel-input', maxLength: 12, placeholder: '鱼',
        value: draft.name, onChange: (event) => patchPersona({ name: event.target.value }),
      })),
      field('callUser', pronoun + '怎么叫你', h('input', {
        key: 'control', className: 'sm-panel-input', maxLength: 12, placeholder: '搭档',
        value: draft.callUser, onChange: (event) => patchPersona({ callUser: event.target.value }),
      })),
      field('selfRef', pronoun + '的自称', h('input', {
        key: 'control', className: 'sm-panel-input', maxLength: 12, placeholder: '我',
        value: draft.selfRef, onChange: (event) => patchPersona({ selfRef: event.target.value }),
      })),
    ]),
    h(PresetGenderFold, {
      key: 'fold-female',
      genderKey: 'female',
      currentGender: gender,
      label: '♀ 女生性格',
      presets: female,
      draftPreset: draft.preset,
      onPick: (preset) => pickPreset('female', preset),
    }),
    h(PresetGenderFold, {
      key: 'fold-male',
      genderKey: 'male',
      currentGender: gender,
      label: '♂ 男生性格',
      presets: male,
      draftPreset: draft.preset,
      onPick: (preset) => pickPreset('male', preset),
    }),
    activePreset && activePreset.description
      ? h('div', { key: 'body', className: 'sm-preset-body' }, [
        h('p', { key: 'desc' }, activePreset.description),
        Array.isArray(activePreset.catchphrases) && activePreset.catchphrases.length
          ? h('ul', { key: 'phrases' }, activePreset.catchphrases.map((line, i) => h('li', { key: i }, line)))
          : null,
      ])
      : null,
    field('customBody', '自定义补充（会盖过预设正文）', h('textarea', {
      key: 'control',
      className: 'sm-panel-textarea',
      rows: 5,
      maxLength: 2000,
      placeholder: '例如：说话更短、先给结论；讨厌废话；记得用「搭档」叫我……',
      value: draft.customBody || '',
      onChange: (event) => patchPersona({ customBody: event.target.value }),
    })),
    null,
  ])
}

function gateCard({ gateBudget, pending, traitScheme, gender }) {
  const mbtiOn = traitScheme === 'mbti'
  const pp = companionPronoun(gender === 'male' || gender === 'female' ? gender : null).third
  return h('div', { key: 'gate', className: 'sm-panel-card' }, [
    h('h3', { key: 'h', className: 'sm-panel-h3' }, pp + '自己改性格的限度'),
    h('p', { key: 'p', className: 'sm-panel-muted' }, mbtiOn
      ? '你点选的 16 型随时生效。' + pp + '自己想微调时，每次最多改一点，每周也有上限。'
      : '你拖滑杆随时生效。' + pp + '自己想微调时，每次最多改一点，每周也有上限。'),
    h('div', { key: 'row', className: 'sm-eng-budget' }, [].concat(
      Object.keys(TRAIT_LABELS).map((key) => {
        const used = gateBudget && gateBudget.used ? Math.abs(Number(gateBudget.used[key]) || 0) : 0
        const meta = TRAIT_LABELS[key]
        return h('div', {
          key,
          className: 'sm-eng-budget-row',
          title: meta[0] + '：本周已用 ' + used + '/15',
        }, [
          h('span', null, meta[0]),
          h('i', null, h('b', { style: { width: Math.min(100, (used / 15) * 100) + '%' } })),
          h('span', null, used + '/15'),
        ])
      })
    )),
    pending > 0
      ? h('p', { key: 'pend', className: 'sm-panel-muted' },
        '有 ' + pending + ' 条性格申请在排队，观察够了才会真正改。')
      : h('p', { key: 'pend', className: 'sm-panel-muted' }, '暂时没有' + pp + '自己提出的性格申请。'),
  ])
}

function fiveTraitRows({ draft, effective, setTrait }) {
  return h('div', { key: 'rows' }, Object.keys(TRAIT_LABELS).map((key) => {
    const meta = TRAIT_LABELS[key]
    const eff = Number(effective[key])
    const delta = Number.isFinite(eff) ? Math.round(eff) - draft.traits[key] : 0
    return h('div', { key, className: 'sm-trait', title: meta[1] }, [
      h('span', { key: 'label', title: meta[1] }, meta[0]),
      h('input', {
        key: 'input',
        type: 'range',
        min: 0,
        max: 100,
        step: 1,
        value: draft.traits[key],
        title: meta[1] + ' 当前 ' + draft.traits[key],
        onChange: (event) => setTrait(key, Number(event.target.value)),
      }),
      h('b', {
        key: 'value',
        title: delta
          ? '基础 ' + draft.traits[key] + ' · 此刻 ' + Math.round(eff) + '（含临时微调）'
          : '当前 ' + draft.traits[key],
      }, String(draft.traits[key]) + (delta ? (delta > 0 ? ' +' + delta : ' ' + delta) : '')),
    ])
  }))
}

function mbtiTraitPanel({ draft, setMbtiType, setMbtiAxis }) {
  const mbti = draft.mbti || { type: 'INFP', axes: { EI: 75, SN: 75, TF: 75, JP: 75 } }
  const current = mbti.type || 'INFP'
  const blurb = MBTI_BLURBS[current] || ''
  return h('div', { key: 'mbti' }, [
    null,
    h('div', { key: 'grid', className: 'sm-mbti-grid' }, MBTI_TYPES.map((type) => h('button', {
      key: type,
      type: 'button',
      className: 'sm-mbti-cell' + (current === type ? ' on' : ''),
      title: MBTI_BLURBS[type] || type,
      onClick: () => setMbtiType(type),
    }, type))),
    h('p', { key: 'blurb', className: 'sm-mbti-blurb' }, blurb),
    h('div', { key: 'axes' }, MBTI_AXES.map((axis) => {
      const labels = MBTI_AXIS_LABELS[axis]
      const value = Number(mbti.axes && mbti.axes[axis])
      const v = Number.isFinite(value) ? value : 50
      return h('div', { key: axis, className: 'sm-trait sm-mbti-axis', title: labels[0] + ' ⇄ ' + labels[1] }, [
        h('span', { key: 'label' }, labels[0]),
        h('input', {
          key: 'input',
          type: 'range',
          min: 0,
          max: 100,
          step: 1,
          value: v,
          title: labels[0] + ' ' + (100 - v) + ' · ' + labels[1] + ' ' + v,
          onChange: (event) => setMbtiAxis(axis, Number(event.target.value)),
        }),
        h('b', { key: 'value' }, labels[1] + ' ' + v),
      ])
    })),
  ])
}

function traitsCard({ draft, effective, setTrait, setTraitScheme, setMbtiType, setMbtiAxis, onStartPersonaQuiz, quizBusy, quizName, quizMsg, quizMsgKind }) {
  const scheme = draft.traitScheme === 'mbti' ? 'mbti' : 'five'
  const name = quizName || 'soulmate'
  const quizLabel = quizBusy
    ? (quizMsg && String(quizMsg).indexOf('冷却') >= 0 ? '冷却中…' : '正在启动…')
    : ('测你想要' + name + '是什么人格')
  return h('div', { key: 'traits', className: 'sm-panel-card' }, [
    h('h3', { key: 'h', className: 'sm-panel-h3' },
      scheme === 'mbti' ? '性格 · 16 型人格' : '性格 · 五维滑杆'),
    h('div', { key: 'scheme-row', className: 'sm-scheme-row' }, [
      h('label', { key: 'scheme', className: 'sm-scheme-toggle' }, [
        h('input', {
          key: 'i',
          type: 'checkbox',
          checked: scheme === 'mbti',
          onChange: (event) => setTraitScheme(event.target.checked ? 'mbti' : 'five'),
        }),
        h('span', { key: 't' }, '用 16 型人格'),
      ]),
      scheme === 'mbti'
        ? h('button', {
            key: 'quiz',
            type: 'button',
            className: 'sm-mbti-quiz-btn',
            disabled: !!quizBusy,
            title: '在专属对话里一问一答，确认后才写入',
            onClick: (event) => {
              if (event && event.preventDefault) event.preventDefault()
              if (event && event.stopPropagation) event.stopPropagation()
              if (onStartPersonaQuiz) onStartPersonaQuiz()
            },
          }, quizLabel)
        : null,
    ]),
    scheme === 'mbti' && quizMsg
      ? h('p', {
        key: 'quiz-msg',
        className: 'sm-mbti-quiz-msg' + (quizMsgKind === 'bad' ? ' bad' : quizMsgKind === 'ok' ? ' ok' : ''),
      }, quizMsg)
      : null,
    scheme === 'mbti'
      ? mbtiTraitPanel({ draft, setMbtiType, setMbtiAxis })
      : fiveTraitRows({ draft, effective, setTrait }),
    h('p', { key: 'note', className: 'sm-panel-muted' }, (() => {
      const g = draft && (draft.gender === 'male' || draft.gender === 'female') ? draft.gender : null
      const pp = companionPronoun(g).third
      return scheme === 'mbti'
        ? '你改的类型马上生效；' + pp + '自己想变性格会先进申请，不会直接改字母。'
        : '你拖滑杆马上生效；' + pp + '自己想变性格会先进申请。'
    })()),
  ])
}

/** 专属窗 session 星图自动写入开关（作息与主动页）。 */
function chatHomeAutoMemoryChecks({ homeDraft, patchChatHome }) {
  return [
    h('label', { key: 'automem', className: 'sm-rhythm-check' }, [
      h('input', {
        key: 'i', type: 'checkbox', checked: homeDraft.autoMemory !== false,
        onChange: (event) => patchChatHome({ autoMemory: event.target.checked }),
      }),
      h('span', { key: 't' }, '专属窗自动记星'),
    ]),
    null,
  ]
}

/** Parse interest keywords; English `,` / Chinese `，` / `、` / whitespace all work. */
function parseInterestKeywords(text) {
  return String(text || '').split(/[,，、\s]+/).map((s) => s.trim()).filter(Boolean)
}

/** Local draft so typing a trailing comma is not immediately eaten by array→join. */
function AutoSurfKeywords({ keywords, onCommit }) {
  const joined = (keywords || []).join('，')
  const [text, setText] = React.useState(joined)
  const [focused, setFocused] = React.useState(false)
  React.useEffect(() => {
    if (!focused) setText(joined)
  }, [joined, focused])
  return h('label', { className: 'sm-field', style: { display: 'block', marginTop: 6 } }, [
    h('span', { key: 'l' }, '兴趣关键词（中英文逗号、顿号或空格均可）'),
    h('input', {
      key: 'i', type: 'text', className: 'sm-input', style: { width: '100%', marginTop: 4 },
      value: text,
      placeholder: '例如：AI、科技、编程、数码、生活（中英文逗号、顿号或空格均可）',
      onFocus: () => setFocused(true),
      onChange: (event) => setText(event.target.value),
      onBlur: () => {
        setFocused(false)
        const next = parseInterestKeywords(text)
        setText(next.join('，'))
        if (onCommit) onCommit(next)
      },
      onKeyDown: (event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          event.currentTarget.blur()
        }
      },
    }),
    h('p', { key: 'tip', className: 'sm-panel-muted', style: { marginTop: 4 } },
      '英文逗号 , 或中文逗号 ，都行；失焦或回车后生效。'),
  ])
}

/** 定时自动冲浪：间隔 + 每次数量 + 兴趣关键词，只读看片，不写 B 站。 */
function autoSurfSection({ draft, patchExtensions }) {
  const {
    SURF_INTERVAL_MINUTES,
    resolveSurfIntervalMinutes,
    maxPickCapForInterval,
    clampSurfMaxPick,
    formatSurfIntervalLabel,
    surfIntervalIndex,
  } = require('./surf-schedule.mjs')
  const ext = draft.extensions || {}
  const intervalMin = resolveSurfIntervalMinutes(ext)
  const intervalIdx = surfIntervalIndex(intervalMin)
  const pickCap = maxPickCapForInterval(intervalMin)
  const pickValue = clampSurfMaxPick(ext.biliAutoSurfMaxPick, intervalMin)
  return [
    h('label', { key: 'autosurf-on', className: 'sm-rhythm-check' }, [
      h('input', {
        key: 'i', type: 'checkbox', checked: !!ext.biliAutoSurfEnabled,
        onChange: (event) => patchExtensions && patchExtensions({ biliAutoSurfEnabled: event.target.checked }),
      }),
      h('span', { key: 't' }, '定时自动刷 B 站（按兴趣自己看片、记小本本；互动由下方开关决定）'),
    ]),
    ext.biliAutoSurfEnabled ? h('div', { key: 'autosurf-knobs', className: 'sm-autosurf-knobs' }, [
      field('autosurf-every', '每 ' + formatSurfIntervalLabel(intervalMin) + ' 巡一圈', h('input', {
        key: 'control', type: 'range', min: 0, max: SURF_INTERVAL_MINUTES.length - 1, step: 1,
        value: intervalIdx,
        onChange: (event) => {
          const minutes = SURF_INTERVAL_MINUTES[Number(event.target.value)] || 360
          const nextCap = maxPickCapForInterval(minutes)
          const nextPick = clampSurfMaxPick(ext.biliAutoSurfMaxPick, minutes)
          patchExtensions({
            biliAutoSurfEveryMinutes: minutes,
            biliAutoSurfEveryHours: minutes / 60,
            biliAutoSurfMaxPick: Math.min(nextPick, nextCap),
          })
        },
      })),
      field(
        'autosurf-pick',
        '每次看 ' + pickValue + ' 个（本档最多 ' + pickCap + '）',
        h('input', {
          key: 'control', type: 'range', min: 1, max: pickCap, step: 1,
          value: pickValue,
          onChange: (event) => patchExtensions({
            biliAutoSurfMaxPick: clampSurfMaxPick(event.target.value, intervalMin),
          }),
        }),
      ),
      h('label', {
        key: 'autosurf-deep',
        className: 'sm-rhythm-check',
        title: '开启后：周期巡片拉更多分镜（约 36 帧）+ 更长字幕摘录，并记录 coverage 深度。这是「读字幕/分镜消化」，不是像人一样把整段视频播完。无字幕或字幕乱码时仍可能达不到 solid/deep。关闭则快速扫标题与少量分镜。',
      }, [
        h('input', {
          key: 'i', type: 'checkbox', checked: !!ext.biliAutoSurfDeepWatch,
          onChange: (event) => patchExtensions({ biliAutoSurfDeepWatch: event.target.checked }),
        }),
        h('span', { key: 't' }, '认真看完（加深字幕/分镜消化）'),
      ]),
      h('label', {
        key: 'vision-summary',
        className: 'sm-rhythm-check',
        title: '用当前聊天的多模态模型看画面帧（真帧优先，否则分镜），再综合标题/简介/字幕写时间线。接不通模型或无帧时软降级。',
      }, [
        h('input', {
          key: 'i', type: 'checkbox',
          checked: ext.biliVisionSummary !== false,
          onChange: (event) => patchExtensions({ biliVisionSummary: event.target.checked }),
        }),
        h('span', { key: 't' }, '画面理解总结（用聊天多模态模型）'),
      ]),
      h('label', {
        key: 'live-frame',
        className: 'sm-rhythm-check',
        title: '登录 B 站后用本机 ffmpeg 从播放流抽真实画面帧（最密每 15 秒一帧）。未安装 ffmpeg 时不会抽帧，仅提示；画面总结可改用分镜。',
      }, [
        h('input', {
          key: 'i', type: 'checkbox', checked: !!ext.biliLiveFrameWatch,
          onChange: (event) => patchExtensions({ biliLiveFrameWatch: event.target.checked }),
        }),
        h('span', { key: 't' }, '真看抽帧（需登录 + 本机 ffmpeg）'),
      ]),
      (ext.biliVisionSummary !== false || ext.biliLiveFrameWatch) ? field(
        'live-frame-every',
        '看片/总结密度：每 ' + (ext.biliLiveFrameEverySec || 30) + ' 秒一帧（最密 15 秒，送模最多 16 帧）',
        h('input', {
          key: 'control',
          type: 'range',
          min: 0,
          max: 6,
          step: 1,
          value: (() => {
            const presets = [15, 20, 30, 45, 60, 90, 120]
            const cur = Number(ext.biliLiveFrameEverySec) || 30
            let best = 2
            let bestDiff = Infinity
            presets.forEach((p, i) => {
              const d = Math.abs(p - cur)
              if (d < bestDiff) { best = i; bestDiff = d }
            })
            return best
          })(),
          onChange: (event) => {
            const presets = [15, 20, 30, 45, 60, 90, 120]
            const sec = presets[Number(event.target.value)] || 30
            patchExtensions({ biliLiveFrameEverySec: sec })
          },
        }),
      ) : null,
      ext.biliLiveFrameWatch ? h(LiveFrameReadyHint, { key: 'live-hint' }) : null,
      h(AsrSettings, { key: 'asr-settings', ext, patchExtensions }),
      ext.biliVisionSummary !== false ? null : null,
      h('label', {
        key: 'autosurf-popular',
        className: 'sm-rhythm-check',
        title: '每轮先看综合热门/首页推荐/排行榜的头部（最多占一半名额），再按兴趣搜索前几补位；关键词被风控（412）时热门也能凑满「每次看 N 个」。',
      }, [
        h('input', {
          key: 'i', type: 'checkbox',
          checked: ext.biliSurfIncludePopular !== false,
          onChange: (event) => patchExtensions({ biliSurfIncludePopular: event.target.checked }),
        }),
        h('span', { key: 't' }, '看热门/首页推荐前几（每轮优先，占一半名额）'),
      ]),
      h('label', {
        key: 'autosurf-deep-judge',
        className: 'sm-rhythm-check',
        title: '每支视频初扫后，把「值不值得认真看完」交给带人设的 Agent 判断；判定值得且初扫没看够的，会在 DSH 里用更密画面帧 + 更长字幕按人设看第二遍并写全片评价。每片至多二刷一次，会多花一些模型用量。',
      }, [
        h('input', {
          key: 'i', type: 'checkbox',
          checked: ext.biliSurfDeepJudge !== false,
          onChange: (event) => patchExtensions({ biliSurfDeepJudge: event.target.checked }),
        }),
        h('span', { key: 't' }, '细看裁决（Agent 按人设决定要不要认真看完）'),
      ]),
      field('autosurf-search-order', '兴趣搜索排序（取每个词的前几条）', h('select', {
        key: 'control',
        className: 'sm-panel-input',
        value: ['totalrank', 'pubdate', 'click'].includes(ext.biliSurfSearchOrder) ? ext.biliSurfSearchOrder : 'totalrank',
        onChange: (event) => patchExtensions({ biliSurfSearchOrder: event.target.value }),
      }, [
        h('option', { key: 'totalrank', value: 'totalrank' }, '综合排序（同网页搜索，最相关）'),
        h('option', { key: 'pubdate', value: 'pubdate' }, '最新发布（容易全是刚上传的长尾）'),
        h('option', { key: 'click', value: 'click' }, '最多播放（容易冲上过时老爆款）'),
      ])),
      h('label', {
        key: 'autosurf-articles',
        className: 'sm-rhythm-check',
        title: '同轮顺带读专栏文章（按兴趣词 + 推荐），计入「每次看 N 个」。',
      }, [
        h('input', {
          key: 'i', type: 'checkbox',
          checked: ext.biliSurfIncludeArticles !== false,
          onChange: (event) => patchExtensions({ biliSurfIncludeArticles: event.target.checked }),
        }),
        h('span', { key: 't' }, '看热门/兴趣专栏文章'),
      ]),
      h('label', {
        key: 'autosurf-kw-auto',
        className: 'sm-rhythm-check',
        title: '开启后：每次定时巡片前，根据 DSH 各对话窗、全平台 IM 近聊与记忆要点自动调整下方关键词；你手改的词会当作底线保留。',
      }, [
        h('input', {
          key: 'i', type: 'checkbox',
          checked: ext.biliKeywordsAuto !== false,
          onChange: (event) => patchExtensions({ biliKeywordsAuto: event.target.checked }),
        }),
        h('span', { key: 't' }, '随聊天自动追加兴趣关键词（不动手填词，最多 20 个）'),
      ]),
      h(AutoSurfKeywords, {
        key: 'autosurf-kw',
        keywords: ext.biliKeywords || [],
        onCommit: (next) => patchExtensions({
          biliKeywords: next,
          biliKeywordsSeed: next,
        }),
      }),
      Array.isArray(ext.biliLearnedKeywords) && ext.biliLearnedKeywords.length
        ? h('p', { key: 'autosurf-learned', className: 'sm-panel-muted' },
          '自动学习（' + ext.biliLearnedKeywords.length + '/20）：' + ext.biliLearnedKeywords.join('、'))
        : null,
      ext.biliKeywordsUpdatedAt
        ? h('p', { key: 'autosurf-kw-at', className: 'sm-panel-muted' },
          '最近自动更新：' + String(ext.biliKeywordsUpdatedAt).slice(0, 19).replace('T', ' '))
        : null,
      null,
    ]) : null,
  ]
}

/** 作息与主动 tab：主动开关 + 日更/梦境 + 专属窗（B 站迁至「冲浪」标签）。 */
function rhythmCard(view) {
  const {
    draft, proDraft, homeDraft, patchProactive, patchChatHome, patchNotify,
    proStatus, homeCfg, homeFull, homeMeasure, snap, usage,
    llmBudgetSection: llmBudget,
  } = view
  const pp = companionPronoun(
    draft.gender === 'male' || draft.gender === 'female' ? draft.gender : null,
  ).third
  return h('div', { key: 'rhythm', className: 'sm-panel-card' }, [
    h('h3', { key: 'h', className: 'sm-panel-h3' }, '作息与主动'),
    h('p', { key: 'lead', className: 'sm-panel-muted' },
      pp + '主动找你时，消息会进专属对话窗。窗聊太满会新开一扇，并把要点带过去。'),
    h('div', { key: 'live', className: 'sm-rhythm-body' }, [
      h('p', { key: 'state', className: 'sm-panel-muted' },
        proStatus
          ? '当前：' + (proStatus.plan && proStatus.plan.speak ? '想找你说话' : '先安静待着')
            + (proStatus.priceWindow === 'offpeak' ? ' · 现在是错峰时段' : '')
          : '读取中…'),
      h('p', { key: 'home', className: 'sm-panel-muted' },
        '专属窗：' + (homeCfg.activeSessionId
          ? (homeCfg.titlePrefix || (snap && snap.displayName) || '专属窗')
          : '尚未创建')
          + (homeMeasure ? ' · 约 ' + (homeMeasure.turns || 0) + ' 回合' : '')
          + (homeFull && homeFull.full ? ' · 快满了，下次主动会换新窗' : '')),
      h('label', { key: 'on', className: 'sm-rhythm-check' }, [
        h('input', {
          key: 'i', type: 'checkbox', checked: !!proDraft.enabled,
          onChange: (event) => patchProactive({ enabled: event.target.checked }),
        }),
        h('span', { key: 't' }, '允许' + pp + '主动找你'),
      ]),
      h('label', { key: 'boot', className: 'sm-rhythm-check' }, [
        h('input', {
          key: 'i', type: 'checkbox', checked: homeDraft.bootGreeting !== false,
          onChange: (event) => patchChatHome({ bootGreeting: event.target.checked }),
        }),
        h('span', { key: 't' }, '软件启动时主动打个招呼'),
      ]),
      h('label', { key: 'notify', className: 'sm-rhythm-check' }, [
        h('input', {
          key: 'i', type: 'checkbox', checked: !(draft.notify && draft.notify.enabled === false),
          onChange: (event) => patchNotify && patchNotify({ enabled: event.target.checked }),
        }),
        h('span', { key: 't' }, '系统通知（看完视频 / 写日记 / 主动找你时，右下角弹系统提醒）'),
      ]),
      h('label', { key: 'rotate-persona', className: 'sm-rhythm-check' }, [
        h('input', {
          key: 'i', type: 'checkbox', checked: homeDraft.rotateOnPersonaChange !== false,
          onChange: (event) => patchChatHome({ rotateOnPersonaChange: event.target.checked }),
        }),
        h('span', { key: 't' }, '换人设后自动开新窗（旧窗保留，要点带过去）'),
      ]),
      ...chatHomeAutoMemoryChecks({ homeDraft, patchChatHome }),
      h('label', { key: 'diary', className: 'sm-rhythm-check' }, [
        h('input', {
          key: 'i', type: 'checkbox', checked: proDraft.dailyDiary !== false,
          onChange: (event) => patchProactive({ dailyDiary: event.target.checked }),
        }),
        h('span', { key: 't' }, '每天写日记（日更，没事也写一封短信）'),
      ]),
      h('label', { key: 'dream', className: 'sm-rhythm-check' }, [
        h('input', {
          key: 'i', type: 'checkbox', checked: !!proDraft.dreamReflect,
          onChange: (event) => patchProactive({ dreamReflect: event.target.checked }),
        }),
        h('span', { key: 't' }, '夜里整理当天零散记忆'),
      ]),
      h('label', { key: 'offpeak', className: 'sm-rhythm-check' }, [
        h('input', {
          key: 'i', type: 'checkbox', checked: !!proDraft.preferOffPeak,
          onChange: (event) => patchProactive({ preferOffPeak: event.target.checked }),
        }),
        h('span', { key: 't' }, '整理记忆尽量选错峰（更省）'),
      ]),
      ...llmBudget({ h, proDraft, usage, patchProactive }),
      h('p', { key: 'quiet', className: 'sm-panel-muted' },
        '免打扰：' + ((proDraft.quietHours && proDraft.quietHours.join('、')) || '无')
          + ' · 专属窗大约 ' + (homeDraft.maxTurns || 500) + ' 回合后换新窗'
          + ' · B 站冲浪请到「冲浪」标签'),
      field('maxperday', '每天最多主动 ' + proDraft.maxPerDay + ' 次', h('input', {
        key: 'control', type: 'range', min: 0, max: 8, step: 1,
        value: proDraft.maxPerDay,
        onChange: (event) => patchProactive({ maxPerDay: Number(event.target.value) }),
      })),
    ]),
  ])
}

module.exports = {
  field, identityCard, gateCard, traitsCard, skinFrameUrl, lookPetCard, chatHomeAutoMemoryChecks, rhythmCard,
  autoSurfSection, BUNDLED_LOOKS,
}
