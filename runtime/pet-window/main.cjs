'use strict';
// 桌面独立窗口主进程:一块覆盖主屏工作区的透明置顶画布,页内跑插件自带的桌宠引擎。
// 穿透双通道:渲染端命中即时翻转(forward 钩子)+ 光标轮询兜底(Windows 上 forward 可能静默失效)。
const path = require('node:path')
const { app, BrowserWindow, screen, ipcMain } = require('electron')
const { decideIgnore } = require('./ignore.cjs')

const POINTER_POLL_MS = 60

let win = null
let body = null // { rect, busy } 渲染端上报(内容区坐标)
let ignoring = true

function setIgnore(next) {
  if (!win || win.isDestroyed() || next === ignoring) return
  ignoring = next
  win.setIgnoreMouseEvents(next, { forward: true })
}

function createWindow() {
  // 跨多屏:窗口 = 所有显示器 bounds 的外接矩形(贴屏幕范围,不含工作区内缩);
  // 逐屏矩形经 query 注入渲染端,物理按「列」取上下边界——屏缝不是墙,无屏的洞列是墙。
  const displays = screen.getAllDisplays()
  const hull = displays.reduce((a, d) => {
    const b = d.bounds
    return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), r: Math.max(a.r, b.x + b.width), b: Math.max(a.b, b.y + b.height) }
  }, { x: Infinity, y: Infinity, r: -Infinity, b: -Infinity })
  const rel = displays.map((d) => ({ x: d.bounds.x - hull.x, y: d.bounds.y - hull.y, w: d.bounds.width, h: d.bounds.height }))
  const area = { x: hull.x, y: hull.y, width: hull.r - hull.x, height: hull.b - hull.y }
  win = new BrowserWindow({
    x: area.x,
    y: area.y,
    width: area.width,
    height: area.height,
    show: false,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    focusable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.webContents.setBackgroundThrottling(false)
  win.webContents.on('context-menu', (event) => event.preventDefault())
  setIgnore(true)
  win.on('show', () => {
    win.setSkipTaskbar(true)
    setTimeout(() => { if (!win.isDestroyed()) win.setSkipTaskbar(true) }, 0)
  })
  win.once('ready-to-show', () => win.showInactive())
  // paintWhenInitiallyHidden 默认行为下首帧可能不产出,ready-to-show 永不触发 → 兜底显示
  win.webContents.once('did-finish-load', () => {
    setTimeout(() => { if (!win.isDestroyed() && !win.isVisible()) win.showInactive() }, 400)
  })
  win.on('closed', () => {
    win = null
    app.quit()
  })
  const url = process.env.SOULMATE_PET_WINDOW_URL
  if (!url) {
    console.error('[soulmate-pet-window] SOULMATE_PET_WINDOW_URL missing')
    app.quit()
    return
  }
  const target = new URL(url)
  target.searchParams.set('screens', JSON.stringify(rel))
  win.loadURL(target.toString()).catch((error) => {
    console.error('[soulmate-pet-window] page load failed:', error)
    app.quit()
  })
}

app.whenReady().then(() => {
  ipcMain.on('pet-window:hit', (_event, on) => {
    // 忙(拖拽/飞行)期间渲染端命中通道让位给兜底泵,避免松手瞬间误穿透
    if (body && body.busy) return
    setIgnore(!on)
  })
  ipcMain.on('pet-window:body', (_event, payload) => {
    body = payload && payload.rect ? { rect: payload.rect, busy: !!payload.busy } : null
  })
  createWindow()
  const timer = setInterval(() => {
    if (!win || win.isDestroyed()) return
    const bounds = win.getContentBounds()
    const cursor = screen.getCursorScreenPoint()
    const point = { x: cursor.x - bounds.x, y: cursor.y - bounds.y }
    setIgnore(decideIgnore(body && body.rect, !!(body && body.busy), point))
  }, POINTER_POLL_MS)
  timer.unref?.()
  app.on('before-quit', () => clearInterval(timer))
})

app.on('window-all-closed', () => app.quit())