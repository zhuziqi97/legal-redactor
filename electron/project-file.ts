const { createCipheriv, createDecipheriv, randomBytes, scrypt } = require('node:crypto');
const { mkdtemp, readFile, rename, rm, stat, writeFile } = require('node:fs/promises');
const { dirname, join } = require('node:path');
const { ZipReader, ZipWriter, Uint8ArrayReader, Uint8ArrayWriter, TextReader } = require('@zip.js/zip.js');

const stateFormat = import('./engine/project-state.js');
type Workspace = import('../engine/workspace-types.js').Workspace;
export type ProjectProtection = { salt: Buffer; key: Buffer };
type ProjectRead = { locked: true } | { state: Workspace; protection?: ProjectProtection };

const marker = Buffer.from('LRPROJ-ENC', 'ascii');
const version = 1;
const saltSize = 16;
const nonceSize = 12;
const tagSize = 16;
const saltStart = marker.length + 1;
const nonceStart = saltStart + saltSize;
const headerSize = nonceStart + nonceSize;

async function projectProtection(password: string, salt: Buffer = randomBytes(saltSize)): Promise<ProjectProtection> {
  if (!password.trim()) throw new Error('请输入项目密码。');
  const key = await new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, 32, {N: 2 ** 17, r: 8, p: 1, maxmem: 192 * 1024 * 1024},
      (error: Error | null, derived: Buffer) => error ? reject(error) : resolve(derived));
  });
  return {salt, key};
}

function encrypt(bytes: Uint8Array, protection: ProjectProtection) {
  const nonce = randomBytes(nonceSize);
  const header = Buffer.concat([marker, Buffer.from([version]), protection.salt, nonce]);
  const cipher = createCipheriv('aes-256-gcm', protection.key, nonce, {authTagLength: tagSize});
  cipher.setAAD(header);
  const data = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return Buffer.concat([header, cipher.getAuthTag(), data]);
}

function decrypt(bytes: Buffer, protection: ProjectProtection) {
  const header = bytes.subarray(0, headerSize);
  const decipher = createDecipheriv('aes-256-gcm', protection.key, header.subarray(nonceStart), {authTagLength: tagSize});
  decipher.setAAD(header);
  decipher.setAuthTag(bytes.subarray(headerSize, headerSize + tagSize));
  try {
    return Buffer.concat([decipher.update(bytes.subarray(headerSize + tagSize)), decipher.final()]);
  } catch {
    throw new Error('密码不正确或项目文件已损坏。');
  }
}

async function readProject(path: string, password?: string): Promise<ProjectRead> {
  let bytes: Buffer = await readFile(path);
  let protection: ProjectProtection | undefined;
  if (bytes.subarray(0, marker.length).equals(marker)) {
    if (bytes.length <= headerSize + tagSize) throw new Error('加密项目文件不完整。');
    if (bytes[marker.length] !== version) throw new Error('此项目的加密格式与当前应用不兼容。');
    if (password === undefined) return {locked: true};
    protection = await projectProtection(password, Buffer.from(bytes.subarray(saltStart, nonceStart)));
    bytes = decrypt(bytes, protection);
  }
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
  return {state: (await stateFormat).decodeProject(value), protection};
}

async function writeProject(path: string, state: Workspace, protection?: ProjectProtection) {
  const metadata = JSON.stringify((await stateFormat).encodeProject(state));
  const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false });
  await writer.add('project.json', new TextReader(metadata));
  const archive = await writer.close();
  const bytes = protection ? encrypt(archive, protection) : archive;
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

module.exports = { projectProtection, readProject, writeProject };
