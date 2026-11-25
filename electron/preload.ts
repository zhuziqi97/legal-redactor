const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('redaction', {
  open: () => ipcRenderer.invoke('redaction:open'),
  decodeImport: () => ipcRenderer.invoke('redaction:decode-gb18030'),
  inferenceSettings: () => ipcRenderer.invoke('redaction:inference-settings'),
  setProvider: (provider: string) => ipcRenderer.invoke('redaction:set-provider', provider),
  onOpenSettings: (callback: () => void) => ipcRenderer.on('redaction:open-settings', () => callback()),
  initialProject: () => ipcRenderer.invoke('redaction:initial-project'),
  openProject: () => ipcRenderer.invoke('redaction:open-project'),
  saveProject: (saveAs: boolean) => ipcRenderer.invoke('redaction:save-project', saveAs),
  onProjectCommand: (callback: (command: string) => void) => {
    ipcRenderer.on('redaction:project-command', (_event: unknown, command: string) => callback(command));
  },
  engine: (request: object) => ipcRenderer.invoke('redaction:engine', request),
  cancel: () => ipcRenderer.invoke('redaction:cancel'),
  recordRender: (milliseconds: number) => ipcRenderer.send('redaction:rendered', milliseconds),
  closeWorkspace: (discard: boolean) => ipcRenderer.invoke('redaction:close', discard),
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
