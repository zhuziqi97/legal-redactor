// Prefer Simplified Chinese glyphs in the native Linux menus.
if (process.platform === 'linux') process.env.FC_LANG ||= 'zh-cn';

const { app, BrowserWindow, Menu, clipboard, dialog, ipcMain, utilityProcess } = require('electron');
const { existsSync, mkdirSync, readFileSync } = require('node:fs');
const { appendFile, readFile, writeFile, realpath, mkdtemp, rename, rm, stat } = require('node:fs/promises');
const { decodeInput } = require('./text-input.cjs');
const { findOriginal } = require('./text-engine.cjs');
const { projectProtection, readProject, writeProject } = require('./project-file.cjs');
const { basename, dirname, extname, join, resolve } = require('node:path');
type Workspace = import('../engine/workspace-types.js').Workspace;
type Request = import('../engine/workspace-types.js').Request;
type ProjectCommand = 'open' | 'save' | 'saveAs' | 'password';
type ProjectProtection = import('./project-file.js').ProjectProtection;
type ProjectFile = { path: string; mtimeMs: number; size: number };

type Pending = {
  id: number;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  progress: (phase: string) => void;
  provider: string;
  started: number;
};

const project = resolve(__dirname, '..');
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
const settingsPath = join(app.getPath('userData'), 'inference-settings.json');
let provider = 'auto';
try {
  const saved = JSON.parse(readFileSync(settingsPath, 'utf8'));
  if (typeof saved.provider === 'string') provider = saved.provider;
} catch {
  // Default to the Runtime's automatic selection on a new installation.
}

type InferenceRoute = {provider: string; fallbackReason?: string; reusedSession: boolean; loadMs: number};
type InferencePending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  progress?: (phase: string) => void;
};

function fallbackNotice(route: InferenceRoute) {
  return route.fallbackReason ? `自动初始化失败，已改用 ${route.provider}。原因：${route.fallbackReason}` : '';
}
const inferencePending = new Map<number, InferencePending>();
let nativeWorker: ReturnType<typeof utilityProcess.fork> | undefined;
let inferenceId = 0;
function infer(op: 'providers' | 'prepare' | 'probe' | 'predict', ep: string, input?: { texts: string[]; labels: string[] },
  progress?: (phase: string) => void) {
  if (!nativeWorker) {
    const child = utilityProcess.fork(join(__dirname, 'inference-worker.cjs'), [], { serviceName: 'Otter ONNX Runtime' });
    child.on('message', (message: { id: number; result?: unknown; error?: string; phase?: string }) => {
      const waiter = inferencePending.get(message.id);
      if (!waiter) return;
      if (message.phase) {
        waiter.progress?.(message.phase);
        return;
      }
      inferencePending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error));
      else waiter.resolve(message.result);
    });
    child.on('exit', () => {
      if (nativeWorker !== child) return;
      nativeWorker = undefined;
      for (const waiter of inferencePending.values()) waiter.reject(new Error('ONNX Runtime 进程已经退出。'));
      inferencePending.clear();
    });
    nativeWorker = child;
  }
  const id = ++inferenceId;
  return new Promise((resolve, reject) => {
    inferencePending.set(id, { resolve, reject, progress });
    nativeWorker.postMessage({ id, op, directory: nativeModel, provider: ep, ...input });
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
  initialView?: unknown;
  fileOperation?: boolean;
  savingTo?: string;
  changeSeq: number;
  savedSeq: number;
  editingDraft?: boolean;
  protection?: ProjectProtection;
  unlockPath?: string;
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
  child.on('message', message => {
    const pending = session.pending;
    if (session.worker !== child || !pending || message.id !== pending.id) return;
    if (message.inference) {
      const reply = (value: object) => {
        if (session.worker === child && session.pending === pending) child.postMessage({id: pending.id, ...value});
      };
      infer('predict', pending.provider, message.inference, pending.progress).then(
        predictions => reply({predictions}),
        error => reply({inferenceError: `ONNX Runtime（${pending.provider}）运行失败。${error.message}`}),
      );

      return;
    }
    if (message.diagnostic) {
      diagnose({...message.diagnostic, elapsedMs: performance.now() - pending.started});
      return;
    }
    if (message.phase) {
      pending.progress(message.phase);
      return;
    }
    session.pending = undefined;
    if (message.error) pending.reject(new Error(message.error));
    else pending.resolve(message.result);
  });
  child.on('exit', () => finishWorker(session, child, '本地脱敏引擎已退出，请重试。'));
  return child;
}

async function runEngine(session: Session, request: Request, progress: (phase: string) => void, ep = provider) {
  if (session.pending) throw new Error('请等待当前操作完成。');
  const child = session.worker ?? startWorker(session);
  const result = await new Promise<unknown>((resolve, reject) => {
    const id = ++session.nextId;
    session.pending = {id, resolve, reject, progress, provider: ep, started: performance.now()};
    child.postMessage({id, state: session.state, request, provider: ep, rulesOnly});
  });
  if (typeof result === 'object' && result !== null && 'state' in result) {
    const {state, ...payload} = result;
    session.state = state as Workspace;
    return payload;
  }
  return result;
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
  const preferredEP = provider;
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
  try {
    assertCurrent();
    let route: InferenceRoute | undefined;
    if (!rulesOnly) {
      try {
        route = await infer('prepare', preferredEP, undefined, phase) as InferenceRoute;
      } catch (error) {
        assertCurrent();
        throw new Error(`ONNX Runtime（${preferredEP}）无法初始化模型。${error instanceof Error ? error.message : String(error)}`);
      }
    }
    assertCurrent();
    const ep = route?.provider ?? preferredEP;
    const notice = route ? fallbackNotice(route) : '';
    const showPhase = (value: string) => phase(notice ? `${value} · ${notice}` : value);
    for (;;) {
      const base = await serialize(session, () => { assertCurrent(); return session.state; });
      analysis.state = base;
      await runEngine(analysis, input, showPhase, ep);
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
        const view = await runEngine(analysis, { op: 'view' }, showPhase) as object;
        assertCurrent();
        session.state = analysis.state;
        if (session.state.revision !== base.revision) projectChanged(session);
        diagnose({stage: 'analysis-view', preferredEP, provider: route?.provider, usedFallback: !!route?.fallbackReason,
          reusedSession: route?.reusedSession, modelLoadMs: route?.loadMs, queueMs: input.queueMs ?? 0, firstFeedbackMs,
          previewMs: performance.now() - previewStart, elapsedMs: performance.now() - started});
        return {...view, inferenceNotice: notice};
      });
      if (result) return result;
      showPhase('工作区已有更新，正在重新整理映射');
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

async function openProject(session: WindowSession, password?: string | null) {
  if (password === null) {
    session.unlockPath = undefined;
    return null;
  }
  let path = session.unlockPath;
  if (password === undefined) {
    session.unlockPath = undefined;
    const choice = await dialog.showOpenDialog(session.window, {
      title: '打开项目', properties: ['openFile'], filters: [projectFilter],
    });
    if (choice.canceled || !choice.filePaths.length) return null;
    path = await realpath(choice.filePaths[0]);
  }
  if (!path) return null;
  const existing = findProjectWindow(path);
  if (existing) {
    session.unlockPath = undefined;
    return focusProject(existing);
  }
  if (isSavingTo(path)) throw new Error('项目正在保存，请稍后再打开。');
  const { mtimeMs, size } = await stat(path);
  const opened = await readProject(path, password);
  if (opened.locked) {
    session.unlockPath = path;
    return { locked: true, title: basename(path, extname(path)) };
  }
  session.unlockPath = undefined;
  const { state, protection } = opened;
  const { view } = await (await import('./engine/workspace.js')).runWorkspace(state, { op: 'view' }) as { view: unknown };
  const file = { path, mtimeMs, size };
  return serialize(session, () => {
    const other = findProjectWindow(path);
    if (other) return focusProject(other);
    if (isSavingTo(path)) throw new Error('项目正在保存，请稍后再打开。');
    if (session.file || session.state.materials.length || session.scan) {
      openWindow({ state, file, view, protection });
      return null;
    }
    Object.assign(session, { state, file, protection, changeSeq: 0, savedSeq: 0 });
    updateProjectTitle(session);
    return { view };
  });
}

async function saveProject(session: WindowSession, saveAs: boolean, password?: string | null) {
  let path = session.file?.path;
  if (!path || saveAs) {
    const choice = await dialog.showSaveDialog(session.window, {
      title: saveAs ? '项目另存为' : '保存项目',
      defaultPath: path ?? join(app.getPath('documents'), '未命名项目.lrproj'),
      filters: [projectFilter],
    });
    if (choice.canceled || !choice.filePath) return null;
    path = extname(choice.filePath).toLowerCase() === '.lrproj' ? choice.filePath : `${choice.filePath}.lrproj`;
    if (path !== choice.filePath && existsSync(path) && comparablePath(path) !== comparablePath(session.file?.path ?? '')) {
      const { response } = await dialog.showMessageBox(session.window, {
        type: 'question', message: '这个位置已有项目文件。要替换它吗？',
        buttons: ['取消', '替换'], defaultId: 0, cancelId: 0,
      });
      if (response !== 1) return null;
    }
    path = await projectPath(path);
  }

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
    const protection = password === undefined ? session.protection : password === null ? undefined : await projectProtection(password);
    const stamp = await writeProject(path, state, protection);
    session.file = { path, ...stamp };
    session.protection = protection;
    session.savedSeq = changeSeq;
    updateProjectTitle(session);
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

function decodeImport(session: Session, restoring: boolean, encoding?: 'gb18030') {
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
  return { path: source.path, title: source.title, ...result };
}

ipcMain.handle('redaction:open', async (event, mode = 'redact') => {
  const owner = BrowserWindow.fromWebContents(event.sender);
  const choice = await dialog.showOpenDialog(owner, {
    title: '打开 TXT', properties: ['openFile'], filters: [{ name: '纯文本', extensions: ['txt'] }],
  });
  if (choice.canceled) return null;
  const [path] = choice.filePaths;
  const session = windowSession(event.sender);
  const restoring = mode === 'restore';
  const slot = restoring ? 'restoreInput' : 'importInput';
  session[slot] = undefined;
  const started = performance.now();
  let bytes, sourcePath;
  try {
    [bytes, sourcePath] = await Promise.all([readFile(path), realpath(path)]);
  } catch {
    diagnose({stage: 'import', status: 'read-error', readMs: performance.now() - started});
    throw new Error('读取 TXT 文件失败。请检查文件仍可访问，再打开一次。');
  }
  session[slot] = { path: sourcePath, title: basename(path, extname(path)), bytes, readMs: performance.now() - started };
  return decodeImport(session, restoring);
});
ipcMain.handle('redaction:decode-gb18030', (event, mode = 'redact') => decodeImport(windowSession(event.sender), mode === 'restore', 'gb18030'));
ipcMain.handle('redaction:inference-settings', async () => ({
  enabled: nativeEnabled, provider, providers: nativeEnabled ? await infer('providers', 'auto') : [],
}));
ipcMain.handle('redaction:set-provider', async (_event, choice: string) => {
  const available = await infer('providers', 'auto') as { name: string; bundled: boolean }[];
  if (!nativeEnabled || (choice !== 'auto' && !available.some(ep => ep.name === choice))) {
    throw new Error('此执行提供程序在当前发行包中不可用。');
  }
  let route: InferenceRoute;
  try {
    route = await infer('probe', choice) as InferenceRoute;
  } catch (error) {
    throw new Error(`无法使用 ${choice} 运行本地模型。${error instanceof Error ? error.message : String(error)}`);
  }
  await mkdirSync(app.getPath('userData'), { recursive: true });
  await writeFile(settingsPath, JSON.stringify({ provider: choice }), 'utf8');
  provider = choice;
  return fallbackNotice(route);
});
ipcMain.handle('redaction:engine', (event, request) => {
  const session = windowSession(event.sender);
  const progress = (phase: string) => {
    if (!event.sender.isDestroyed()) event.sender.send('redaction:progress', phase);
  };
  if (request.op === 'scan' || request.op === 'reviseMaterial') return analyze(session, request, progress);
  if (['editMaterial', 'deleteMaterial'].includes(request.op) && request.materialId === session.scan?.materialId) cancelAnalysis(session);
  if (request.op === 'findOriginal') return serialize(session, () => findOriginal(session.state.materials, request.text));
  return serialize(session, async () => {
    const revision = session.state.revision;
    const exported = request.op === 'markExported' && session.state.materials.find(doc => doc.id === request.materialId)?.exported;
    const payload = await runEngine(session, request, progress);
    if (session.state.revision !== revision || request.op === 'markExported' && exported !== request.text) projectChanged(session);
    return payload;
  });
});
ipcMain.handle('redaction:initial-project', event => {
  const session = windowSession(event.sender);
  const view = session.initialView;
  delete session.initialView;
  return view ?? null;
});
ipcMain.handle('redaction:open-project', (event, password?: string | null) => {
  const session = windowSession(event.sender);
  return projectOperation(session, () => openProject(session, password));
});
ipcMain.handle('redaction:save-project', (event, saveAs: boolean) => {
  const session = windowSession(event.sender);
  return projectOperation(session, () => saveProject(session, saveAs));
});
ipcMain.handle('redaction:project-password-status', event => !!windowSession(event.sender).protection);
ipcMain.handle('redaction:change-project-password', (event, password: string | null) => {
  const session = windowSession(event.sender);
  if (session.editingDraft) throw new Error('请先应用或取消原文修改，再保存项目。');
  return projectOperation(session, () => saveProject(session, false, password));
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
  const owner = BrowserWindow.fromWebContents(event.sender);
  const restoring = mode === 'restore';
  const choice = await dialog.showSaveDialog(owner, {
    title: restoring ? '另存恢复文本' : '另存脱敏正文', defaultPath: join(app.getPath('documents'), filename),
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
  return path;
});

function openWindow(initial?: { state: Workspace; file: ProjectFile; view: unknown; protection?: ProjectProtection }) {
  const window = new BrowserWindow({
    width: 1450, height: 940, minWidth: 780, minHeight: 620,
    icon: applicationIcon,
    backgroundColor: '#f5f7fb',
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true },
  });
  const id = window.webContents.id;
  const session: WindowSession = {
    window, state: initial?.state ?? { materials: [], groups: {}, activeId: null, undo: null, revision: 0 },
    file: initial?.file, protection: initial?.protection, initialView: initial?.view, nextId: 0, changeSeq: 0, savedSeq: 0,
  };
  sessions.set(id, session);
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
    cancelAnalysis(session);
    if (session.analysis) stopWorker(session.analysis);
    stopWorker(session);
    sessions.delete(id);
  });
  window.loadFile(join(project, 'dist', 'index.html'));
}

function projectMenu(label: string, accelerator: string | undefined, command: ProjectCommand) {
  return { label, accelerator, click: (_item, window) => window?.webContents.send('redaction:project-command', command) };
}

if (app.requestSingleInstanceLock()) {
  app.on('second-instance', () => openWindow());
  app.whenReady().then(() => {
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
      { label: '设置', submenu: [{ label: '推理设置…', click: (_item, window) => window?.webContents.send('redaction:open-settings') }] },
    ]));
    openWindow();
  });
} else {
  app.quit();
}
app.on('window-all-closed', () => app.quit());
