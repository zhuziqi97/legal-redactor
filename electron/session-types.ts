import type { ProjectProtection, WorkspaceResult } from './contract.js';
import type { InferenceDevice } from '../engine/inference-devices.js';
import type { Preferences } from '../engine/preferences.js';
import type { WorkspaceView } from '../engine/workspace.js';
import type { Workspace } from '../engine/workspace-types.js';

type ProjectFile = { path: string; mtimeMs: number; size: number };
export type ProjectSnapshot = { state: Workspace; file: ProjectFile; view: WorkspaceView; protection?: ProjectProtection };

type Pending = {
  id: number;
  resolve: (result: WorkspaceResult) => void;
  reject: (error: Error) => void;
  progress: (phase: string) => void;
  device: InferenceDevice;
  watchdog?: { coldMs: number; warmMs: number; cold: boolean };
  inferenceError?: Error;
  started: number;
};

type TextImport = { path: string; title: string; bytes: Uint8Array; readMs: number };

export type Session = {
  state: Workspace;
  worker?: Electron.UtilityProcess;
  pending?: Pending;
  nextId: number;
  allowClose?: boolean;
  importInput?: TextImport;
  restoreInput?: TextImport;
  queue?: Promise<unknown>;
  analysis?: Session;
  scan?: { materialId: string; cancelled: boolean };
};

export type WindowSession = Session & {
  window: Electron.BrowserWindow;
  file?: ProjectFile;
  initialView?: WorkspaceView;
  resumeOnStartup?: boolean;
  fileOperation?: boolean;
  savingTo?: string;
  changeSeq: number;
  analysisRevision: number;
  savedSeq: number;
  editingDraft?: boolean;
  protection?: ProjectProtection;
  unlockPath?: string;
  cancelWordImport?: () => void;
  layoutSave?: { timer: ReturnType<typeof setTimeout>; layout: Preferences['usage']['window'] };
};
