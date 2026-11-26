import type { Backend } from './inference-devices.js';

export const viewLabels = {
  sync: '同步滚动', newlines: '显示换行符', lineNumbers: '显示行号', wrap: '自动换行',
} as const;
export type ViewSwitch = keyof typeof viewLabels;
export const viewKeys = Object.keys(viewLabels) as ViewSwitch[];
export const fontLabels = { default: '默认', serif: '宋体', sans: '黑体' } as const;
export type ReadingFont = keyof typeof fontLabels;
export const fontSizes = [12, 14, 15, 16, 18, 20, 22, 24];
export const sections = {
  habits: '常规', reading: '阅读显示', inference: '推理设置', updates: '软件更新', about: '关于',
} as const;
export type SettingsSection = keyof typeof sections;
export type MappingScope = 'all' | 'current';
export const folderKinds = ['import', 'project', 'redactExport', 'restoreExport'] as const;
export type FolderKind = (typeof folderKinds)[number];
export type ViewOptions = Record<ViewSwitch, boolean> & { font: ReadingFont; fontSize: number };
export type Preferences = ReturnType<typeof defaultPreferences>;
export type StartupProject = 'empty' | 'last';
export type PreferencePatch = Partial<Pick<Preferences['usage'], 'sidebarCollapsed' | 'mappingScope' | 'section'>>;
export type SettingsChanges = Partial<ReturnType<typeof editableSettings>>;
export type PreferenceSnapshot = { settings: Preferences; warning: string };
export type UpdateStatus =
  | { kind: 'idle' | 'checking' | 'current' }
  | { kind: 'available' | 'unavailable'; version: string; size?: number }
  | { kind: 'error'; message: string };

export function inferenceBackends(platform: string, arch: string): (Backend | 'auto')[] {
  const backends: (Backend | 'auto')[] = ['auto', 'cpu'];
  if (platform === 'win32' && arch === 'x64') backends.push('dml', 'webgpu');
  if (platform === 'linux' && arch === 'x64') backends.push('webgpu', 'cuda', 'tensorrt');
  if (platform === 'darwin' && arch === 'arm64') backends.push('coreml', 'webgpu');
  return backends;
}

export function defaultPreferences() {
  return {
    view: { sync: true, newlines: true, lineNumbers: false, wrap: true, font: 'default', fontSize: 15 } as ViewOptions,
    inference: { provider: 'auto', label: '' },
    updates: { automatic: true, lastAttempt: 0 },
    usage: {
      sidebarCollapsed: false, mappingScope: 'all' as MappingScope, section: 'habits' as SettingsSection,
      window: { width: 1450, height: 940, maximized: false, position: null as { x: number; y: number } | null },
      rememberWindowPosition: false, startupProject: 'empty' as StartupProject, lastProject: null as string | null,
      rememberFolders: false, folders: {} as Partial<Record<FolderKind, string>>,
    },
  };
}

export function editableSettings(settings: Preferences) {
  return {
    ...settings.view, provider: settings.inference.provider, automaticUpdates: settings.updates.automatic,
    rememberFolders: settings.usage.rememberFolders, rememberWindowPosition: settings.usage.rememberWindowPosition,
    startupProject: settings.usage.startupProject,
  };
}

export function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function isSettingsSection(value: unknown): value is SettingsSection {
  return typeof value === 'string' && Object.hasOwn(sections, value);
}

export function normalizePreferences(value: Record<string, unknown>) {
  const result = defaultPreferences();
  const view = objectValue(value.view);
  const inference = objectValue(value.inference);
  const updates = objectValue(value.updates);
  const usage = objectValue(value.usage);
  const window = objectValue(usage?.window);
  const folders = objectValue(usage?.folders);
  for (const key of viewKeys) if (typeof view?.[key] === 'boolean') result.view[key] = view[key];
  if (typeof view?.font === 'string' && Object.hasOwn(fontLabels, view.font)) result.view.font = view.font as ReadingFont;
  if (typeof view?.fontSize === 'number' && fontSizes.includes(view.fontSize)) result.view.fontSize = view.fontSize;
  if (typeof inference?.provider === 'string' && /^[a-z][a-z0-9_-]*(?::[a-z0-9_-]+)?$/iu.test(inference.provider)) {
    result.inference.provider = inference.provider;
    if (typeof inference.label === 'string') result.inference.label = inference.label;
  }
  if (typeof updates?.automatic === 'boolean') result.updates.automatic = updates.automatic;
  if (typeof updates?.lastAttempt === 'number' && Number.isSafeInteger(updates.lastAttempt) && updates.lastAttempt >= 0) {
    result.updates.lastAttempt = updates.lastAttempt;
  }
  if (typeof usage?.sidebarCollapsed === 'boolean') result.usage.sidebarCollapsed = usage.sidebarCollapsed;
  if (usage?.mappingScope === 'all' || usage?.mappingScope === 'current') result.usage.mappingScope = usage.mappingScope;
  if (isSettingsSection(usage?.section)) result.usage.section = usage.section;
  for (const dimension of ['width', 'height'] as const) {
    const size = window?.[dimension];
    if (typeof size === 'number' && Number.isSafeInteger(size) && size > 0) result.usage.window[dimension] = size;
  }
  if (typeof window?.maximized === 'boolean') result.usage.window.maximized = window.maximized;
  if (usage?.rememberWindowPosition === true) {
    result.usage.rememberWindowPosition = true;
    const position = objectValue(window?.position);
    if (typeof position?.x === 'number' && Number.isSafeInteger(position.x)
      && typeof position.y === 'number' && Number.isSafeInteger(position.y)) {
      result.usage.window.position = { x: position.x, y: position.y };
    }
  }
  if (usage?.startupProject === 'last') {
    result.usage.startupProject = 'last';
    if (typeof usage.lastProject === 'string' && /\.lrproj$/iu.test(usage.lastProject)) result.usage.lastProject = usage.lastProject;
  }
  if (usage?.rememberFolders === true) {
    result.usage.rememberFolders = true;
    for (const kind of folderKinds) {
      const directory = folders?.[kind];
      if (typeof directory === 'string' && directory) result.usage.folders[kind] = directory;
    }
  }
  return result;
}
