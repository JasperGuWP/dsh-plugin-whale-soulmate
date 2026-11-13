// Canvas avatar painter shared by the widget and the settings preview.
const { safeColor, clampNum } = require('./util.mjs')

    function drawAvatar(canvas, appearance, mood, t) {
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      const app = appearance || {}
      const w = canvas.width
      const hh = canvas.height
      // Defaults follow the shell's own palette (deepseek-500 accent on a neutral body), so an
      // un-customised companion looks drawn by the same hand as the rest of the app.
      const primary = safeColor(app.primaryColor, '#4176e6')
      const accent = safeColor(app.accentColor, '#7aaaff')
      const aura = safeColor(app.auraColor, '#e4edfd')
      const acc = app.accessories || {}
      const form = app.formPreset || 'whale-girl'
      const bob = Math.sin(t / 900) * 1.2
      const scale = Math.max(0.6, Math.min(1.5, Number(app.scale) || 1))
      ctx.clearRect(0, 0, w, hh)
      ctx.save()
      ctx.translate(w / 2, hh / 2 + bob)
      // Normalise to the design system's 24-unit grid whatever the canvas backing store is.
      ctx.scale((w / 48) * scale, (w / 48) * scale)

      const glow = ctx.createRadialGradient(0, 0, 3, 0, 0, 22)
      glow.addColorStop(0, aura)
      glow.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.globalAlpha = 0.9
      ctx.fillStyle = glow
      ctx.beginPath()
      ctx.arc(0, 0, 22, 0, Math.PI * 2)
      ctx.fill()
      ctx.globalAlpha = 1

      if (form === 'astral-orb') {
        const g = ctx.createRadialGradient(-4, -4, 1, 0, 0, 12)
        g.addColorStop(0, '#ffffff')
        g.addColorStop(0.45, primary)
        g.addColorStop(1, accent)
        ctx.fillStyle = g
        ctx.beginPath()
        ctx.arc(0, 0, 11.5, 0, Math.PI * 2)
        ctx.fill()
      } else {
        // body
        ctx.fillStyle = form === 'cyber-muse' ? accent : form === 'neko-hacker' ? '#c9d3e4' : primary
        ctx.beginPath()
        ctx.ellipse(0, 3.6, 10.2, 12, 0, 0, Math.PI * 2)
        ctx.fill()
        // head
        ctx.fillStyle = form === 'neko-hacker' ? '#e7ecf5' : '#f9fafb'
        ctx.beginPath()
        ctx.arc(0, -6, 7.8, 0, Math.PI * 2)
        ctx.fill()
        if (form === 'neko-hacker') {
          ctx.fillStyle = accent
          ctx.beginPath()
          ctx.moveTo(-7.2, -9.6); ctx.lineTo(-4.8, -16.8); ctx.lineTo(-1.8, -12)
          ctx.moveTo(7.2, -9.6); ctx.lineTo(4.8, -16.8); ctx.lineTo(1.8, -12)
          ctx.fill()
        } else if (form === 'whale-girl') {
          ctx.fillStyle = primary
          ctx.beginPath()
          ctx.ellipse(10.8, 6, 4.2, 2.4, -0.5, 0, Math.PI * 2)
          ctx.fill()
        } else {
          ctx.strokeStyle = primary
          ctx.lineWidth = 1.2
          ctx.beginPath()
          ctx.arc(0, -6, 9.6, Math.PI * 1.1, Math.PI * 1.9)
          ctx.stroke()
        }
      }

      // face
      if (form !== 'astral-orb') {
        ctx.fillStyle = '#1b1b1c'
        const sleepy = mood === 'sleepy'
        const eyeH = sleepy ? 0.7 : 1.9
        ctx.fillRect(-4.2, -7.2, 2.1, eyeH)
        ctx.fillRect(2.4, -7.2, 2.1, eyeH)
        ctx.strokeStyle = '#1b1b1c'
        ctx.lineWidth = 0.85
        ctx.beginPath()
        const sad = mood === 'sad' || mood === 'hungry'
        if (sad) ctx.arc(0, -1.8, 1.8, Math.PI * 1.1, Math.PI * 1.9)
        else ctx.arc(0, -3.6, 1.9, Math.PI * 0.1, Math.PI * 0.9)
        ctx.stroke()
      }

      if (acc.ironBowl) {
        ctx.fillStyle = '#adb2b8'
        ctx.beginPath()
        ctx.arc(0, -13.2, 5.4, Math.PI, 0)
        ctx.fill()
      }
      if (acc.holoHeadset) {
        ctx.strokeStyle = primary
        ctx.lineWidth = 1.2
        ctx.beginPath()
        ctx.arc(0, -7.2, 8.7, Math.PI * 1.05, Math.PI * 1.95)
        ctx.stroke()
      }
      if (acc.quantumHalo) {
        ctx.strokeStyle = accent
        ctx.lineWidth = 1.1
        ctx.beginPath()
        ctx.ellipse(0, -16.8, 6.6, 2.1, 0, 0, Math.PI * 2)
        ctx.stroke()
      }
      ctx.restore()
    }

module.exports = { drawAvatar }
