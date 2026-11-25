const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('redaction', {
  open: () => ipcRenderer.invoke('redaction:open'),
  decodeImport: () => ipcRenderer.invoke('redaction:decode-gb18030'),
  inferenceSettings: () => ipcRenderer.invoke('redaction:inference-settings'),
  setProvider: (provider: string) => ipcRenderer.invoke('redaction:set-provider', provider),
  onOpenSettings: (callback: () => void) => ipcRenderer.on('redaction:open-settings', () => callback()),
  engine: (request: object) => ipcRenderer.invoke('redaction:engine', request),
  cancel: () => ipcRenderer.invoke('redaction:cancel'),
  recordRender: (milliseconds: number) => ipcRenderer.send('redaction:rendered', milliseconds),
  closeWorkspace: () => ipcRenderer.invoke('redaction:close'),
  copy: (output: string) => ipcRenderer.invoke('redaction:copy', output),
  save: (output: string, sourcePaths: string[], filename: string) =>
    ipcRenderer.invoke('redaction:save', { output, sourcePaths, filename }),
  onProgress: (callback: (phase: string) => void) => {
    ipcRenderer.on('redaction:progress', (_event: unknown, phase: string) => callback(phase));
  },
  onConfirmClose: (callback: () => void) => {
    ipcRenderer.on('redaction:confirm-close', () => callback());
  },
});
