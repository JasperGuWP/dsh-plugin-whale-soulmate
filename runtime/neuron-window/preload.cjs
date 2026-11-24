'use strict';
// 星空窗渲染端:Esc 关窗走主进程 close(先落 bounds 再退),页面里 window.close 不可靠。
const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('__neuronWindow', {
  close: () => ipcRenderer.send('neuron-window:close'),
})