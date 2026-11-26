const { mkdir, mkdtemp, readFile, rename, rm, writeFile } = require('node:fs/promises') as typeof import('node:fs/promises');
const { join } = require('node:path') as typeof import('node:path');
const { defaultPreferences, normalizePreferences, objectValue } = require('./engine/preferences.js') as typeof import('../engine/preferences.js');

type Preferences = import('../engine/preferences.js').Preferences;

function createPreferences(profile: string) {
  const directory = join(profile, 'preferences');
  const file = join(directory, 'settings.json');
  let value = defaultPreferences();
  let warning = '';
  let pending = Promise.resolve();

  async function write(settings: Preferences) {
    await mkdir(directory, { recursive: true });
    const staging = await mkdtemp(join(directory, '.settings-'));
    try {
      const next = join(staging, 'settings.json');
      await writeFile(next, JSON.stringify(settings, null, 2) + '\n', 'utf8');
      await rename(next, file);
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => {});
    }
  }

  async function legacy(name: string) {
    try { return JSON.parse(await readFile(join(profile, name), 'utf8')); }
    catch { return undefined; }
  }

  async function load() {
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        const [view, inference] = await Promise.all([legacy('view-settings.json'), legacy('inference-settings.json')]);
        value = normalizePreferences({ view, inference });
        try { await write(value); } catch { warning = '无法保存设置。'; }
      } else warning = '无法读取设置，已使用默认值。';
      return;
    }
    try {
      const parsed = objectValue(JSON.parse(raw));
      if (!parsed) throw new Error('缺少设置对象');
      value = normalizePreferences(parsed);
    } catch {
      warning = '设置文件损坏，已恢复默认设置。';
      try { await write(value); }
      catch { warning = '设置文件损坏，本次使用默认设置，无法重建设置文件。'; }
    }
  }

  function update(change: (next: Preferences) => Preferences | void, force = false) {
    const result = pending.then(async () => {
      const draft = structuredClone(value);
      const next = normalizePreferences(change(draft) ?? draft);
      if (!force && !warning && JSON.stringify(value) === JSON.stringify(next)) return false;
      try { await write(next); }
      catch { warning = '无法保存设置。'; throw new Error(warning); }
      value = next;
      warning = '';
      return true;
    });
    pending = result.then(() => {}, () => {});
    return result;
  }

  return { get value() { return value; }, snapshot: () => ({ settings: value, warning }), load, update, flush: () => pending };
}

module.exports = { createPreferences };
