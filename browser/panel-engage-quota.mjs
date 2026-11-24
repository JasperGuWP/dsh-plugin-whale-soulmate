// 自主互动配额卡：B 站分项限额 + IM 白名单主动发。全部是 node 侧真正执行的旋钮，
// 面板只是镜子。投币花真硬币，独立开关；IM 只发用户显式加白的会话。

const React = require('react')
const h = React.createElement
const { api } = require('./util.mjs')

const num = (v, d) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : d
}
const clampInt = (v, lo, hi, d) => Math.max(lo, Math.min(hi, Math.floor(num(v, d))))

function quotaRow({ key, label, value, min, max, unit, onChange }) {
  return h('label', { key, className: 'sm-quota-row' }, [
    h('span', { key: 'l' }, label),
    h('input', {
      key: 'n', type: 'number', min, max, step: 1, value: String(value),
      onChange: (e) => onChange(clampInt(e.target.value, min, max, value)),
    }),
    h('span', { key: 'u' }, unit || '次/天'),
  ])
}

/** B 站分项配额：字数 / 评论 / 回复轮数 / 赞 / 藏 / 关注 / 投币。 */
function biliQuotaSection({ ext, patchExtensions }) {
  return h('div', { key: 'bili-quota', className: 'sm-quota-card' }, [
    h('h4', { key: 'h', className: 'sm-quota-h' }, '互动分寸（每日上限，滚动 24 小时）'),
    quotaRow({
      key: 'chars', label: '评论字数上限', unit: '字',
      value: clampInt(ext.biliCommentMaxChars, 10, 500, 80), min: 10, max: 500,
      onChange: (n) => patchExtensions({ biliCommentMaxChars: n }),
    }),
    quotaRow({
      key: 'rounds', label: '每条评论最多回复', unit: '轮',
      value: clampInt(ext.biliAutoReplyMaxRounds, 1, 5, 2), min: 1, max: 5,
      onChange: (n) => patchExtensions({ biliAutoReplyMaxRounds: n }),
    }),
    quotaRow({
      key: 'comment', label: '评论', value: clampInt(ext.biliCommentDailyCap, 0, 30, 5), min: 0, max: 30,
      onChange: (n) => patchExtensions({ biliCommentDailyCap: n }),
    }),
    quotaRow({
      key: 'like', label: '点赞', value: clampInt(ext.biliLikeDailyCap, 0, 50, 10), min: 0, max: 50,
      onChange: (n) => patchExtensions({ biliLikeDailyCap: n }),
    }),
    quotaRow({
      key: 'fav', label: '收藏', value: clampInt(ext.biliFavoriteDailyCap, 0, 50, 10), min: 0, max: 50,
      onChange: (n) => patchExtensions({ biliFavoriteDailyCap: n }),
    }),
    quotaRow({
      key: 'follow', label: '关注', value: clampInt(ext.biliFollowDailyCap, 0, 20, 2), min: 0, max: 20,
      onChange: (n) => patchExtensions({ biliFollowDailyCap: n }),
    }),
    h('label', { key: 'coin-on', className: 'sm-rhythm-check' }, [
      h('input', {
        key: 'i', type: 'checkbox', checked: ext.biliCoinEnabled === true,
        onChange: (e) => patchExtensions({ biliCoinEnabled: e.target.checked }),
      }),
      h('span', { key: 't' }, '允许投币（花真硬币，只投她特别喜欢的）'),
    ]),
    ext.biliCoinEnabled === true ? quotaRow({
      key: 'coin', label: '投币', value: clampInt(ext.biliCoinDailyCap, 0, 10, 2), min: 0, max: 10, unit: '币/天',
      onChange: (n) => patchExtensions({ biliCoinDailyCap: n }),
    }) : null,
    h('label', { key: 'llm-on', className: 'sm-rhythm-check' }, [
      h('input', {
        key: 'i', type: 'checkbox', checked: ext.biliEngageLlmEnabled !== false,
        onChange: (e) => patchExtensions({ biliEngageLlmEnabled: e.target.checked }),
      }),
      h('span', { key: 't' }, '评论和跟帖由她按性格现写（关掉则用短句模板）'),
    ]),
  ])
}

/** IM 白名单编辑器：一行一个会话，只有加白的才可能被主动搭话。 */
function imWhitelistEditor({ ext, patchExtensions }) {
  const list = Array.isArray(ext.imProactiveWhitelist) ? ext.imProactiveWhitelist : []
  const [known, setKnown] = React.useState(null)
  const [knownBusy, setKnownBusy] = React.useState(false)
  const [knownErr, setKnownErr] = React.useState('')
  // Load once on mount so existing rows can show real nicknames without a click.
  React.useEffect(() => {
    let alive = true
    api('im/known').then((res) => {
      if (alive && res && res.ok !== false) setKnown(Array.isArray(res.conversations) ? res.conversations : [])
    }).catch(() => {})
    return () => { alive = false }
  }, [])
  const loadKnown = React.useCallback(async () => {
    if (knownBusy) return
    setKnownBusy(true)
    setKnownErr('')
    try {
      // Pull the latest QQ conversations first so the picker includes fresh group members.
      await api('qqbot/sync', {}).catch(() => {})
      const res = await api('im/known')
      if (!res || res.ok === false) {
        setKnownErr((res && res.error) || '读取失败')
        setKnown([])
      } else {
        const list = Array.isArray(res.conversations) ? res.conversations : []
        setKnown(list)
        setKnownErr(list.length ? '' : '同步完成，但没有可加白的会话：先让 QQ 机器人在私聊或群里收到一条消息，再点这里。')
      }
    } catch (err) {
      setKnownErr(err && err.message ? err.message : '读取失败')
      setKnown([])
    } finally {
      setKnownBusy(false)
    }
  }, [knownBusy])
  const addKnown = (c) => {
    const dup = list.some((e) => String(e.platform) === String(c.platform)
      && String(e.to || '') === String(c.to || '')
      && String(e.groupId || '') === String(c.groupId || ''))
    if (dup) return
    patchExtensions({
      imProactiveWhitelist: [...list, { platform: c.platform, to: c.to || '', groupId: c.groupId || '', label: c.label || '' }],
    })
  }
  const update = (i, patch) => {
    const next = list.map((e, j) => (j === i ? Object.assign({}, e, patch) : e))
    patchExtensions({ imProactiveWhitelist: next })
  }
  // Nickname lookup for existing rows: the known-conversations feed carries real QQ
  // speaker names (bridged transcripts); show them next to the raw openid inputs.
  const nickOf = (e) => {
    if (!Array.isArray(known)) return ''
    const hit = known.find((c) => String(c.platform) === String(e.platform)
      && String(c.to || '') === String(e.to || '')
      && String(c.groupId || '') === String(e.groupId || ''))
    return String((hit && (hit.nickname || (hit.label && !/^(QQ群|QQ私聊) [0-9A-F]/.test(hit.label) ? hit.label : ''))) || '')
  }
  return h('div', { key: 'wl', className: 'sm-quota-wl' }, [
    ...list.map((e, i) => {
      const nick = nickOf(e) || (/^(QQ群|QQ私聊) [0-9A-F]/.test(String(e.label || '')) ? '' : String(e.label || ''))
      return h('div', { key: 'r' + i, className: 'sm-quota-wl-row' }, [
        h('select', {
          key: 'p', value: String(e.platform || 'qq'),
          onChange: (ev) => update(i, { platform: ev.target.value }),
        }, ['weixin', 'qq', 'feishu', 'dingtalk'].map((p) => h('option', { key: p, value: p }, p))),
        h('input', {
          key: 'to', type: 'text', placeholder: '对方 id / open_id', value: String(e.to || ''),
          title: nick ? '昵称：' + nick : undefined,
          onChange: (ev) => update(i, { to: ev.target.value }),
        }),
        h('input', {
          key: 'g', type: 'text', placeholder: '群 id（留空=私聊）', value: String(e.groupId || ''),
          onChange: (ev) => update(i, { groupId: ev.target.value }),
        }),
        nick ? h('span', { key: 'nick', className: 'sm-quota-wl-nick', title: '来自对话记录的真实昵称' }, nick) : null,
        h('input', {
          key: 'l', type: 'text', placeholder: '备注', value: String(e.label || ''),
          onChange: (ev) => update(i, { label: ev.target.value }),
        }),
        h('button', {
          key: 'x', type: 'button', className: 'sm-btn',
          onClick: () => patchExtensions({ imProactiveWhitelist: list.filter((_, j) => j !== i) }),
        }, '移除'),
      ])
    }),
    h('div', { key: 'known-bar', className: 'sm-quota-wl-row' }, [
      h('button', {
        key: 'pick', type: 'button', className: 'sm-btn', disabled: knownBusy,
        onClick: loadKnown,
      }, knownBusy ? '读取中…' : '从最近会话选（QQ/微信…）'),
      knownErr ? h('span', { key: 'err', className: 'sm-panel-muted' }, knownErr) : null,
    ]),
    Array.isArray(known) && known.length
      ? h('div', { key: 'known-list', className: 'sm-quota-wl' }, known.map((c, i) => h('div', { key: 'k' + i, className: 'sm-quota-wl-row' }, [
        h('span', { key: 't', title: (c.to || c.groupId || '') + (c.lastAt ? ' · ' + c.lastAt : '') },
          '[' + c.platform + '] ' + (c.label || c.to || c.groupId) + (c.groupId ? '（群）' : '')),
        h('button', {
          key: 'add', type: 'button', className: 'sm-btn',
          onClick: () => addKnown(c),
        }, '加白'),
      ])))
      : null,
    Array.isArray(known) && !known.length && !knownErr
      ? h('p', { key: 'known-empty', className: 'sm-panel-muted' },
        '还没发现聊过的会话：先让 QQ 机器人收到一条消息（私聊或群里 @），或配置 soulmate 自己的 IM 通道聊一句，再点这里。')
      : null,
    h('button', {
      key: 'add', type: 'button', className: 'sm-btn',
      onClick: () => patchExtensions({ imProactiveWhitelist: [...list, { platform: 'qq', to: '', groupId: '', label: '' }] }),
    }, '添加会话'),
    h('p', { key: 'warn', className: 'sm-panel-muted' },
      '群聊里她说的话所有人可见。微信官方通道不支持无票主动私聊：对方最近发过消息才发得出去。'),
  ])
}

const OWNER_KEY = { weixin: 'imOwnerWeixin', qq: 'imOwnerQq', feishu: 'imOwnerFeishu', dingtalk: 'imOwnerDingtalk' }

function ownerRow({ key, platform, value, onChange, candidates, onFetch, fetching, msg }) {
  const cands = Array.isArray(candidates) ? candidates : []
  return h('div', { key, className: 'sm-quota-owner' }, [
    h('div', { key: 'row', className: 'sm-quota-row' }, [
      h('span', { key: 'l' }, '主人 id（' + platform + '）'),
      h('input', {
        key: 'n', type: 'text', value, placeholder: '该平台上你自己的账号 id',
        style: { flex: 1, minWidth: '90px' },
        onChange: (e) => onChange(e.target.value),
      }),
      h('button', {
        key: 'fetch', type: 'button', className: 'sm-btn', disabled: !!fetching,
        title: platform === 'qq' ? '从群聊记录拉取最近发言者（含昵称）' : '从微信对话记录拉取最近联系人',
        onClick: onFetch,
      }, fetching ? '获取中…' : '获取主人'),
    ]),
    cands.length ? h('div', { key: 'cands', className: 'sm-quota-owner-cands' }, [
      h('span', { key: 'hint', className: 'sm-panel-muted' }, '点昵称自动填入（' + (platform === 'qq' ? '来自群聊记录' : '来自微信对话') + '）：'),
      ...cands.map((c) => h('button', {
        key: c.id, type: 'button',
        className: 'sm-btn' + (value === c.id ? ' primary' : ''),
        title: c.id,
        onClick: () => onChange(c.id),
      }, c.name + (value === c.id ? ' ✓' : ''))),
    ]) : null,
    msg ? h('p', { key: 'msg', className: 'sm-panel-muted', style: { margin: '2px 0 0' } }, msg) : null,
  ])
}

function imProactiveSection({ ext, patchExtensions }) {
  const on = ext.imProactiveEnabled === true
  const [speakers, setSpeakers] = React.useState([])
  const [wxContacts, setWxContacts] = React.useState([])
  const [fetching, setFetching] = React.useState('')
  const loadSpeakers = React.useCallback(async () => {
    const res = await api('im/known')
    if (res && res.ok !== false && Array.isArray(res.speakers)) setSpeakers(res.speakers)
  }, [])
  React.useEffect(() => {
    if (!on) return undefined
    let alive = true
    api('im/known').then((res) => {
      if (alive && res && res.ok !== false && Array.isArray(res.speakers)) setSpeakers(res.speakers)
    }).catch(() => {})
    return () => { alive = false }
  }, [on])
  // 「获取主人」per platform: QQ syncs the bridge then reads speakers; WeChat reads
  // its own chat contacts. Each button only touches its own platform.
  const [ownerMsg, setOwnerMsg] = React.useState({})
  const fetchOwner = async (platform) => {
    if (fetching) return
    setFetching(platform)
    setOwnerMsg((m) => ({ ...m, [platform]: '获取中…' }))
    const say = (text) => setOwnerMsg((m) => ({ ...m, [platform]: text }))
    try {
      if (platform === 'qq') {
        const sync = await api('qqbot/sync', {}).catch(() => null)
        if (sync && sync.ok === false) {
          say('拉取失败：' + (sync.error || sync.reason || '未知') + '。确认 DSH 已重启到最新版。')
          return
        }
        const res = await api('im/known').catch(() => null)
        const list = res && Array.isArray(res.speakers) ? res.speakers : []
        setSpeakers(list)
        if (list.length) say('找到 ' + list.length + ' 位最近发言者，点下方昵称填入。')
        else say('没找到发言者：先让 QQ 机器人在群里收到一条消息（你或群友说句话），再点「获取主人」。')
      } else if (platform === 'weixin') {
        const res = await api('im/chat?platform=weixin&limit=20').catch(() => null)
        if (!res || res.ok === false) {
          say('读取失败：' + ((res && res.error) || '微信通道未连接') + '。先在 DsBot 扫码登录微信并拉取消息。')
          return
        }
        const contacts = Array.isArray(res.contacts) ? res.contacts : []
        setWxContacts(contacts.map((c) => ({ id: c.peerId, name: c.peerLabel || c.peerId })))
        if (contacts.length) say('找到 ' + contacts.length + ' 位最近联系人，点下方名字填入。')
        else say('微信暂无对话记录：先在 DsBot → 微信 Bot 扫码登录，点「拉取消息」收到一条后再试。')
      }
    } catch (err) {
      say('获取失败：' + (err && err.message ? err.message : '未知错误'))
    } finally {
      setFetching('')
    }
  }
  return h('div', { key: 'im-pro', className: 'sm-quota-card' }, [
    h('h4', { key: 'h', className: 'sm-quota-h' }, 'IM 主动搭话（微信 / QQ / 飞书 / 钉钉）'),
    h('label', { key: 'on', className: 'sm-rhythm-check' }, [
      h('input', {
        key: 'i', type: 'checkbox', checked: on,
        onChange: (e) => patchExtensions({ imProactiveEnabled: e.target.checked }),
      }),
      h('span', { key: 't' }, '允许她主动给下面加白的会话发消息'),
    ]),
    on ? imWhitelistEditor({ ext, patchExtensions }) : null,
    on ? h('div', { key: 'owners', className: 'sm-quota-grid' }, (() => {
      const list = Array.isArray(ext.imProactiveWhitelist) ? ext.imProactiveWhitelist : []
      const platforms = [...new Set(list.map((e) => String(e.platform || '').trim()).filter(Boolean))]
      if (!platforms.length) platforms.push('qq', 'weixin')
      return platforms.map((platform) => {
        const key = OWNER_KEY[platform]
        return key ? ownerRow({
          key: 'own-' + platform, platform,
          value: String(ext[key] || ''),
          onChange: (v) => patchExtensions({ [key]: v }),
          candidates: platform === 'qq' ? speakers : (platform === 'weixin' ? wxContacts : []),
          onFetch: () => fetchOwner(platform),
          fetching: fetching === platform,
          msg: ownerMsg[platform] || '',
        }) : null
      })
    })()) : null,
    on ? h('p', { key: 'owner-hint', className: 'sm-panel-muted' },
      '主人 id 是 QQ 开放平台的 openid（不是 QQ 号，平台不提供 QQ 号/手机号）。点上面昵称按钮即可自动填入；填好后群里她能认出主人，没填时所有人都当群友。') : null,
    on ? h('div', { key: 'quotas', className: 'sm-quota-grid' }, [
      quotaRow({
        key: 'per', label: '每会话', value: clampInt(ext.imProactivePerConvDaily, 1, 60, 2), min: 1, max: 60,
        onChange: (n) => patchExtensions({ imProactivePerConvDaily: n }),
      }),
      quotaRow({
        key: 'total', label: '全部合计', value: clampInt(ext.imProactiveDailyTotal, 1, 120, 4), min: 1, max: 120,
        onChange: (n) => patchExtensions({ imProactiveDailyTotal: n }),
      }),
      quotaRow({
        key: 'gap', label: '最小间隔', unit: '分钟', value: clampInt(ext.imProactiveMinGapMinutes, 1, 720, 90), min: 1, max: 720,
        onChange: (n) => patchExtensions({ imProactiveMinGapMinutes: n }),
      }),
      quotaRow({
        key: 'chars', label: '单条字数', unit: '字', value: clampInt(ext.imProactiveMaxChars, 10, 500, 120), min: 10, max: 500,
        onChange: (n) => patchExtensions({ imProactiveMaxChars: n }),
      }),
    ]) : null,
    h('p', { key: 'audit', className: 'sm-panel-muted' }, '每条主动外发都留痕（发给谁、说了什么、为什么），安静时段照旧。'),
  ])
}

module.exports = { biliQuotaSection, imProactiveSection }