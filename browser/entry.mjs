// Plugin entry: wires styles, chat cards and the slot surfaces.
const { KIND, api } = require('./util.mjs')
const { injectStyles } = require('./styles.mjs')
const { soulmateDefinition, ChatSoulmateNode } = require('./cards.mjs')
const { PANEL_ID, PANEL_ORDER, sidebarLabelOf, setLabelChangeHook, notifyLabelChange, SoulmatePanelIcon, SoulmatePanelPage } = require('./panel.mjs')
const { setHostOpenSession } = require('./panel-mbti.mjs')
const { createWidget } = require('./widget.mjs')
const { installWakeBubbleHider } = require('./wake-bubble-hide.mjs')
const { installThinkingLabel } = require('./thinking-label.mjs')
const { installNotifications } = require('./notify.mjs')

    // ------------------------------------------------------------------
    // Plugin entry
    // ------------------------------------------------------------------
    function apply(ctx) {
      const disposeStyles = injectStyles()
      if (typeof disposeStyles === 'function' && typeof ctx.effect === 'function') ctx.effect(() => disposeStyles)

      // Hide plugin wake notices painted as user bubbles (marker from buildWakeVisibleNotice).
      if (typeof document !== 'undefined' && document.body) {
        const disposeWakeHide = installWakeBubbleHider()
        if (typeof disposeWakeHide === 'function' && typeof ctx.effect === 'function') {
          ctx.effect(() => disposeWakeHide)
        }
        // Host running-status voice:「深度求索中」→「<name>思考中」.
        const disposeThinking = installThinkingLabel()
        if (typeof disposeThinking === 'function' && typeof ctx.effect === 'function') {
          ctx.effect(() => disposeThinking)
        }
        // Built-in OS toasts (bottom-right Notification API).
        const disposeNotify = installNotifications()
        if (typeof disposeNotify === 'function' && typeof ctx.effect === 'function') {
          ctx.effect(() => disposeNotify)
        }
      }

      // Soft-bind uiWorkspace so the MBTI quiz button can leave settings → Conversation.
      const bindUiWorkspace = (ws) => {
        if (!ws || typeof ws.openSession !== 'function') return
        setHostOpenSession((sessionId) => ws.openSession(sessionId))
      }
      if (typeof ctx.inject === 'function') {
        ctx.inject(['uiWorkspace'], (wsCtx) => {
          const ws = wsCtx.uiWorkspace || (wsCtx.get && wsCtx.get('uiWorkspace'))
          bindUiWorkspace(ws)
          if (typeof wsCtx.effect === 'function') {
            wsCtx.effect(() => () => setHostOpenSession(null))
          }
        })
      } else {
        bindUiWorkspace(ctx.get ? ctx.get('uiWorkspace') : ctx.uiWorkspace)
      }

      // Hard-injecting `slots` / `conversationEvents` on the package would leave the fiber
      // `pending` forever on hosts that lack them. Instead: empty package inject, then
      // `ctx.inject(['slots'], …)` child forks that wait until the service is ACTIVE
      // (one-shot `ctx.get` races the web boot and silently skips the sidebar row).
      const mountChatCard = (conversationEvents) => {
        if (!conversationEvents || typeof conversationEvents.register !== 'function') return
        if (typeof ctx.effect === 'function') ctx.effect(() => conversationEvents.register(soulmateDefinition))
        else conversationEvents.register(soulmateDefinition)
      }

      const mountSlots = (slots) => {
        if (!slots || typeof slots.inject !== 'function') return () => {}
        const disposers = []
        let sidebarLabel = 'soulmate'
        let disposePanellist = null

        const mountPanellist = () => {
          if (typeof disposePanellist === 'function') {
            try { disposePanellist() } catch (_) { /* previous inject already gone */ }
            disposePanellist = null
          }
          // Official pattern: inject → register. Label is a thunk so projection can re-read it;
          // remount still required after rename because the sidebar snapshot only refreshes
          // on slot subscribe / locale change.
          disposePanellist = slots.inject('sidebar.panellist', () => slots.register({
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: PANEL_ORDER,
            label: () => sidebarLabel,
          }, SoulmatePanelIcon))
        }

        disposers.push(slots.inject('conversation.chat.node', () => slots.register({
          name: 'conversation.chat.node',
          key: KIND,
        }, ChatSoulmateNode)))

        mountPanellist()
        setLabelChangeHook((name) => {
          const next = sidebarLabelOf(name)
          if (next === sidebarLabel) return
          sidebarLabel = next
          mountPanellist()
        })
        // Seed from persisted identity; drafts never touch the sidebar.
        api('state').then((data) => {
          if (data && data.ok !== false && data.displayName) notifyLabelChange(data.displayName)
        })

        disposers.push(slots.inject('main', () => slots.register({
          name: 'main',
          key: PANEL_ID,
        }, SoulmatePanelPage)))

        return () => {
          setLabelChangeHook(null)
          if (typeof disposePanellist === 'function') {
            try { disposePanellist() } catch (_) { /* ignore */ }
            disposePanellist = null
          }
          for (const dispose of disposers) {
            try { if (typeof dispose === 'function') dispose() } catch (_) { /* ignore */ }
          }
        }
      }

      if (typeof ctx.inject === 'function') {
        ctx.inject(['slots'], (slotCtx) => mountSlots(slotCtx.slots || (slotCtx.get && slotCtx.get('slots'))))
        ctx.inject(['conversationEvents'], (evCtx) => {
          mountChatCard(evCtx.conversationEvents || (evCtx.get && evCtx.get('conversationEvents')))
        })
      } else {
        // Test / bare hosts: probe once (no race with a real web boot).
        const conversationEvents = ctx.get ? ctx.get('conversationEvents') : ctx.conversationEvents
        const slots = ctx.get ? ctx.get('slots') : ctx.slots
        mountChatCard(conversationEvents)
        const disposeSlots = mountSlots(slots)
        if (typeof disposeSlots === 'function' && typeof ctx.effect === 'function') {
          ctx.effect(() => disposeSlots)
        }
      }

      // The widget is plain DOM, so it must survive a host that offers neither service.
      if (typeof document !== 'undefined' && document.body) {
        const destroy = createWidget()
        // Reversible side effect: remove the widget when the plugin is disposed.
        if (typeof ctx.effect === 'function') ctx.effect(() => destroy)
      }
    }

    // Intentionally empty: see the probe above. Declaring a service that a given profile does
    // not provide would break that profile's boot instead of only hiding one surface.
    const inject = []
module.exports = { inject, apply }
