'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('novelDesktop', Object.freeze({
  selectFolder: () => ipcRenderer.invoke('novel-editor:select-folder'),
}));
