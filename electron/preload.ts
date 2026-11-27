import type { RedactionAPI } from './contract.js';
const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron');

const api: RedactionAPI = {
  windowChrome: () => ipcRenderer.invoke('redaction:window-chrome'),
  onWindowTitle: callback => {
    ipcRenderer.on('redaction:window-title', (_event, title: string) => callback(title));
  },
  runWindowMenu: (menu, item) => ipcRenderer.invoke('redaction:window-menu', menu, item),
  open: (mode?: 'restore') => ipcRenderer.invoke('redaction:open', mode),
  onWordExtracting: (callback: () => void) => ipcRenderer.on('redaction:word-extracting', () => callback()),
  cancelWordImport: () => ipcRenderer.send('redaction:cancel-word-import'),
  decodeImport: (mode?: 'restore') => ipcRenderer.invoke('redaction:decode-gb18030', mode),
  preferences: () => ipcRenderer.invoke('redaction:preferences'),
  changePreferences: (patch: import('../engine/preferences.js').PreferencePatch) => ipcRenderer.invoke('redaction:change-preferences', patch),
  applySettings: (changes: import('../engine/preferences.js').SettingsChanges, reset: boolean) =>
    ipcRenderer.invoke('redaction:apply-settings', changes, reset),
  onPreferencesChanged: (callback) => {
    ipcRenderer.on('redaction:preferences-changed', (_event: unknown, snapshot, reset) => callback(snapshot, reset));
  },
  openSettings: (section?: import('../engine/preferences.js').SettingsSection) => ipcRenderer.invoke('redaction:open-settings', section),
  onSettingsSection: (callback) => {
    ipcRenderer.on('redaction:settings-section', (_event: unknown, section) => callback(section));
  },
  settingsInfo: () => ipcRenderer.invoke('redaction:settings-info'),
  onInferenceStatus: (callback) => {
    ipcRenderer.on('redaction:inference-status', (_event: unknown, status) => callback(status));
  },
  checkUpdates: () => ipcRenderer.invoke('redaction:check-updates'),
  onUpdateStatus: (callback) => {
    ipcRenderer.on('redaction:update-status', (_event: unknown, status) => callback(status));
  },
  openProductLink: (target: 'homepage' | 'release' | 'download') => ipcRenderer.invoke('redaction:open-product-link', target),
  readProductLicense: () => ipcRenderer.invoke('redaction:read-product-license'),
  initialProject: () => ipcRenderer.invoke('redaction:initial-project'),
  openProject: (password?: string | null) => ipcRenderer.invoke('redaction:open-project', password),
  saveProject: (password?: string | null, destination?: import('./contract.js').ProjectDestination) =>
    ipcRenderer.invoke('redaction:save-project', password, destination),
  projectSaveStatus: () => ipcRenderer.invoke('redaction:project-save-status'),
  pickProjectDirectory: (directory: string) => ipcRenderer.invoke('redaction:project-save-directory', directory),
  onProjectCommand: (callback) => {
    ipcRenderer.on('redaction:project-command', (_event: unknown, command: import('./contract.js').ProjectCommand) => callback(command));
  },
  engine: (request) => ipcRenderer.invoke('redaction:engine', request),
  cancel: () => ipcRenderer.invoke('redaction:cancel'),
  setDraftDirty: (dirty: boolean) => ipcRenderer.send('redaction:draft-dirty', dirty),
  recordRender: (milliseconds: number) => ipcRenderer.send('redaction:rendered', milliseconds),
  closeWorkspace: (discard: boolean) => ipcRenderer.invoke('redaction:close', discard),
  copy: (output: string) => ipcRenderer.invoke('redaction:copy', output),
  save: (output: string, sourcePaths: string[], filename: string, mode?: 'restore') =>
    ipcRenderer.invoke('redaction:save', { output, sourcePaths, filename, mode }),
  onProgress: (callback) => {
    ipcRenderer.on('redaction:progress', (_event: unknown, phase: string) => callback(phase));
  },
  onConfirmClose: (callback) => {
    ipcRenderer.on('redaction:confirm-close', () => callback());
  },
};
contextBridge.exposeInMainWorld('redaction', api);
