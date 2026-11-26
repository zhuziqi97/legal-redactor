import type { EngineReply, EngineRequest, ImportSelection, ProjectCommand, ProjectDestination, ProjectOpening, ProjectProtection, ProjectSaveResult, ProjectSaveStatus, RedactionAPI } from './contract.js';
// Prefer Simplified Chinese glyphs in the native Linux menus.
if (process.platform === 'linux') process.env.FC_LANG ||= 'zh-cn';

const { app, BrowserWindow, Menu, clipboard, dialog, ipcMain, net, screen, shell, utilityProcess } = require('electron') as typeof import('electron');
const { existsSync, mkdirSync, statSync } = require('node:fs') as typeof import('node:fs');
const { appendFile, readFile, writeFile, realpath, mkdtemp, rename, rm, stat } = require('node:fs/promises') as typeof import('node:fs/promises');
const { Worker } = require('node:worker_threads') as typeof import('node:worker_threads');
const { decodeInput } = require('./text-input.cjs') as typeof import('./text-input.js');
const { findOriginal } = require('./text-engine.cjs') as typeof import('./text-engine.js');
const { projectProtection, readProject, writeProject } = require('./project-file.cjs') as typeof import('./project-file.js');
const { createPreferences } = require('./preferences.cjs') as typeof import('./preferences.js');
const { createUpdates } = require('./updates.cjs') as typeof import('./updates.js');
const { defaultPreferences, inferenceBackends, isSettingsSection, viewKeys, viewLabels } =
  require('./engine/preferences.js') as typeof import('../engine/preferences.js');
const { cpuDevice, deviceOption, previousDeviceLabel, selectDevice } =
  require('./engine/inference-devices.js') as typeof import('../engine/inference-devices.js');
const { basename, dirname, extname, join, resolve } = require('node:path') as typeof import('node:path');
type Workspace = import('../engine/workspace-types.js').Workspace;
type Request = import('../engine/workspace-types.js').Request;
type Preferences = import('../engine/preferences.js').Preferences;
type PreferencePatch = import('../engine/preferences.js').PreferencePatch;
type SettingsChanges = import('../engine/preferences.js').SettingsChanges;
type SettingsSection = import('../engine/preferences.js').SettingsSection;
type FolderKind = import('../engine/preferences.js').FolderKind;
type ViewSwitch = import('../engine/preferences.js').ViewSwitch;
type InferenceDevice = import('../engine/inference-devices.js').InferenceDevice;
type InferenceStatus = import('../engine/inference-devices.js').InferenceStatus;
type WorkspaceWorkerReply = import('../engine/workspace.js').WorkspaceWorkerReply;
type Prediction = import('../engine/model.js').Prediction;
type WorkspaceWorkerMessage = import('./contract.js').WorkspaceWorkerMessage;
type WorkspaceView = import('../engine/workspace.js').WorkspaceView;
type ProjectFile = { path: string; mtimeMs: number; size: number };

type Pending = {
  id: number;
  resolve: (result: WorkspaceWorkerReply) => void;
  reject: (error: Error) => void;
  progress: (phase: string) => void;
  device: InferenceDevice;
  inferenceError?: Error;
  started: number;
};

const project = resolve(__dirname, '..');
const appPage = join(project, 'dist', 'index.html');
const applicationIcon = join(project, 'dist', process.platform === 'win32' ? 'legal-redactor-icon.ico' : 'legal-redactor-icon.png');
const bundledModel = join(process.resourcesPath, 'otter');
const nativeModel = app.isPackaged ? bundledModel : process.env.REDACTOR_ONNX_DIR;
const userData = process.env.REDACTOR_USER_DATA;
if (userData) {
  mkdirSync(userData, { recursive: true });
  app.setPath('userData', resolve(userData));
}

const nativeEnabled = !!nativeModel && existsSync(join(nativeModel, 'otter.onnx'));
const rulesOnly = !app.isPackaged && process.env.REDACTOR_RULES_ONLY === '1';
const preferences = createPreferences(app.getPath('userData'));
let settingsWindow: InstanceType<typeof BrowserWindow> | undefined;
let settingsTarget: SettingsSection | undefined;
let lastProjectPath: string | undefined;
let lastWorkspaceId: number | undefined;

function broadcast(channel: string, ...args: unknown[]) {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.webContents.isDestroyed()) window.webContents.send(channel, ...args);
  }
}

function syncViewMenu() {
  for (const key of viewKeys) {
    const item = Menu.getApplicationMenu()?.getMenuItemById('view-' + key);
    if (item) item.checked = preferences.value.view[key];
  }
}

async function changePreferences(change: (next: Preferences) => Preferences | void, reset = false) {
  const before = preferences.value.updates.automatic;
  const previousChoice = preferences.value.inference.provider;
  let saved: boolean;
  try { saved = await preferences.update(change, reset); }
  catch (error) {
    syncViewMenu();
    broadcast('redaction:preferences-changed', preferences.snapshot(), false);
    throw error;
  }
  if (saved) {
    syncViewMenu();
    broadcast('redaction:preferences-changed', preferences.snapshot(), reset);
    if (reset || previousChoice !== preferences.value.inference.provider) {
      activeDevice = '';
      publishInferenceStatus();
    }
    if (!preferences.value.updates.automatic) updates.stopAutomatic();
    else if (!before || reset) void automaticCheck();
  }
  return preferences.snapshot();
}

const updates = createUpdates((url, options) => net.fetch(url, options), app.getVersion(), status => broadcast('redaction:update-status', status));
let schedulingUpdate = false;
async function automaticCheck() {
  const now = Date.now();
  const { automatic, lastAttempt } = preferences.value.updates;
  if (!automatic || schedulingUpdate || (lastAttempt <= now && now - lastAttempt < 86_400_000)) return;
  schedulingUpdate = true;
  try {
    await changePreferences(next => { if (next.updates.automatic) next.updates.lastAttempt = now; });
    if (preferences.value.updates.automatic) await updates.check(false);
  } catch {
    // The preference warning is shown in Settings. A failed write must not trigger repeated checks.
  } finally {
    schedulingUpdate = false;
  }
}

function directoryExists(path?: string) {
  return !!path && statSync(path, { throwIfNoEntry: false })?.isDirectory();
}

function preferredDirectory(kind: FolderKind) {
  const remembered: string | undefined = preferences.value.usage.folders[kind];
  try { if (remembered && directoryExists(remembered)) return remembered; } catch { /* Use the system directory. */ }
  const documents: string = app.getPath('documents');
  return existsSync(documents) ? documents : app.getPath('home');
}

function rememberFolder(kind: FolderKind, file: string) {
  if (!preferences.value.usage.rememberFolders) return;
  void changePreferences(next => { if (next.usage.rememberFolders) next.usage.folders[kind] = dirname(file); }).catch(() => {});
}

function rememberProject(path: string, rememberDirectory = true) {
  lastProjectPath = path;
  const { startupProject, rememberFolders } = preferences.value.usage;
  if (startupProject !== 'last' && !(rememberDirectory && rememberFolders)) return;
  void changePreferences(next => {
    if (next.usage.startupProject === 'last') next.usage.lastProject = path;
    if (rememberDirectory && next.usage.rememberFolders) next.usage.folders.project = dirname(path);
  }).catch(() => {});
}

type InferenceRoute = {reusedSession: boolean; loadMs: number};
type InferencePending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  progress?: (phase: string) => void;
};

class InferenceError extends Error {}

let detectedDevices: InferenceDevice[] = [];
let environmentReady = Promise.resolve();
let environmentDetected = false;
let autoUsesCpu = false;
let activeDevice = '';

function selectedDevice(choice = preferences.value.inference.provider) {
  return choice === 'auto' && autoUsesCpu ? cpuDevice : selectDevice(detectedDevices, choice);
}

function inferenceStatus(): InferenceStatus {
  const options = [{id: 'auto', label: '自动'}, deviceOption(cpuDevice), ...detectedDevices.map(deviceOption)];
  const {provider, label} = preferences.value.inference;
  const selected = selectedDevice();
  if (!selected) options.push({id: provider, label: previousDeviceLabel(provider, label) + (environmentDetected ? '（不可用）' : '')});
  return {options, selected: environmentDetected ? selected?.name ?? '' : '', active: activeDevice};
}

function publishInferenceStatus() {
  broadcast('redaction:inference-status', inferenceStatus());
}

async function detectEnvironment(window: InstanceType<typeof BrowserWindow>) {
  const started = performance.now();
  const allowed = new Set(inferenceBackends(process.platform, process.arch));
  try {
    const { devices, backends } = await infer('discover') as {devices: InferenceDevice[]; backends: string[]};
    detectedDevices = devices.filter(device => allowed.has(device.backend));
    diagnose({stage: 'inference-environment', backends, options: detectedDevices.map(device => device.backend),
      elapsedMs: performance.now() - started});
  } catch (error) {
    diagnose({stage: 'inference-environment', error: String(error), elapsedMs: performance.now() - started});
  }
  environmentDetected = true;
  publishInferenceStatus();
  if (!selectedDevice() && !window.isDestroyed()) {
    void dialog.showMessageBox(window, {
      type: 'warning', message: '所选推理设备不可用', buttons: ['重新选择', '稍后'], defaultId: 0, cancelId: 1,
    }).then(({ response }) => { if (response === 0) openSettings('inference'); });
  }
}

const inferencePending = new Map<number, InferencePending>();
let nativeWorker: ReturnType<typeof utilityProcess.fork> | undefined;
let inferenceId = 0;
function infer(op: 'discover' | 'prepare' | 'predict', device?: InferenceDevice, input?: { texts: string[]; labels: string[] },
  progress?: (phase: string) => void) {
  if (!nativeWorker) {
    const child = utilityProcess.fork(join(__dirname, 'inference-worker.cjs'), [], { serviceName: 'Otter ONNX Runtime' });
    child.on('message', (message: { id: number; result?: unknown; error?: string; phase?: string }) => {
      const waiter = inferencePending.get(message.id);
      if (!waiter) return;
      if (message.phase !== undefined) {
        waiter.progress?.(message.phase);
        return;
      }
      inferencePending.delete(message.id);
      if (message.error) waiter.reject(new InferenceError(message.error));
      else waiter.resolve(message.result);
    });
    child.on('exit', () => {
      if (nativeWorker !== child) return;
      nativeWorker = undefined;
      for (const waiter of inferencePending.values()) waiter.reject(new InferenceError('ONNX Runtime 进程已经退出。'));
      inferencePending.clear();
    });
    nativeWorker = child;
  }
  const id = ++inferenceId;
  const worker = nativeWorker;
  return new Promise((resolve, reject) => {
    inferencePending.set(id, { resolve, reject, progress });
    worker.postMessage(op === 'discover' ? { id, op } : { id, op, directory: nativeModel, device, ...input });
  });
}

type TextImport = { path: string; title: string; bytes: Uint8Array; readMs: number };

type Session = {
  state: Workspace;
  worker?: ReturnType<typeof utilityProcess.fork>;
  pending?: Pending;
  nextId: number;
  allowClose?: boolean;
  importInput?: TextImport;
  restoreInput?: TextImport;
  queue?: Promise<unknown>;
  analysis?: Session;
  scan?: { materialId: string; cancelled: boolean };
};

type WindowSession = Session & {
  window: InstanceType<typeof BrowserWindow>;
  file?: ProjectFile;
  initialView?: WorkspaceView;
  resumeOnStartup?: boolean;
  fileOperation?: boolean;
  savingTo?: string;
  changeSeq: number;
  savedSeq: number;
  editingDraft?: boolean;
  protection?: ProjectProtection;
  unlockPath?: string;
  cancelWordImport?: () => void;
  layoutSave?: { timer: ReturnType<typeof setTimeout>; layout: Preferences['usage']['window'] };
};

const sessions = new Map<number, WindowSession>();
const projectFilter = { name: 'LegalRedactor 项目', extensions: ['lrproj'] };
const comparablePath = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path;

function projectDirty(session: WindowSession) {
  return session.file ? session.changeSeq !== session.savedSeq : session.state.materials.length > 0;
}

function updateProjectTitle(session: WindowSession) {
  if (session.window.isDestroyed()) return;
  const name = session.file ? basename(session.file.path, extname(session.file.path)) : '未命名项目';
  session.window.setTitle(`${name}${projectDirty(session) ? ' *' : ''} · LegalRedactor`);
}

function projectChanged(session: WindowSession) {
  session.changeSeq++;
  updateProjectTitle(session);
}

function finishWorker(session: Session, child: ReturnType<typeof utilityProcess.fork>, message: string) {
  if (session.worker !== child) return;
  session.worker = undefined;
  const request = session.pending;
  session.pending = undefined;
  request?.reject(new Error(message));
}

function startWorker(session: Session) {
  const child = utilityProcess.fork(join(__dirname, 'workspace-worker.cjs'), [], { serviceName: '脱敏引擎' });
  session.worker = child;
  child.on('message', (message: WorkspaceWorkerMessage) => {
    const pending = session.pending;
    if (session.worker !== child || !pending || message.id !== pending.id) return;
    if ('inference' in message) {
      const reply = (value: object) => {
        if (session.worker === child && session.pending === pending) child.postMessage({id: pending.id, ...value});
      };
      infer('predict', pending.device, message.inference, pending.progress).then(result => {
        if (session.worker === child && session.pending === pending &&
            selectedDevice()?.id === pending.device.id && activeDevice !== pending.device.name) {
          activeDevice = pending.device.name;
          publishInferenceStatus();
        }
        reply({predictions: result as Prediction[][]});
      }, error => {
        pending.inferenceError = error;
        reply({inferenceError: error.message});
      });

      return;
    }
    if ('diagnostic' in message) {
      diagnose({...message.diagnostic, elapsedMs: performance.now() - pending.started});
      return;
    }
    if ('phase' in message) {
      pending.progress(message.phase);
      return;
    }
    session.pending = undefined;
    if ('error' in message) pending.reject(pending.inferenceError ?? new Error(message.error));
    else pending.resolve(message.result);
  });
  child.on('exit', () => finishWorker(session, child, '本地脱敏引擎已退出，请重试。'));
  return child;
}

async function runEngine<R extends Exclude<EngineRequest, {op: 'findOriginal'}>>(session: Session, request: R,
  progress: (phase: string) => void, device = cpuDevice): Promise<EngineReply<R>> {
  if (session.pending) throw new Error('请等待当前操作完成。');
  const child = session.worker ?? startWorker(session);
  const result = await new Promise<WorkspaceWorkerReply>((resolve, reject) => {
    const id = ++session.nextId;
    session.pending = {id, resolve, reject, progress, device, started: performance.now()};
    child.postMessage({id, state: session.state, request, provider: device.id, rulesOnly});
  });
  if (typeof result === 'object' && 'state' in result) {
    const {state, ...payload} = result;
    if (state) session.state = state;
    return payload as EngineReply<R>;
  }
  return result as EngineReply<R>;
}

function stopWorker(session: Session) {
  const child = session.worker;
  if (!child) return;
  finishWorker(session, child, '已取消识别。');
  child.kill();
}

function serialize<T>(session: Session, task: () => T | Promise<T>) {
  const result = (session.queue ?? Promise.resolve()).then(task);
  session.queue = result.catch(() => {});
  return result;
}

function cancelAnalysis(session: Session) {
  if (!session.scan) return;
  session.scan.cancelled = true;
  if (session.analysis) stopWorker(session.analysis);
}

async function analyze(session: WindowSession, input: Extract<Request, {op: 'scan' | 'reviseMaterial'}> & {queueMs?: number},
  progress: (phase: string) => void) {
  if (session.scan) throw new Error('当前工作区已有分析任务。');
  if (!nativeEnabled && !rulesOnly) throw new Error('找不到本地 ONNX 模型，请检查发行包资源或开发环境的 REDACTOR_ONNX_DIR。');
  const job = { materialId: input.materialId, cancelled: false };
  const preferredEP = preferences.value.inference.provider;
  const started = performance.now();
  session.scan = job;
  const analysis = session.analysis ??= { state: session.state, nextId: 0 };
  const assertCurrent = () => {
    if (job.cancelled) throw new Error('已取消识别。');
    const doc = session.state.materials.find(row => row.id === input.materialId);
    if (!doc || (doc.revision ?? 1) !== input.revision) throw new Error('材料已更新，请分析最新修订。');
  };
  let firstFeedbackMs: number | undefined;
  const phase = (message: string) => {
    if (job.cancelled) return;
    firstFeedbackMs ??= performance.now() - started;
    progress(message);
  };
  async function recognize(device: InferenceDevice, usedFallback: boolean) {
    const route = rulesOnly ? undefined : await infer('prepare', device, undefined, phase) as InferenceRoute;
    assertCurrent();
    for (;;) {
      const base = await serialize(session, () => { assertCurrent(); return session.state; });
      analysis.state = base;
      await runEngine(analysis, input, phase, device);
      const result = await serialize(session, async () => {
        assertCurrent();
        if (session.state.revision !== base.revision) return null;
        const exported = new Map(session.state.materials.map(doc => [doc.id, doc.exported]));
        for (const doc of analysis.state.materials) {
          const output = exported.get(doc.id);
          if (output === undefined) delete doc.exported;
          else doc.exported = output;
        }
        analysis.state.activeId = session.state.activeId;
        const previewStart = performance.now();
        const view = await runEngine(analysis, { op: 'view' }, phase);
        assertCurrent();
        session.state = analysis.state;
        if (session.state.revision !== base.revision) projectChanged(session);
        diagnose({stage: 'analysis-view', preferredEP, provider: route && device.backend,
          device: route && device.name, deviceIndex: route && device.index, usedFallback,
          reusedSession: route?.reusedSession, modelLoadMs: route?.loadMs, queueMs: input.queueMs ?? 0, firstFeedbackMs,
          previewMs: performance.now() - previewStart, elapsedMs: performance.now() - started});
        return view;
      });
      if (result) return result;
      phase('工作区已有更新，正在重新整理映射');
    }
  }
  try {
    await environmentReady;
    assertCurrent();
    let device = rulesOnly ? cpuDevice : selectedDevice(preferredEP);
    if (!device) throw new Error('所选推理设备不可用。请在设置中重新选择。');
    let usedFallback = false;
    for (;;) {
      try { return await recognize(device, usedFallback); }
      catch (failure) {
        assertCurrent();
        if (!(failure instanceof InferenceError)) throw failure;
        diagnose({stage: 'inference-error', preferredEP, provider: device.backend, message: failure.message});
        if (preferredEP === 'auto' && device.backend !== 'cpu') {
          autoUsesCpu = true;
          if (preferences.value.inference.provider === 'auto') activeDevice = '';
          publishInferenceStatus();
          device = cpuDevice;
          usedFallback = true;
          continue;
        }
        if (selectedDevice()?.id === device.id) {
          activeDevice = '';
          publishInferenceStatus();
        }
        throw new Error(preferredEP === 'auto' ? '识别失败，请重试。' : '所选设备无法完成识别。请在设置中重新选择或重试。');
      }
    }
  } finally {
    session.scan = undefined;
    analysis.state = session.state;
  }
}

function windowSession(sender: { id: number }) {
  const session = sessions.get(sender.id);
  if (!session) throw new Error('此工作区已关闭。');
  return session;
}

function findProjectWindow(path: string) {
  const key = comparablePath(path);
  return [...sessions.values()].find(session => session.file && comparablePath(session.file.path) === key);
}

async function projectPath(path: string) {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return join(await realpath(dirname(path)), basename(path));
  }
}

function isSavingTo(path: string) {
  return [...sessions.values()].some(session => session.savingTo === comparablePath(path));
}

function focusProject(session: WindowSession) {
  if (session.window.isMinimized()) session.window.restore();
  session.window.focus();
  return null;
}

async function openProject(session: WindowSession, password?: string | null, resume = false): Promise<ProjectOpening> {
  if (password === null) {
    session.unlockPath = undefined;
    return null;
  }
  let path = session.unlockPath;
  if (password === undefined) {
    session.unlockPath = undefined;
    if (resume) {
      const previous = preferences.value.usage.lastProject;
      if (!previous) return null;
      path = await realpath(previous);
    } else {
      const choice = await dialog.showOpenDialog(session.window, {
        title: '打开项目', defaultPath: preferredDirectory('project'), properties: ['openFile'], filters: [projectFilter],
      });
      if (choice.canceled || !choice.filePaths.length) return null;
      path = await realpath(choice.filePaths[0]);
    }
  }
  if (!path) return null;
  const existing = findProjectWindow(path);
  if (existing) {
    session.unlockPath = undefined;
    rememberProject(path);
    return focusProject(existing);
  }
  if (isSavingTo(path)) throw new Error('项目正在保存，请稍后再打开。');
  const { mtimeMs, size } = await stat(path);
  const opened = await readProject(path, password);
  if ('locked' in opened) {
    session.unlockPath = path;
    return { locked: true, title: basename(path, extname(path)) };
  }
  session.unlockPath = undefined;
  const { state, protection } = opened;
  const { view } = await (await (import('./engine/workspace.js' as string) as Promise<typeof import('../engine/workspace.js')>)).runWorkspace(state, { op: 'view' });
  const file = { path, mtimeMs, size };
  return serialize(session, () => {
    const other = findProjectWindow(path);
    if (other) return focusProject(other);
    if (isSavingTo(path)) throw new Error('项目正在保存，请稍后再打开。');
    rememberProject(path);
    if (session.file || session.state.materials.length || session.scan) {
      openWindow({ state, file, view, protection });
      return null;
    }
    Object.assign(session, { state, file, protection, changeSeq: 0, savedSeq: 0 });
    updateProjectTitle(session);
    return { view };
  });
}

function projectSaveDefaults(session: WindowSession): ProjectSaveStatus {
  const current = session.file?.path;
  const location = current ? dirname(current) : preferredDirectory('project');
  return {
    hasFile: !!current,
    protected: !!session.protection,
    directory: existsSync(location) ? location : app.getPath('home'),
    name: current ? `${basename(current, extname(current))} 副本` : '未命名项目',
  };
}

async function saveProject(session: WindowSession, password?: string | null, destination?: ProjectDestination): Promise<ProjectSaveResult> {
  if (session.editingDraft) throw new Error('请先应用或取消原文修改，再保存项目。');
  let path = session.file?.path;
  if (destination) {
    const name = destination.name.trim().replace(/\.lrproj$/iu, '').trim();
    if (!name || name === '.' || name === '..' || /[<>:"/\\|?*\u0000-\u001f]/u.test(name)) {
      throw new Error('请输入有效的项目文件名。');
    }
    path = await projectPath(join(destination.directory, `${name}.lrproj`));
    if (session.file && comparablePath(path) === comparablePath(session.file.path)) {
      throw new Error('请为副本选择不同的文件名或保存位置。');
    }
  }
  if (!path) throw new Error('请先选择项目的保存位置。');
  const owner = findProjectWindow(path);
  if ((owner && owner !== session) || isSavingTo(path)) throw new Error('这个项目已在另一窗口打开，请选择其他位置。');
  session.savingTo = comparablePath(path);
  try {
    if (owner === session && session.file) {
      const current = await stat(path).catch(() => null);
      if (!current || current.mtimeMs !== session.file.mtimeMs || current.size !== session.file.size) {
        throw new Error('项目文件已在外部移动或更改，请使用「项目另存为」。');
      }
    }
    const { state, changeSeq } = await serialize(session, () => ({ state: session.state, changeSeq: session.changeSeq }));
    if (state.sourcePaths?.some(source => comparablePath(source) === comparablePath(path))) {
      throw new Error('此路径是已导入的原件，请选择另一处保存。');
    }
    if (destination && existsSync(path)) {
      if ((await stat(path)).isDirectory()) throw new Error('此名称已被文件夹占用，请换一个文件名。');
      const { response } = await dialog.showMessageBox(session.window, {
        type: 'question', message: '要替换已有的项目文件吗？', detail: path,
        buttons: ['取消', '替换'], defaultId: 0, cancelId: 0,
      });
      if (response !== 1) return null;
    }
    const protection = password === undefined ? session.protection : password === null ? undefined : await projectProtection(password);
    const stamp = await writeProject(path, state, protection);
    session.file = { path, ...stamp };
    session.protection = protection;
    session.savedSeq = changeSeq;
    updateProjectTitle(session);
    rememberProject(path, !!destination);
    return { dirty: projectDirty(session) };
  } finally {
    session.savingTo = undefined;
  }
}

async function projectOperation<T>(session: WindowSession, task: () => Promise<T>) {
  if (session.fileOperation) return null;
  session.fileOperation = true;
  try {
    return await task();
  } finally {
    session.fileOperation = false;
  }
}

function diagnose(record: Record<string, unknown>) {
  void appendFile(join(app.getPath('userData'), 'diagnostics.jsonl'), `${JSON.stringify(record)}\n`, 'utf8').catch(() => {});
}

function decodeImport(session: Session, restoring: boolean, encoding?: 'gb18030'): ImportSelection {
  const slot = restoring ? 'restoreInput' : 'importInput';
  const source = session[slot];
  if (!source) throw new Error('请先打开 TXT 文件。');
  const started = performance.now();
  let result: ReturnType<typeof decodeInput>;
  try {
    result = decodeInput(source.bytes, encoding, restoring);
  } catch (error) {
    diagnose({stage: 'import', status: 'decode-error', bytes: source.bytes.length, readMs: source.readMs,
      decodeMs: performance.now() - started});
    throw error;
  }
  if (result.requiresEncoding) {
    diagnose({ stage: 'import', bytes: source.bytes.length, readMs: source.readMs, decodeMs: performance.now() - started, encoding: 'unknown' });
    return { requiresEncoding: true, title: source.title };
  }
  diagnose({ stage: 'import', bytes: source.bytes.length, readMs: source.readMs, decodeMs: performance.now() - started,
    encoding: result.encoding, characters: Array.from(result.text).length });
  session[slot] = undefined;
  rememberFolder('import', source.path);
  return { path: source.path, title: source.title, ...result };
}

async function extractWord(session: WindowSession, bytes: Buffer) {
  if (session.window.isDestroyed()) return null;
  const worker = new Worker(join(__dirname, 'word-worker.cjs'), { workerData: bytes });
  try {
    return await new Promise<string | null>((resolve, reject) => {
      session.cancelWordImport = () => resolve(null);
      worker.once('message', (result: { text: string } | { error: string }) => {
        if ('error' in result) reject(new Error(result.error));
        else resolve(result.text);
      });
      const interrupted = () => reject(new Error('正文提取已中断，请重试。'));
      worker.once('error', interrupted);
      worker.once('exit', interrupted);
      session.window.webContents.send('redaction:word-extracting');
    });
  } finally {
    session.cancelWordImport = undefined;
    void worker.terminate();
  }
}

ipcMain.handle('redaction:open', async (event, mode = 'redact'): ReturnType<RedactionAPI['open']> => {
  const owner = windowSession(event.sender).window;
  const restoring = mode === 'restore';
  const choice = await dialog.showOpenDialog(owner, {
    title: restoring ? '打开 TXT' : '打开文件', defaultPath: preferredDirectory('import'), properties: ['openFile'],
    filters: restoring ? [{ name: '纯文本', extensions: ['txt'] }]
      : [{ name: '文本和 Word 文档', extensions: ['txt', 'docx'] }],
  });
  if (choice.canceled) return null;
  const [path] = choice.filePaths;
  const session = windowSession(event.sender);
  const slot = restoring ? 'restoreInput' : 'importInput';
  session[slot] = undefined;
  const extension = extname(path);
  const suffix = extension.toLowerCase();
  const isWord = !restoring && suffix === '.docx';
  if (!restoring && suffix === '.doc') throw new Error('请先将 DOC 文件另存为 DOCX，再导入。');
  if (!isWord && suffix !== '.txt') throw new Error(restoring ? '请选择 TXT 文件。' : '请选择 TXT 或 DOCX 文件。');
  const format = isWord ? 'DOCX' : 'TXT';
  const started = performance.now();
  let bytes, sourcePath;
  try {
    [bytes, sourcePath] = await Promise.all([readFile(path), realpath(path)]);
  } catch {
    diagnose({stage: 'import', status: 'read-error', readMs: performance.now() - started});
    throw new Error(`读取 ${format} 文件失败。请检查文件仍可访问，再打开一次。`);
  }
  const title = basename(path, extension);
  const readMs = performance.now() - started;
  if (isWord) {
    const extraction = performance.now();
    try {
      const text = await extractWord(session, bytes);
      if (text === null) return null;
      diagnose({ stage: 'import', format, bytes: bytes.length, readMs, decodeMs: performance.now() - extraction,
        characters: Array.from(text).length });
      rememberFolder('import', sourcePath);
      return { path: sourcePath, title, text, encoding: format };
    } catch (error) {
      diagnose({ stage: 'import', format, status: 'decode-error', bytes: bytes.length, readMs,
        decodeMs: performance.now() - extraction });
      throw error;
    }
  }
  session[slot] = { path: sourcePath, title, bytes, readMs };
  return decodeImport(session, restoring);
});
ipcMain.on('redaction:cancel-word-import', event => sessions.get(event.sender.id)?.cancelWordImport?.());
ipcMain.handle('redaction:decode-gb18030', (event, mode = 'redact') => decodeImport(windowSession(event.sender), mode === 'restore', 'gb18030'));
ipcMain.handle('redaction:preferences', () => preferences.snapshot());
ipcMain.handle('redaction:change-preferences', (_event, patch: PreferencePatch) => changePreferences(next => {
  if (typeof patch.sidebarCollapsed === 'boolean') next.usage.sidebarCollapsed = patch.sidebarCollapsed;
  if (patch.mappingScope) next.usage.mappingScope = patch.mappingScope;
  if (isSettingsSection(patch.section)) next.usage.section = patch.section;
}));
ipcMain.handle('redaction:apply-settings', async (_event, changes: SettingsChanges, reset = false) => {
  const { provider, automaticUpdates, rememberFolders, rememberWindowPosition, startupProject, ...view } = changes;
  if (reset) for (const session of sessions.values()) cancelLayoutSave(session);
  return changePreferences(current => {
    const next = reset ? defaultPreferences() : current;
    next.view = { ...next.view, ...view };
    if (provider && provider !== next.inference.provider) {
      const device = selectDevice(detectedDevices, provider);
      if (!device) throw new Error('所选推理设备不可用。请重新选择。');
      next.inference = {provider, label: provider === 'auto' ? '' : deviceOption(device).label};
    }
    if (automaticUpdates !== undefined && automaticUpdates !== next.updates.automatic) {
      next.updates = { automatic: automaticUpdates, lastAttempt: 0 };
    }
    if (rememberFolders !== undefined) next.usage.rememberFolders = rememberFolders;
    if (rememberWindowPosition !== undefined) {
      next.usage.rememberWindowPosition = rememberWindowPosition;
      const window = lastWorkspaceId !== undefined ? sessions.get(lastWorkspaceId)?.window : undefined;
      if (rememberWindowPosition && window && !window.isDestroyed()) {
        const { x, y } = window.getNormalBounds();
        next.usage.window.position = { x, y };
      }
    }
    if (startupProject !== undefined) {
      next.usage.startupProject = startupProject;
      if (startupProject === 'last' && lastProjectPath) next.usage.lastProject = lastProjectPath;
    }
    return next;
  }, reset);
});
ipcMain.handle('redaction:open-settings', (_event, section?: SettingsSection) => openSettings(isSettingsSection(section) ? section : undefined));
ipcMain.handle('redaction:settings-info', (): Awaited<ReturnType<RedactionAPI['settingsInfo']>> => ({
  version: app.getVersion(), update: updates.status, backends: inferenceBackends(process.platform, process.arch), inference: inferenceStatus(),
}));
ipcMain.handle('redaction:check-updates', () => updates.check(true));
ipcMain.handle('redaction:open-product-link', (_event, target: 'homepage' | 'release' | 'download') => {
  const url = updates.url(target);
  if (url) return shell.openExternal(url);
});
ipcMain.handle('redaction:read-product-license', async () => {
  const [license, notice] = await Promise.all(['LICENSE', 'NOTICE'].map(name =>
    readFile(app.isPackaged ? join(process.resourcesPath, 'legal-redactor-' + name) : join(project, name), 'utf8')));
  return `${notice.trim()}\n\n${license}`;
});
ipcMain.handle('redaction:engine', (event, request: EngineRequest): Promise<EngineReply<EngineRequest>> => {
  const session = windowSession(event.sender);
  const progress = (phase: string) => {
    if (!event.sender.isDestroyed()) event.sender.send('redaction:progress', phase);
  };
  if (request.op === 'scan' || request.op === 'reviseMaterial') return analyze(session, request, progress);
  if ((request.op === 'editMaterial' || request.op === 'deleteMaterial') && request.materialId === session.scan?.materialId) cancelAnalysis(session);
  if (request.op === 'findOriginal') return serialize(session, () => findOriginal(session.state.materials, request.text));
  return serialize(session, async () => {
    const revision = session.state.revision;
    const exported = request.op === 'markExported' && session.state.materials.find(doc => doc.id === request.materialId)?.exported;
    const payload = await runEngine(session, request, progress);
    if (session.state.revision !== revision || request.op === 'markExported' && exported !== request.text) projectChanged(session);
    return payload;
  });
});
ipcMain.handle('redaction:initial-project', async (event): ReturnType<RedactionAPI['initialProject']> => {
  const session = windowSession(event.sender);
  const view = session.initialView;
  delete session.initialView;
  if (view) return { view };
  if (!session.resumeOnStartup || preferences.value.usage.startupProject !== 'last') return null;
  delete session.resumeOnStartup;
  try { return await projectOperation(session, () => openProject(session, undefined, true)); }
  catch { return { warning: '未能打开上次的项目，已打开空项目。' }; }
});
ipcMain.handle('redaction:open-project', (event, password?: string | null) => {
  const session = windowSession(event.sender);
  return projectOperation(session, () => openProject(session, password));
});
ipcMain.handle('redaction:save-project', (event, password?: string | null, destination?: ProjectDestination) => {
  const session = windowSession(event.sender);
  return projectOperation(session, () => saveProject(session, password, destination));
});
ipcMain.handle('redaction:project-save-status', event => projectSaveDefaults(windowSession(event.sender)));
ipcMain.handle('redaction:project-save-directory', (event, directory: string) => {
  const session = windowSession(event.sender);
  return projectOperation(session, async () => {
    const choice = await dialog.showOpenDialog(session.window, {
      title: '选择保存位置', defaultPath: directory, properties: ['openDirectory', 'createDirectory'],
    });
    return choice.canceled ? null : choice.filePaths[0] ?? null;
  });
});
ipcMain.on('redaction:rendered', (_event, renderMs: number) => {
  if (Number.isFinite(renderMs) && renderMs >= 0) diagnose({stage: 'view-render', renderMs});
});
ipcMain.handle('redaction:cancel', (event) => cancelAnalysis(windowSession(event.sender)));
ipcMain.on('redaction:draft-dirty', (event, dirty: boolean) => { windowSession(event.sender).editingDraft = dirty === true; });
ipcMain.handle('redaction:close', (event, discard: boolean) => {
  windowSession(event.sender).allowClose = discard === true;
  BrowserWindow.fromWebContents(event.sender)?.close();
});
ipcMain.handle('redaction:copy', (_event, output: string) => clipboard.writeText(output));
ipcMain.handle('redaction:save', async (event, { output, sourcePaths, filename, mode }) => {
  const owner = windowSession(event.sender).window;
  const restoring = mode === 'restore';
  const folder = restoring ? 'restoreExport' : 'redactExport';
  const choice = await dialog.showSaveDialog(owner, {
    title: restoring ? '另存恢复文本' : '另存脱敏正文', defaultPath: join(preferredDirectory(folder), filename),
    filters: [{ name: '纯文本', extensions: ['txt'] }],
  });
  if (choice.canceled || !choice.filePath) return null;
  const path = extname(choice.filePath).toLowerCase() === '.txt' ? choice.filePath : `${choice.filePath}.txt`;
  const target = await realpath(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return resolve(path);
    throw error;
  });
  const projectSources = restoring ? windowSession(event.sender).state.sourcePaths ?? [] : [];
  if ([...sourcePaths, ...projectSources].some((source: string) => comparablePath(target) === comparablePath(source))) {
    throw new Error(restoring ? '此路径是已导入的原件，请选择另一处保存。' : '此路径是项目材料的原件，请选择另一处保存。');
  }
  const staging = await mkdtemp(join(dirname(path), '.redaction-'));
  try {
    const prepared = join(staging, 'output.txt');
    await writeFile(prepared, output, 'utf8');
    await rename(prepared, path);
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
  }
  rememberFolder(folder, path);
  return path;
});

function cancelLayoutSave(session: WindowSession) {
  const request = session.layoutSave;
  if (request) clearTimeout(request.timer);
  delete session.layoutSave;
  return request;
}

function saveLayout(session: WindowSession) {
  const request = cancelLayoutSave(session);
  if (request) void changePreferences(next => { next.usage.window = request.layout; }).catch(() => {});
}

function trackLayout(session: WindowSession) {
  const window = session.window;
  const read = () => {
    const { width, height, x, y } = window.getNormalBounds();
    const position = preferences.value.usage.rememberWindowPosition ? { x, y } : null;
    return { width, height, maximized: window.isMaximized(), position };
  };
  let previous = read();
  function resized() {
    const layout = read();
    if (layout.width === previous.width && layout.height === previous.height && layout.maximized === previous.maximized
      && layout.position?.x === previous.position?.x && layout.position?.y === previous.position?.y) return;
    previous = layout;
    cancelLayoutSave(session);
    session.layoutSave = { layout, timer: setTimeout(() => saveLayout(session), 200) };
  }
  window.on('resize', resized).on('move', resized).on('maximize', resized).on('unmaximize', resized);
}

function openWindow(initial?: { state: Workspace; file: ProjectFile; view: WorkspaceView; protection?: ProjectProtection }, resume = false) {
  const layout = preferences.value.usage.window;
  const position = layout.position;
  const savedDisplay = position && screen.getAllDisplays().find(({ workArea }) =>
    position.x >= workArea.x && position.y >= workArea.y
      && position.x < workArea.x + workArea.width && position.y < workArea.y + workArea.height);
  const { workArea } = savedDisplay || screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const minWidth = Math.min(780, workArea.width);
  const minHeight = Math.min(620, workArea.height);
  const width = Math.max(minWidth, Math.min(layout.width, workArea.width));
  const height = Math.max(minHeight, Math.min(layout.height, workArea.height));
  const placement = savedDisplay && position ? {
    x: Math.min(position.x, workArea.x + workArea.width - width), y: Math.min(position.y, workArea.y + workArea.height - height),
  } : {};
  const window = new BrowserWindow({
    ...placement, width, height, minWidth, minHeight,
    icon: applicationIcon,
    backgroundColor: '#f5f7fb',
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true },
  });
  const id = window.webContents.id;
  const session: WindowSession = {
    window, state: initial?.state ?? { materials: [], groups: {}, activeId: null, undo: null, revision: 0 },
    file: initial?.file, protection: initial?.protection, initialView: initial?.view, resumeOnStartup: resume,
    nextId: 0, changeSeq: 0, savedSeq: 0,
  };
  sessions.set(id, session);
  lastWorkspaceId = id;
  window.on('focus', () => { lastWorkspaceId = id; });
  updateProjectTitle(session);
  window.on('page-title-updated', event => event.preventDefault());
  window.on('close', (event: { preventDefault(): void }) => {
    if (session.fileOperation) { event.preventDefault(); return; }
    if (session.allowClose) return;
    if (session.pending) {
      event.preventDefault();
      void session.queue?.then(() => { if (!window.isDestroyed()) window.close(); });
      return;
    }
    if (!projectDirty(session) && !session.editingDraft) return;
    event.preventDefault();
    window.webContents.send('redaction:confirm-close');
  });
  window.on('closed', () => {
    saveLayout(session);
    session.cancelWordImport?.();
    cancelAnalysis(session);
    if (session.analysis) stopWorker(session.analysis);
    stopWorker(session);
    sessions.delete(id);
  });
  window.once('ready-to-show', () => {
    if (layout.maximized) window.maximize();
    trackLayout(session);
  });
  window.loadFile(appPage);
  return window;
}

function openSettings(section?: SettingsSection) {
  if (settingsWindow) {
    if (section) {
      settingsTarget = section;
      if (!settingsWindow.webContents.isLoading()) settingsWindow.webContents.send('redaction:settings-section', section);
    }
    if (settingsWindow.isMinimized()) settingsWindow.restore();
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }
  settingsTarget = section;
  const window = new BrowserWindow({
    width: 780, height: 570, minWidth: 610, minHeight: 420, show: false, title: '设置 · LegalRedactor',
    icon: applicationIcon, backgroundColor: '#fff',
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true },
  });
  settingsWindow = window;
  window.removeMenu();
  window.on('page-title-updated', event => event.preventDefault());
  window.webContents.on('will-prevent-unload', event => {
    const choice = dialog.showMessageBoxSync(window, {
      type: 'question', message: '要放弃未应用的设置吗？', buttons: ['继续编辑', '放弃修改'], defaultId: 0, cancelId: 0,
    });
    if (choice === 1) event.preventDefault();
  });
  window.once('ready-to-show', () => {
    if (settingsTarget) window.webContents.send('redaction:settings-section', settingsTarget);
    window.show();
  });
  window.on('closed', () => { settingsWindow = undefined; settingsTarget = undefined; });
  window.loadFile(appPage, { query: { settings: '1', section: section ?? '' } });
}

function projectMenu(label: string, accelerator: string | undefined, command: ProjectCommand): Electron.MenuItemConstructorOptions {
  return { label, accelerator, click: (_item, window) => { if (window instanceof BrowserWindow) window.webContents.send('redaction:project-command', command); } };
}

function viewMenu(key: ViewSwitch): Electron.MenuItemConstructorOptions {
  return {
    id: 'view-' + key, label: viewLabels[key], type: 'checkbox', checked: preferences.value.view[key],
    click(item: { checked: boolean }) {
      const checked = item.checked;
      void changePreferences(next => { next.view[key] = checked; }).catch(() => dialog.showErrorBox('视图设置', '无法保存视图设置。'));
    },
  };
}

if (app.requestSingleInstanceLock()) {
  const ready = app.whenReady().then(() => preferences.load());
  app.on('second-instance', () => { void ready.then(() => openWindow()); });
  void ready.then(() => {
    app.dock?.setIcon(applicationIcon);
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: '文件', submenu: [
        { label: '新建项目窗口', accelerator: 'CmdOrCtrl+Shift+N', click: () => openWindow() },
        projectMenu('打开项目…', 'CmdOrCtrl+O', 'open'),
        projectMenu('保存项目', 'CmdOrCtrl+S', 'save'),
        projectMenu('项目另存为…', 'CmdOrCtrl+Shift+S', 'saveAs'),
        projectMenu('项目密码…', undefined, 'password'),
        { type: 'separator' },
        { role: 'close', label: '关闭窗口' },
      ] },
      { label: '编辑', submenu: [
        { role: 'cut', label: '剪切' }, { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' }, { role: 'selectAll', label: '全选' },
      ] },
      { label: '视图', submenu: viewKeys.map(viewMenu) },
      { label: '设置', submenu: [
        { label: '设置…', accelerator: 'CmdOrCtrl+,', click: () => openSettings() },
        { label: '检查更新…', click: () => openSettings('updates') },
        { label: '关于 LegalRedactor', click: () => openSettings('about') },
      ] },
    ]));
    const workspace = openWindow(undefined, true);
    environmentReady = detectEnvironment(workspace);
    app.on('browser-window-focus', () => { void automaticCheck(); });
    void automaticCheck();
  });
} else {
  app.quit();
}
app.on('window-all-closed', () => {
  void preferences.flush().then(() => { if (!BrowserWindow.getAllWindows().length) app.quit(); });
});
