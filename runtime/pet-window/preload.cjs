'use strict';
// 渲染端 → 主进程的唯一桥:身体矩形/忙碌态(兜底泵用)与即时命中翻转(forward 钩子用)。
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('smPetWindow', {
  setHit: (on) => ipcRenderer.send('pet-window:hit', !!on),
  setBody: (rect, busy, hit) => ipcRenderer.send('pet-window:body', { rect, busy: !!busy, hit: !!hit }),
  onCursor: (cb) => ipcRenderer.on('pet-window:cursor', (_event, p) => cb(p)),
})