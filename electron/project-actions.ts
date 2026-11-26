import type { ProjectDestination, ProjectOpening, ProjectSaveResult, ProjectSaveStatus } from './contract.js';
import type { ProjectSnapshot, WindowSession } from './session-types.js';
const { app, dialog } = require('electron') as typeof import('electron');
const { existsSync } = require('node:fs') as typeof import('node:fs');
const { realpath, stat } = require('node:fs/promises') as typeof import('node:fs/promises');
const { basename, dirname, extname, join } = require('node:path') as typeof import('node:path');
const { projectProtection, readProject, writeProject } = require('./project-file.cjs') as typeof import('./project-file.js');
const { hasProjectContent, projectDirty, updateProjectTitle, serialize } = require('./workspace-session.cjs') as typeof import('./workspace-session.js');

const comparablePath = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path;

const projectFilter = { name: 'LegalRedactor 项目', extensions: ['lrproj'] };

type ProjectDependencies = {
  sessions: ReadonlyMap<number, WindowSession>;
  lastProject: () => string | null;
  preferredDirectory: (kind: 'project') => string;
  rememberProject: (path: string, rememberDirectory?: boolean) => void;
  openWindow: (initial: ProjectSnapshot) => void;
};

function createProjectActions({sessions, lastProject, preferredDirectory, rememberProject, openWindow}: ProjectDependencies) {
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
        const previous = lastProject();
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
      if (session.file || hasProjectContent(session) || session.scan) {
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

  return { openProject, saveProject, projectSaveDefaults, projectOperation };
}

export = { comparablePath, createProjectActions };
