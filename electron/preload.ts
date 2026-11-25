const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('redaction', {
  open: (mode?: 'restore') => ipcRenderer.invoke('redaction:open', mode),
  decodeImport: (mode?: 'restore') => ipcRenderer.invoke('redaction:decode-gb18030', mode),
  inferenceSettings: () => ipcRenderer.invoke('redaction:inference-settings'),
  setProvider: (provider: string) => ipcRenderer.invoke('redaction:set-provider', provider),
  onOpenSettings: (callback: () => void) => ipcRenderer.on('redaction:open-settings', () => callback()),
  initialProject: () => ipcRenderer.invoke('redaction:initial-project'),
  openProject: (password?: string | null) => ipcRenderer.invoke('redaction:open-project', password),
  saveProject: (saveAs: boolean) => ipcRenderer.invoke('redaction:save-project', saveAs),
  projectPasswordStatus: () => ipcRenderer.invoke('redaction:project-password-status'),
  changeProjectPassword: (password: string | null) => ipcRenderer.invoke('redaction:change-project-password', password),
  onProjectCommand: (callback: (command: string) => void) => {
    ipcRenderer.on('redaction:project-command', (_event: unknown, command: string) => callback(command));
  },
  engine: (request: object) => ipcRenderer.invoke('redaction:engine', request),
  cancel: () => ipcRenderer.invoke('redaction:cancel'),
  setDraftDirty: (dirty: boolean) => ipcRenderer.send('redaction:draft-dirty', dirty),
  recordRender: (milliseconds: number) => ipcRenderer.send('redaction:rendered', milliseconds),
  closeWorkspace: (discard: boolean) => ipcRenderer.invoke('redaction:close', discard),
  copy: (output: string) => ipcRenderer.invoke('redaction:copy', output),
  save: (output: string, sourcePaths: string[], filename: string, mode?: 'restore') =>
    ipcRenderer.invoke('redaction:save', { output, sourcePaths, filename, mode }),
  onProgress: (callback: (phase: string) => void) => {
    ipcRenderer.on('redaction:progress', (_event: unknown, phase: string) => callback(phase));
  },
  onConfirmClose: (callback: () => void) => {
    ipcRenderer.on('redaction:confirm-close', () => callback());
  },
});
