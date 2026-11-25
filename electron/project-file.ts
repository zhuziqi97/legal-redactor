const { mkdtemp, readFile, rename, rm, stat, writeFile } = require('node:fs/promises');
const { dirname, join } = require('node:path');
const { ZipReader, ZipWriter, Uint8ArrayReader, Uint8ArrayWriter, TextReader } = require('@zip.js/zip.js');

const stateFormat = import('./engine/project-state.js');
type Workspace = import('../engine/workspace-types.js').Workspace;

async function readProject(path: string): Promise<Workspace> {
  const bytes = await readFile(path);
  const reader = new ZipReader(new Uint8ArrayReader(bytes), { useWebWorkers: false });
  let value: unknown;
  try {
    const entries = await reader.getEntries();
    const metadata = entries.filter(entry => entry.filename === 'project.json' && !entry.directory);
    if (metadata.length !== 1) throw new Error('项目数据入口缺失或重复。');
    const data = await metadata[0].getData(new Uint8ArrayWriter(), { checkCrc32: true });
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data));
  } catch {
    throw new Error('无法读取项目文件。请确认选择了完整的 LegalRedactor 项目。');
  } finally {
    await reader.close();
  }
  return (await stateFormat).decodeProject(value);
}

async function writeProject(path: string, state: Workspace) {
  const metadata = JSON.stringify((await stateFormat).encodeProject(state));
  const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false });
  await writer.add('project.json', new TextReader(metadata));
  const bytes = await writer.close();
  const staging = await mkdtemp(join(dirname(path), '.legal-redactor-'));
  try {
    const prepared = join(staging, 'project.lrproj');
    await writeFile(prepared, bytes, { mode: 0o600, flush: true });
    const { mtimeMs, size } = await stat(prepared);
    await rename(prepared, path);
    return { mtimeMs, size };
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = { readProject, writeProject };
