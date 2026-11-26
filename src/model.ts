export type Span = { start: number; end: number };
export type ViewOptions = { sync: boolean; newlines: boolean; lineNumbers: boolean; wrap: boolean };
export type Action = 'replace' | 'keep' | 'review';
export const labels = {
  person: '人员', organization: '单位', address: '地址', id_card: '证件', mobile: '电话',
  bank_account: '账号', tail: '尾号', number: '号码', case_number: '案号', social: '社交账号',
  nickname: '昵称', email: '邮箱', uscc: '信用代码',
};
export type Kind = keyof typeof labels;
export type Item = Span & {
  id: number; type: Kind; action: Action; original: string; reason: string; replacement: string;
  group: string | null; output_start: number; output_end: number; definitions?: number[]; sourceDefinitions?: number[];
};
export type Evidence = Span & {
  type: string; subject_start: number; object_start: number; statement_start?: number; statement_end?: number;
};
export type MaterialSummary = {
  id: string; title: string; revision: number; status: 'unrecognized' | 'ready'; pending: number;
  exportState: 'current' | 'changed' | null;
};
export type Material = MaterialSummary & { text: string; output: string; items: Item[]; evidence: Evidence[]; previousOutput?: string | null };
export type SourceFile = { path: string; title: string; text: string; encoding: string };
export type ImportSelection = SourceFile | { requiresEncoding: true; title: string };
export type InferenceSettings = { enabled: boolean; provider: string; providers: { name: string; bundled: boolean }[] };
export type Term = { original: string };
export type Occurrence = Span & Term & {
  materialId: string; itemId: number | null; title: string; line: number; before: string; after: string;
  replacement: string; group: string | null; action: Action | null; conflict?: string;
};
export type Group = {
  id: string; code: string; type: Kind; primary: string; occurrences: Occurrence[];
};
export type Workspace = {
  documents: MaterialSummary[]; current: Material | null; groups: Group[]; pending: Occurrence[]; canUndo: boolean; revision: number;
};
export type MergeConflict = {
  reason: 'code' | 'range' | 'value';
  groups: string[]; canRetain: boolean; codeChoices: boolean;
  options: { groupId: string; whole: boolean; selected: boolean }[];
  occupants?: {groupId: string; code: string; kind: 'primary' | 'alias'}[];
};
export type Issue = Partial<Span> & {
  message: string; materialId?: string; itemId?: number; positions?: Occurrence[]; stalePreview?: boolean; merge?: MergeConflict;
};
export type WorkspaceResult = { view: Workspace; focus?: Occurrence } | { issue: Issue };
export type AdjustmentImpact = Span & { line: number; before: string; after: { text: string; restored?: boolean }[] };
export type AdjustmentPreview = {
  revision: number; code: string; primary: string;
  materials: { materialId: string; title: string; changes: AdjustmentImpact[]; removedCount: number; restoredCount: number }[];
};
export type AdjustmentPreviewResult = { preview: AdjustmentPreview } | { issue: Issue } | { error: string };
export type RangeCandidate = { position: Occurrence; clear: boolean; overlap: boolean };
export type RangeSuggestion = { original: Occurrence; candidates: RangeCandidate[] };
export type OriginalEdit = { base: string; value: string; origin?: Occurrence; manual: Record<string, Occurrence> };
export type SourceChange = { group: Group; moved: Occurrence[]; rest: Occurrence[]; terms: Occurrence[] };
export type OutputResult = { output: string; sourcePaths: string[]; filename: string } | { issues: Issue[] };

declare global {
  interface Window {
    redaction: {
      viewOptions(): Promise<ViewOptions>;
      onViewOptions(callback: (options: ViewOptions) => void): void;
      open: (mode?: 'restore') => Promise<ImportSelection | null>;
      decodeImport: (mode?: 'restore') => Promise<SourceFile>;
      inferenceSettings: () => Promise<InferenceSettings>;
      setProvider: (provider: string) => Promise<string>;
      onOpenSettings: (callback: () => void) => void;
      initialProject: () => Promise<Workspace | null>;
      openProject: (password?: string | null) => Promise<{view: Workspace} | {locked: true; title: string} | null>;
      saveProject: (password?: string | null, destination?: {name: string; directory: string}) => Promise<{ dirty: boolean } | null>;
      projectSaveStatus: () => Promise<{hasFile: boolean; protected: boolean; name: string; directory: string}>;
      pickProjectDirectory: (directory: string) => Promise<string | null>;
      onProjectCommand: (callback: (command: 'open' | 'save' | 'saveAs' | 'password') => void) => void;
      engine: <T>(request: { op: string } & Record<string, unknown>) => Promise<T>;
      cancel: () => Promise<void>;
      setDraftDirty: (dirty: boolean) => void;
      recordRender: (milliseconds: number) => void;
      closeWorkspace: (discard: boolean) => Promise<void>;
      copy: (text: string) => Promise<void>;
      save: (output: string, sourcePaths: string[], filename: string, mode?: 'restore') => Promise<string | null>;
      onProgress: (callback: (message: string) => void) => void;
      onConfirmClose: (callback: () => void) => void;
    };
  }
}

export function categoryColor(kind: Kind) {
  switch (kind) {
    case 'person': case 'nickname': return 'color-person';
    case 'organization': return 'color-unit';
    case 'address': return 'color-address';
    default: return 'color-number';
  }
}

export function positionKey(position: Span & { materialId: string }) {
  return `${position.materialId}:${position.start}:${position.end}`;
}

export function samePersonKind(left: Kind, right: Kind) {
  return left === right || (['person', 'nickname'].includes(left) && ['person', 'nickname'].includes(right));
}

export function prettyError(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': Error: /, '');
}

export type Adjustment = {
  mode: 'create' | 'bind' | 'alias' | 'remove' | 'edit';
  title: string;
  groupId: string;
  fixedTarget: boolean;
  type: Kind;
  code: string;
  query: string;
  scope: 'current' | 'all';
  rows: Occurrence[];
  searchKeys: Set<string>;
  chosen: Set<string>;
  primaries: Record<string, string>;
  edits: Record<string, Occurrence>;
  originalEdit?: OriginalEdit;
  primary: string;
  resolution: { mode: 'whole' | 'selected' | 'retain'; targetId?: string } | null;
  keep: boolean;
  error: string;
  issue: Issue | null;
  searched: boolean;
};
