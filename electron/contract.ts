import type { Backend, InferenceStatus } from '../engine/inference-devices.js';
import type { PreferencePatch, PreferenceSnapshot, SettingsChanges, SettingsSection, UpdateStatus, ViewOptions, ViewSwitch } from '../engine/preferences.js';
import type { materialView, WorkspaceReplies, WorkspaceView, WorkspaceWorkerReply } from '../engine/workspace.js';
import type { Material, Occurrence, Request, Row, Workspace } from '../engine/workspace-types.js';

export type SourceFile = { path: string; title: string; text: string; encoding: string };
export type ImportSelection = SourceFile | { requiresEncoding: true; title: string };
export type ProjectProtection = { salt: Buffer; key: Buffer };
export type ProjectOpening = { view: WorkspaceView } | { locked: true; title: string } | null;
export type ProjectDestination = { name: string; directory: string };
export type ProjectSaveResult = { dirty: boolean } | null;
export type ProjectCommand = 'open' | 'save' | 'saveAs' | 'password';
export type WindowMenuItem = { type: 'separator' } | {
  type: 'command'; label: string; accelerator?: string; viewSwitch?: ViewSwitch;
};
export type WindowChrome = {
  title: string; mac: boolean; view: ViewOptions;
  menus: { label: string; items: WindowMenuItem[] }[];
};
export type ProjectSaveStatus = ProjectDestination & { hasFile: boolean; protected: boolean };
export type EngineRequest = Exclude<Request, {op: 'output' | 'scan'}>
  | {op: 'open'; materialId: string}
  | {op: 'output'; materialId: string}
  | {op: 'findOriginal'; text: string}
  | (Extract<Request, {op: 'scan'}> & {queueMs?: number});
type EngineReplies = Omit<WorkspaceReplies, 'output'> & {
  open: {current: ReturnType<typeof materialView>};
  output: Exclude<WorkspaceReplies['output'], {decisions: Row[]}>;
  findOriginal: Occurrence[];
};
export type EngineReply<R extends EngineRequest> = EngineReplies[R['op']];

export type RedactionAPI = {
  windowChrome: () => Promise<WindowChrome>;
  onWindowTitle: (callback: (title: string) => void) => void;
  runWindowMenu: (menu: number, item: number) => Promise<void>;
  preferences: () => Promise<PreferenceSnapshot>;
  changePreferences: (patch: PreferencePatch) => Promise<PreferenceSnapshot>;
  applySettings: (changes: SettingsChanges, reset: boolean) => Promise<PreferenceSnapshot>;
  onPreferencesChanged: (callback: (snapshot: PreferenceSnapshot, reset: boolean) => void) => void;
  openSettings: (section?: SettingsSection) => Promise<void>;
  onSettingsSection: (callback: (section: SettingsSection) => void) => void;
  settingsInfo: () => Promise<{ version: string; update: UpdateStatus; backends: (Backend | 'auto')[]; inference: InferenceStatus }>;
  onInferenceStatus: (callback: (status: InferenceStatus) => void) => void;
  checkUpdates: () => Promise<void>;
  onUpdateStatus: (callback: (status: UpdateStatus) => void) => void;
  openProductLink: (target: 'homepage' | 'release' | 'download') => Promise<void>;
  readProductLicense: () => Promise<string>;
  open: (mode?: 'restore') => Promise<ImportSelection | null>;
  onWordExtracting: (callback: () => void) => void;
  cancelWordImport: () => void;
  decodeImport: (mode?: 'restore') => Promise<SourceFile>;
  initialProject: () => Promise<ProjectOpening | { warning: string }>;
  openProject: (password?: string | null) => Promise<ProjectOpening>;
  saveProject: (password?: string | null, destination?: ProjectDestination) => Promise<ProjectSaveResult>;
  projectSaveStatus: () => Promise<ProjectSaveStatus>;
  pickProjectDirectory: (directory: string) => Promise<string | null>;
  onProjectCommand: (callback: (command: ProjectCommand) => void) => void;
  engine: <R extends EngineRequest>(request: R) => Promise<EngineReply<R>>;
  cancel: () => Promise<void>;
  setDraftDirty: (dirty: boolean) => void;
  recordRender: (milliseconds: number) => void;
  closeWorkspace: (discard: boolean) => Promise<void>;
  copy: (text: string) => Promise<void>;
  save: (output: string, sourcePaths: string[], filename: string, mode?: 'restore') => Promise<string | null>;
  onProgress: (callback: (message: string) => void) => void;
  onConfirmClose: (callback: () => void) => void;
};

export type WorkspaceJob = {id: number} & (
  {material: Material} | {state: Workspace; request: Request; provider: string; rulesOnly: boolean}
);
export type WorkspaceResult = WorkspaceWorkerReply | EngineReplies['open'];
export type WorkspaceWorkerMessage = {id: number} & (
  {inference: {texts: string[]; labels: string[]}} | {diagnostic: Record<string, unknown>} |
  {phase: string} | {error: string} | {result: WorkspaceResult}
);
