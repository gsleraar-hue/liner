const { contextBridge, ipcRenderer } = require('electron');
const { pathToFileURL } = require('url');

contextBridge.exposeInMainWorld('liner', {
  settings: () => ipcRenderer.invoke('settings'),
  voices: () => ipcRenderer.invoke('voices'),
  scan: url => ipcRenderer.invoke('scan', url),
  sample: args => ipcRenderer.invoke('sample', args),
  preview: args => ipcRenderer.invoke('preview', args),
  build: args => ipcRenderer.invoke('build', args),
  cancel: () => ipcRenderer.invoke('cancel'),
  pickFolder: current => ipcRenderer.invoke('pick-folder', current),
  reveal: p => ipcRenderer.invoke('reveal', p),
  openFile: p => ipcRenderer.invoke('open-file', p),
  lexiconList: url => ipcRenderer.invoke('lexicon-list', url),
  lexiconSet: args => ipcRenderer.invoke('lexicon-set', args),
  say: args => ipcRenderer.invoke('say', args),
  updateState: () => ipcRenderer.invoke('update-state'),
  updateInstall: () => ipcRenderer.invoke('update-install'),
  onUpdate: fn => ipcRenderer.on('update', (e, d) => fn(d)),
  elKey: key => ipcRenderer.invoke('el-key', key),
  elInfo: () => ipcRenderer.invoke('el-info'),
  cacheReport: () => ipcRenderer.invoke('cache-report'),
  cacheClean: keys => ipcRenderer.invoke('cache-clean', keys),
  fileUrl: p => pathToFileURL(p).href,
  onProgress: fn => ipcRenderer.on('progress', (e, d) => fn(d)),
  onLog: fn => ipcRenderer.on('log', (e, d) => fn(d))
});
