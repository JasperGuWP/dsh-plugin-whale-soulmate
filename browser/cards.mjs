// Inline chat result cards for soulmate_* tool calls.
const React = require('react')
const h = React.createElement
const { KIND, nextThreshold } = require('./util.mjs')

    // ------------------------------------------------------------------
    // Chat result cards (soulmate_* tool results)
    // ------------------------------------------------------------------
    function metaOf(event) {
      const meta = event && event.data && event.data.meta
      if (meta && typeof meta === 'object' && !Array.isArray(meta) && meta.kind === KIND) return meta
      return undefined
    }

    const soulmateDefinition = {
      kind: KIND,
      target: 'chat',
      match(event) {
        if (event.type !== 'tool/result') return null
        if (metaOf(event) === undefined) return null
        return { id: String(event.data.message.source.callId), role: 'start' }
      },
      start(_context, match) {
        const meta = metaOf(match.event)
        return {
          tool: typeof meta.tool === 'string' ? meta.tool : '',
          ok: meta.ok !== false,
          title: typeof meta.title === 'string' ? meta.title : '小伙伴',
          lines: Array.isArray(meta.lines) ? meta.lines.filter((line) => typeof line === 'string' && line !== '') : [],
          private: meta.private === true,
          state: meta.state && typeof meta.state === 'object' ? meta.state : null,
          bondStage: meta.bondStage && typeof meta.bondStage === 'object' ? meta.bondStage : null,
        }
      },
      update(context) {
        return context.state
      },
      buildViewNode(context) {
        if (context.state === undefined) return null
        const first = context.matches[0]
        const anchor = context.start ? context.start.event.seq : first ? first.event.seq : 0
        const location = context.start ? context.start.location : first ? first.location : { kind: 'unresolved' }
        return {
          key: context.key,
          kind: KIND,
          id: context.id,
          target: 'chat',
          anchorSeq: anchor,
          location,
          visibility: 'visible',
          data: context.state,
        }
      },
    }

    function SoulmateCard(props) {
      const data = (props.node && props.node.data) || {}
      const state = data.state
      const stage = data.bondStage
      const children = [
        h('div', { key: 't', className: 't' }, [
          h('span', { key: 'a' }, data.title || '小伙伴'),
          data.private ? h('span', { key: 'p', className: 'p' }, '🛡️ 私有') : null,
        ]),
      ]
      ;(data.lines || []).forEach((line, index) => {
        children.push(h('div', { key: 'l' + index, className: 'l' }, line))
      })
      if (state && stage) {
        const pct = Math.max(0, Math.min(100, (Number(state.affinity) / nextThreshold(Number(state.affinity))) * 100))
        children.push(h('div', { key: 'b', className: 'bar' }, h('i', { style: { width: pct + '%' } })))
      }
      return h('div', { className: 'sm-chat' + (data.ok === false ? ' bad' : '') }, children)
    }

    function ChatSoulmateNode(props) {
      return h(SoulmateCard, { node: props.node })
    }
module.exports = { metaOf, soulmateDefinition, SoulmateCard, ChatSoulmateNode }
