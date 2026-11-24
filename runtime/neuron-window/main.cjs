'use strict';
// 星空独立大窗主进程:一扇正常的带边框窗(可拉伸/最大化),不透明、不穿透——
// 桌宠窗那些 Windows 透明窗坑这里都不涉及。关窗即退出;关前把 bounds 回传落盘。
const path = require('node:path')
const { app, BrowserWindow, ipcMain } = require('electron')

if (process.env.SOULMATE_NEURON_WINDOW_DEBUG) {
  app.commandLine.appendSwitch('remote-debugging-port', String(process.env.SOULMATE_NEURON_WINDOW_DEBUG))
}

let win = null
let origin = ''

function rememberedBounds() {
  try {
    const b = JSON.parse(process.env.SOULMATE_NEURON_BOUNDS || 'null')
    if (b && Number.isFinite(b.width) && Number.isFinite(b.height)) return b
  } catch { /* fall through */ }
  return { width: 1100, height: 760 }
}

async function postBounds() {
  if (!win || win.isDestroyed() || !origin) return
  try {
    const b = win.getNormalBounds ? win.getNormalBounds() : win.getBounds()
    await fetch(origin + 'dsh-soulmate/api/neuron-window/bounds', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(b),
    })
  } catch { /* best-effort: a lost bounds write must not block closing */ }
}

function createWindow() {
  const url = process.env.SOULMATE_NEURON_WINDOW_URL
  if (!url) {
    console.error('[soulmate-neuron-window] SOULMATE_NEURON_WINDOW_URL missing')
    app.quit()
    return
  }
  origin = url
  const b = rememberedBounds()
  win = new BrowserWindow({
    x: Number.isFinite(b.x) ? b.x : undefined,
    y: Number.isFinite(b.y) ? b.y : undefined,
    width: b.width,
    height: b.height,
    minWidth: 480,
    minHeight: 360,
    backgroundColor: '#05070f',
    title: '记忆星空',
    autoHideMenuBar: true,
    // A dashboard you open *to watch* must not slide behind a maximized DSH. Keep it
    // above normal windows at the same level the pet overlay uses; it closes normally.
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  })
  win.webContents.setBackgroundThrottling(false)
  win.webContents.on('context-menu', (event) => event.preventDefault())
  win.on('close', () => { postBounds() })
  win.on('closed', () => { win = null; app.quit() })
  // Surface it above the maximized DSH instead of hoping focus wins the z-order race.
  win.once('ready-to-show', () => {
    win.setAlwaysOnTop(true, 'screen-saver')
    win.show()
    win.focus()
    if (typeof win.moveTop === 'function') win.moveTop()
  })
  if (!Number.isFinite(b.x) && !Number.isFinite(b.y)) win.center()
  win.loadURL(url).catch((error) => {
    console.error('[soulmate-neuron-window] page load failed:', error)
    app.quit()
  })
}

app.whenReady().then(() => {
  ipcMain.on('neuron-window:close', () => { if (win && !win.isDestroyed()) win.close() })
  createWindow()
})
app.on('window-all-closed', () => app.quit())