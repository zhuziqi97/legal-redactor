import type { Relation } from './context.js';
import type { Action, Decision } from './pipeline.js';

export type Row = Decision & {
  id: number; group: string | null; aliasType?: string; match?: [kind: string, value: string]; sourceDefinitions?: number[];
};
export type Group = {id: string; type: string; primary: string; code: string};
export type PreviousReview = {text: string; decisions: Row[]; relations: Relation[]; groups: Record<string, Group>};
export type Material = {
  id: string; title: string; text: string; sourcePath: string | null;
  decisions: Row[] | null; relations: Relation[]; revision?: number;
  exported?: string; previousOutput?: string; previousReview?: PreviousReview;
};
export type Workspace = {
  materials: Material[]; groups: Record<string, Group>; activeId: string | null; revision: number;
  undo: {groups: Record<string, Group>; rows: Record<string, Row[] | null>} | null;
  nextMaterialId?: number; sourcePaths?: string[];
};
export type Position = {materialId: string; start: number; end: number; itemId?: number | null};
export type Occurrence = Required<Position> & {
  title: string; before: string; after: string; original: string; line: number;
  replacement: string; group: string | null; action: Action | null; conflict?: string;
};
export type MergeMode = 'whole' | 'selected' | 'retain';
export type MergeOption = {groupId: string; whole: boolean; selected: boolean};
export type MergeReason = 'code' | 'range' | 'value';
export type CodeOccupant = {groupId: string; code: string; kind: 'primary' | 'alias'};
export type AliasTarget = {original: string; code: string};
export type TargetCodeChoice = {original: string; codes: {code: string; count: number}[]};
export type Issue = {
  message: string; materialId?: string; itemId?: number; start?: number; end?: number;
  positions?: Occurrence[]; stalePreview?: boolean;
  targetCodeChoices?: TargetCodeChoice[];
  merge?: {reason: MergeReason; groups: string[]; options: MergeOption[]; canRetain: boolean; codeChoices: boolean;
    occupants?: CodeOccupant[]};
};
export type Change = {
  mode: 'editMapping' | 'rename' | 'primary' | 'merge' | 'delete' | 'create' | 'bind' | 'range' | 'keep' | 'review';
  groupId?: string; type?: string; code?: string; positions?: Position[]; rebindPositions?: Position[];
  resolution?: {mode: MergeMode; targetId?: string}; targetId?: string; term?: {original: string};
  alias?: AliasTarget;
  targetCodes?: Record<string, string>;
  primaries?: Record<string, {original: string}>; primary?: string; keep?: boolean;
};
export type Request =
  | {op: 'view' | 'undo'}
  | {op: 'search'; text: string; materialId?: string | null}
  | {op: 'editSuggestions'; groupId: string; text: string; original: string; origin?: Position}
  | {op: 'candidate'; materialId: string; start: number; end: number}
  | {op: 'previewAdjustment'; change: Change}
  | {op: 'suggest'; type: string; text: string}
  | {op: 'output'; materialId: string; decisionsOnly?: boolean}
  | {op: 'apply'; change: Change; expectedRevision?: number}
  | {op: 'add'; text: string; title: string; sourcePath?: string}
  | {op: 'renameMaterial'; materialId: string; title: string}
  | {op: 'editMaterial' | 'markExported'; materialId: string; text: string}
  | {op: 'deleteMaterial' | 'open'; materialId: string}
  | {op: 'scan'; materialId: string; revision?: number}
  | {op: 'reviseMaterial'; materialId: string; revision: number; text: string};
