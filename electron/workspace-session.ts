import type { Session, WindowSession } from './session-types.js';
const { basename, extname } = require('node:path') as typeof import('node:path');

function hasProjectContent({state}: Session) {
  return state.materials.length > 0 || Object.keys(state.groups).length > 0;
}

function projectDirty(session: WindowSession) {
  return session.file ? session.changeSeq !== session.savedSeq : hasProjectContent(session);
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

function serialize<T>(session: Session, task: () => T | Promise<T>) {
  const result = (session.queue ?? Promise.resolve()).then(task);
  session.queue = result.catch(() => {});
  return result;
}

export = { hasProjectContent, projectDirty, updateProjectTitle, projectChanged, serialize };
