// Editable settings forms (称呼与预设 / 自进化边界 / 五维滑杆 / 形象与桌宠).
const React = require('react')
const h = React.createElement
const {
  TRAIT_LABELS,
  DEFAULT_SPRITE_URL,
  MBTI_TYPES,
  MBTI_AXES,
  MBTI_AXIS_LABELS,
  MBTI_BLURBS,
} = require('./panel-draft.mjs')
const { companionPronoun } = require('./util.mjs')
const { paintBalloonMini } = require('./balloon-sprite.mjs')

/** A labelled control row. */
function field(key, label, control) {
  return h('label', { key, className: 'sm-panel-field' }, [
    h('span', { key: 'label' }, label),
    control,
  ])
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
    h('p', { key: 'hint', className: 'sm-panel-muted' }, '上面是当前预设说明；下面可自己改，改完自动保存。'),
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
    h('p', { key: 'lead', className: 'sm-panel-muted' }, '点选 16 型；下面四条可微调倾向。也可直接回复四个字母。'),
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

function spriteCard({ draft, spriteNote, fileInputRef, uploadSprite, restoreDefaultSprite }) {
  return h('div', { key: 'sprite', className: 'sm-panel-card' }, [
    h('h3', { key: 'h', className: 'sm-panel-h3' }, '形象'),
    h('div', { key: 'row', className: 'sm-sprite-row' }, [
      h('img', {
        key: 'preview',
        className: 'sm-sprite-preview',
        src: draft.appearance.customSpriteUrl || DEFAULT_SPRITE_URL,
        alt: '形象',
      }),
      h('div', { key: 'ops', className: 'sm-sprite-ops' }, [
        h('button', {
          key: 'pick', type: 'button', className: 'sm-panel-btn primary',
          onClick: () => { if (fileInputRef.current) fileInputRef.current.click() },
        }, '更换图片…'),
        h('button', {
          key: 'restore', type: 'button', className: 'sm-panel-btn',
          onClick: () => restoreDefaultSprite(),
        }, '恢复默认'),
        h('input', {
          key: 'file', type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif',
          ref: fileInputRef, style: { display: 'none' },
          onChange: (event) => uploadSprite(event.target.files && event.target.files[0]),
        }),
        h('p', { key: 'tip', className: 'sm-panel-muted' },
          spriteNote || '支持 PNG / JPG / WEBP，透明底最好，不超过 4MB。'),
      ]),
    ]),
  ])
}

function petCard({ draft, petDraft, patchPet, PetPreview }) {
  return h('div', { key: 'pet', className: 'sm-panel-card' }, [
    h('h3', { key: 'h', className: 'sm-panel-h3' }, '桌面小伙伴'),
    h('div', { key: 'row', className: 'sm-sprite-row' }, [
      h(PetPreview, { key: 'preview', skin: petDraft.skin || 'winterboy-chibi', fallback: draft.appearance.customSpriteUrl || DEFAULT_SPRITE_URL }),
      h('div', { key: 'ops', className: 'sm-sprite-ops' }, [
        h('label', { key: 'on' }, [
          h('input', {
            key: 'i', type: 'checkbox', checked: !!petDraft.enabled,
            onChange: (event) => patchPet({ enabled: event.target.checked }),
          }),
          h('span', { key: 't' }, '开启动画形象'),
        ]),
        field('petsize', '尺寸 ' + petDraft.sizePx + ' 像素（高；滚轮也可缩放）', h('input', {
          key: 'control', type: 'range', min: 96, max: 320, step: 4,
          value: Math.min(320, Math.max(96, Number(petDraft.sizePx) || 148)),
          onChange: (event) => patchPet({ sizePx: Number(event.target.value) }),
        })),
        field('petskin', '皮肤', h('select', {
          key: 'control', className: 'sm-panel-input',
          value: petDraft.skin || 'winterboy-chibi',
          onChange: (event) => patchPet({ skin: event.target.value }),
        }, [
          h('option', { key: 'winterboy-chibi', value: 'winterboy-chibi' }, 'Q版 · 冬装男孩'),
        ])),
        h('p', { key: 'tip', className: 'sm-panel-muted' },
          '开启后右下角会动：可拖动、滚轮缩放。关闭则用上面的静态图。皮肤目录放入透明视频资产后自动升级为视频动画。'),
      ]),
    ]),
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
    h('p', { key: 'automem-hint', className: 'sm-panel-muted' },
      '只影响小海海消息文件夹；删对话框不会忘'),
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
      placeholder: '例如：AI，编程，科技',
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
  const ext = draft.extensions || {}
  return [
    h('label', { key: 'autosurf-on', className: 'sm-rhythm-check' }, [
      h('input', {
        key: 'i', type: 'checkbox', checked: !!ext.biliAutoSurfEnabled,
        onChange: (event) => patchExtensions && patchExtensions({ biliAutoSurfEnabled: event.target.checked }),
      }),
      h('span', { key: 't' }, '定时自动刷 B 站（按兴趣自己看片、记小本本，不会发评论/私信）'),
    ]),
    ext.biliAutoSurfEnabled ? h('div', { key: 'autosurf-knobs', style: { marginLeft: 22 } }, [
      field('autosurf-every', '每 ' + (ext.biliAutoSurfEveryHours || 6) + ' 小时巡一圈', h('input', {
        key: 'control', type: 'range', min: 1, max: 24, step: 1,
        value: ext.biliAutoSurfEveryHours || 6,
        onChange: (event) => patchExtensions({ biliAutoSurfEveryHours: Number(event.target.value) }),
      })),
      field('autosurf-pick', '每次看 ' + (ext.biliAutoSurfMaxPick || 2) + ' 个新视频', h('input', {
        key: 'control', type: 'range', min: 1, max: 5, step: 1,
        value: ext.biliAutoSurfMaxPick || 2,
        onChange: (event) => patchExtensions({ biliAutoSurfMaxPick: Number(event.target.value) }),
      })),
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
      h(AutoSurfKeywords, {
        key: 'autosurf-kw',
        keywords: ext.biliKeywords || [],
        onCommit: (next) => patchExtensions({ biliKeywords: next }),
      }),
      h('p', { key: 'autosurf-hint', className: 'sm-panel-muted' },
        '免打扰时段不巡；看过的自动跳过；看完会弹系统通知（若开启）。鼠标悬停「认真看完」可看说明。'),
    ]) : null,
  ]
}

/** 作息与主动 tab：主动开关 + 日更/梦境 + 专属窗 + B 站授权。 */
function rhythmCard(view) {
  const {
    draft, proDraft, homeDraft, patchProactive, patchChatHome, patchNotify, patchExtensions,
    proStatus, homeCfg, homeFull, homeMeasure, snap, usage,
    llmBudgetSection: llmBudget, biliAuthCard: BiliAuth,
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
      field('maxperday', '每天最多主动 ' + proDraft.maxPerDay + ' 次', h('input', {
        key: 'control', type: 'range', min: 0, max: 8, step: 1,
        value: proDraft.maxPerDay,
        onChange: (event) => patchProactive({ maxPerDay: Number(event.target.value) }),
      })),
      h('p', { key: 'quiet', className: 'sm-panel-muted' },
        '免打扰：' + ((proDraft.quietHours && proDraft.quietHours.join('、')) || '无')
          + ' · 专属窗大约 ' + (homeDraft.maxTurns || 100) + ' 回合后换新窗'),
      h(BiliAuth, { key: 'bili-auth' }),
      ...autoSurfSection({ draft, patchExtensions }),
    ]),
  ])
}

module.exports = {
  field, identityCard, gateCard, traitsCard, spriteCard, petCard, chatHomeAutoMemoryChecks, rhythmCard,
}
