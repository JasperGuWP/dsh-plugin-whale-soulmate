'use strict';
// 桌面独立窗口主进程:一块覆盖主屏工作区的透明置顶画布,页内跑插件自带的桌宠引擎。
// 穿透双通道:渲染端命中即时翻转(forward 钩子)+ 光标轮询兜底(Windows 上 forward 可能静默失效)。
const path = require('node:path')
const { app, BrowserWindow, screen, ipcMain } = require('electron')
const { decideIgnore } = require('./ignore.cjs')

const POINTER_POLL_MS = 60

// 开发/实测 affordance:仅当显式设置环境变量时开 loopback 调试端口
if (process.env.SOULMATE_PET_WINDOW_DEBUG) {
  app.commandLine.appendSwitch('remote-debugging-port', String(process.env.SOULMATE_PET_WINDOW_DEBUG))
}

let win = null
let body = null // { rect, busy, hit } 渲染端上报(内容区坐标;hit=光标处是否不透明像素)
let ignoring = true

function setIgnore(next) {
  if (!win || win.isDestroyed() || next === ignoring) return
  ignoring = next
  win.setIgnoreMouseEvents(next, { forward: true })
}

// Windows 上 setBounds/show 可能重置 OS 层穿透旗标而镜像不知情:不强制回写,
// 整窗会一直收鼠标(桌面点不动),直到下次真实翻转才同步。
function reassertIgnore() {
  if (win && !win.isDestroyed()) win.setIgnoreMouseEvents(ignoring, { forward: true })
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
    reassertIgnore()
  })
  win.once('ready-to-show', () => {
    // Windows 建窗时把透明窗夹到主屏工作区;首帧后再 setBounds 才拿得到跨屏 hull
    win.setBounds(area)
    reassertIgnore()
    win.showInactive()
  })
  // paintWhenInitiallyHidden 默认行为下首帧可能不产出,ready-to-show 永不触发 → 兜底显示
  win.webContents.once('did-finish-load', () => {
    setTimeout(() => {
      if (!win.isDestroyed() && !win.isVisible()) {
        win.setBounds(area)
        reassertIgnore()
        win.showInactive()
      }
    }, 400)
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
    body = payload && payload.rect ? { rect: payload.rect, busy: !!payload.busy, hit: !!payload.hit } : null
  })
  createWindow()
  let ticks = 0
  const timer = setInterval(() => {
    if (!win || win.isDestroyed()) return
    const bounds = win.getContentBounds()
    const cursor = screen.getCursorScreenPoint()
    const point = { x: cursor.x - bounds.x, y: cursor.y - bounds.y }
    // Windows 的 forward 鼠标钩子可能静默失效:穿透期间渲染端收不到 mousemove,
    // 主动把光标送过去,alpha 采样才不滞后(包围盒内透明穿透依赖它)。
    if (!win.isDestroyed()) win.webContents.send('pet-window:cursor', { x: cursor.x, y: cursor.y })
    setIgnore(decideIgnore(body && body.rect, !!(body && body.busy), point, !!(body && body.hit)))
    // 低频无条件回写:OS 旗标被外部重置时镜像不知情,靠这拍自愈
    if (++ticks % 16 === 0) reassertIgnore()
  }, POINTER_POLL_MS)
  timer.unref?.()
  app.on('before-quit', () => clearInterval(timer))
})

app.on('window-all-closed', () => app.quit())