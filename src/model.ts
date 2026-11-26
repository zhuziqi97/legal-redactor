import type { RedactionAPI } from '../electron/contract';
import type { AliasTarget, Issue, Occurrence } from '../engine/workspace-types';
import type { WorkspaceReplies, WorkspaceView } from '../engine/workspace';
export type { SourceFile } from '../electron/contract';
export type { ViewOptions } from '../engine/preferences';
export type { Issue, Occurrence } from '../engine/workspace-types';
export type Workspace = WorkspaceView;
export type Material = NonNullable<WorkspaceView['current']>;
export type MaterialSummary = WorkspaceView['documents'][number];
export type Group = WorkspaceView['groups'][number];
export type Span = { start: number; end: number };
export type Item = Material['items'][number];
export type Evidence = Material['evidence'][number];
export const labels = {
  person: '人员', organization: '单位', address: '地址', id_card: '证件', mobile: '电话',
  bank_account: '账号', tail: '尾号', number: '号码', case_number: '案号', social: '社交账号',
  nickname: '昵称', email: '邮箱', uscc: '信用代码',
};
export function kindLabel(kind: string) { return labels[kind as keyof typeof labels]; }
export type Term = { original: string };
export type AdjustmentPreview = Extract<WorkspaceReplies['previewAdjustment'], {preview: unknown}>['preview'];
export type AdjustmentPreviewResult = { preview: AdjustmentPreview } | { issue: Issue } | { error: string };
export type RangeCandidate = { position: Occurrence; clear: boolean; overlap: boolean };
export type RangeSuggestion = { original: Occurrence; candidates: RangeCandidate[] };
export type OriginalEdit = { base: string; value: string; origin?: Occurrence; manual: Record<string, Occurrence> };
export type SourceChange = { group: Group; moved: Occurrence[]; rest: Occurrence[]; terms: Occurrence[] };
declare global { interface Window { redaction: RedactionAPI } }

export function categoryColor(kind: string) {
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

export function prettyError(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': Error: /, '');
}

export type Adjustment = {
  mode: 'create' | 'bind' | 'remove' | 'edit' | 'merge';
  title: string;
  groupId: string;
  fixedTarget: boolean;
  alias?: AliasTarget;
  rebindAlias?: string;
  targetOriginal?: string;
  type: string;
  code: string;
  query: string;
  scope: 'current' | 'all';
  rows: Occurrence[];
  searchKeys: Set<string>;
  chosen: Set<string>;
  primaries: Record<string, string>;
  targetCodes: Record<string, string>;
  edits: Record<string, Occurrence>;
  originalEdit?: OriginalEdit;
  primary: string;
  resolution: { mode: 'whole' | 'selected' | 'retain'; targetId?: string } | null;
  keep: boolean;
  error: string;
  issue: Issue | null;
  searched: boolean;
};
