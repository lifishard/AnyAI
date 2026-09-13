'use strict';
const { contextBridge, ipcRenderer } = require('electron');

/**
 * 渲染进程能看到的全部能力，一个不多。
 * 网络请求、文件读写、密钥、子进程都在主进程里做；
 * 渲染进程拿不到 Node，也拿不到任何明文密钥。
 */
contextBridge.exposeInMainWorld('snc', {
  platform: 'electron',
  runSave: (record) => ipcRenderer.invoke('snc:runSave', record),
  runList: () => ipcRenderer.invoke('snc:runList'),
  saveAnalysisExport: (name, bytes) => ipcRenderer.invoke('snc:saveAnalysisExport',{name,bytes}),
  runRemove: (id) => ipcRenderer.invoke('snc:runRemove', id),
  exchanges: (runId) => ipcRenderer.invoke('snc:exchanges', runId),
  verifyFiles: (paths, roots) => ipcRenderer.invoke('snc:verifyFiles', { paths, roots }),
  saveArtifact: (name, text, sourcePath) => ipcRenderer.invoke('snc:saveArtifact', { name, text, sourcePath }),

  chat: (init) => ipcRenderer.invoke('snc:chat', init),
  abort: (requestId) => ipcRenderer.invoke('snc:abort', requestId),
  getJson: (url, headers, timeoutMs) =>
    ipcRenderer.invoke('snc:getJson', { url, headers, timeoutMs }),

  tool: (name, args, ctx) => ipcRenderer.invoke('snc:tool', { name, args, ctx }),

  onEvent: (cb) => {
    const listener = (_e, msg) => cb(msg);
    ipcRenderer.on('snc:event', listener);
    return () => ipcRenderer.removeListener('snc:event', listener);
  },

  kvGet: (key) => ipcRenderer.invoke('snc:kvGet', key),
  kvSet: (key, value) => ipcRenderer.invoke('snc:kvSet', { key, value }),
  secretGet: (id) => ipcRenderer.invoke('snc:secretGet', id),
  secretSet: (id, value) => ipcRenderer.invoke('snc:secretSet', { id, value }),
  secretDelete: (id) => ipcRenderer.invoke('snc:secretDelete', id),

  info: () => ipcRenderer.invoke('snc:info'),
  pickFolder: () => ipcRenderer.invoke('snc:pickFolder'),
  pickFiles: (mode) => ipcRenderer.invoke('snc:pickFiles', mode),

  revealPath: (p) => ipcRenderer.invoke('snc:revealPath', p),
  openPath: (p) => ipcRenderer.invoke('snc:openPath', p),
  readArtifact: (p, maxBytes) => ipcRenderer.invoke('snc:readArtifact', { path: p, maxBytes }),

  skillsRead: (dir) => ipcRenderer.invoke('snc:skillsRead', dir),
  skillsWrite: (dir, items) => ipcRenderer.invoke('snc:skillsWrite', { dir, items }),
  skillsDefaultDir: () => ipcRenderer.invoke('snc:skillsDefaultDir'),

  chromeLaunch: (port, path) => ipcRenderer.invoke('snc:chromeLaunch', { port, path }),
  chromeStatus: (port) => ipcRenderer.invoke('snc:chromeStatus', port),

  remoteStart: (port, token) => ipcRenderer.invoke('snc:remoteStart', { port, token }),
  remoteStop: () => ipcRenderer.invoke('snc:remoteStop'),
  remoteStatus: () => ipcRenderer.invoke('snc:remoteStatus'),
});
