// Turn status card above the corner pet (thinking / ran-command / done).

function createTurnCard() {
  const card = document.createElement('div')
  card.className = 'sm-turn-card'
  card.style.display = 'none'
  card.setAttribute('role', 'status')
  card.setAttribute('aria-live', 'polite')

  const closeBtn = document.createElement('button')
  closeBtn.type = 'button'
  closeBtn.className = 'sm-turn-card-x'
  closeBtn.setAttribute('aria-label', '关闭')
  closeBtn.textContent = '×'

  const main = document.createElement('div')
  main.className = 'sm-turn-card-main'

  const title = document.createElement('div')
  title.className = 'sm-turn-card-title'

  const status = document.createElement('div')
  status.className = 'sm-turn-card-status'

  main.appendChild(title)
  main.appendChild(status)

  const endBtn = document.createElement('button')
  endBtn.type = 'button'
  endBtn.className = 'sm-turn-card-end'
  endBtn.setAttribute('aria-label', '关闭')
  endBtn.title = '关闭'

  card.appendChild(closeBtn)
  card.appendChild(main)
  card.appendChild(endBtn)

  let dismissed = false
  let hideTimer = 0
  let lastPhase = 'idle'
  /** After we have shown "说完了" once for this turn, ignore further done polls. */
  let doneShown = false

  const hide = () => {
    card.classList.remove('on')
    card.style.display = 'none'
  }

  const dismiss = () => {
    dismissed = true
    clearTimeout(hideTimer)
    hide()
  }

  closeBtn.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    dismiss()
  })
  endBtn.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    dismiss()
  })

  function phaseLabel(phase) {
    if (phase === 'ran-command') return '已运行命令'
    if (phase === 'done') return '说完了'
    return '思考中'
  }

  function update(snap) {
    const thinking = !!(snap && snap.petThinking)
    const phase = (snap && snap.petTurnPhase) || (thinking ? 'thinking' : 'idle')
    const preview = String((snap && snap.petTurnPreview) || '').trim()

    if (phase === 'thinking' || phase === 'ran-command') {
      if (lastPhase === 'idle' || lastPhase === 'done') {
        dismissed = false
        doneShown = false
      }
    }

    if (dismissed) {
      lastPhase = phase
      return
    }

    if (phase === 'idle' && !thinking) {
      lastPhase = phase
      hide()
      return
    }

    // Done: show at most once, then stay hidden even if server still says done.
    if (phase === 'done' || (!thinking && phase === 'done')) {
      if (doneShown) {
        lastPhase = phase
        return
      }
      doneShown = true
      lastPhase = phase
      title.textContent = preview || ''
      title.style.display = preview ? '' : 'none'
      status.textContent = phaseLabel('done')
      card.style.display = ''
      card.classList.add('on')
      clearTimeout(hideTimer)
      hideTimer = setTimeout(() => {
        hide()
      }, 900)
      return
    }

    if (!thinking) {
      lastPhase = phase
      hide()
      return
    }

    lastPhase = phase
    title.textContent = preview || ''
    title.style.display = preview ? '' : 'none'
    status.textContent = phaseLabel(phase)
    card.style.display = ''
    card.classList.add('on')
    clearTimeout(hideTimer)
  }

  return { el: card, update, dismiss }
}

module.exports = { createTurnCard }
