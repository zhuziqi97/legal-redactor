import { labels, validCode } from './pipeline.js';
import { viewMaterial } from './review.js';
import { length, slice } from './text.js';
import type { Group, Material, PreviousReview, Row, Workspace } from './workspace-types.js';

const format = 'io.github.zhuziqi97.legalredactor.project';
const schemaVersion = 1;

type ProjectMaterialV1 = Pick<Material, 'id' | 'title' | 'text' | 'decisions' | 'relations' | 'exported' | 'previousReview'>;
type ProjectFileV1 = {
  format: typeof format;
  schemaVersion: typeof schemaVersion;
  workspace: {
    materials: ProjectMaterialV1[];
    groups: Record<string, Group>;
    activeId: string | null;
    nextMaterialId: number;
    sourcePaths: string[];
  };
};

export function encodeProject(state: Workspace): ProjectFileV1 {
  const { materials, groups, activeId, nextMaterialId = 1, sourcePaths = [] } = state;
  return {
    format,
    schemaVersion,
    workspace: {
      materials: materials.map(({ id, title, text, decisions, relations, exported, previousReview }) =>
        ({ id, title, text, decisions, relations, exported, previousReview })),
      groups,
      activeId,
      nextMaterialId,
      sourcePaths: [...new Set([...sourcePaths, ...materials.flatMap(doc => doc.sourcePath ? [doc.sourcePath] : [])])],
    },
  };
}

function check(condition: unknown, field: string): asserts condition {
  if (!condition) throw new Error(`项目数据无效（${field}）。`);
}

function record(value: unknown, field: string): Record<string, unknown> {
  check(value !== null && typeof value === 'object' && !Array.isArray(value), field);
  return value as Record<string, unknown>;
}

function groupsOf(value: unknown): Record<string, Group> {
  const entries = Object.entries(record(value, '代号组'));
  for (const [id, entry] of entries) {
    const group = record(entry, '代号组');
    check(id && group.id === id && typeof group.type === 'string' && Object.hasOwn(labels, group.type)
      && typeof group.primary === 'string' && group.primary.length
      && typeof group.code === 'string' && validCode.fullmatch(group.code), '代号组');
    if (group.areas !== undefined) {
      check(Object.entries(record(group.areas, '地域代号')).every(([name, label]) =>
        name.length && typeof label === 'string' && label.length), '地域代号');
    }
  }
  return Object.fromEntries(entries) as Record<string, Group>;
}

function validateReview(review: Record<string, unknown>, text: string, groups: Record<string, Group>) {
  const size = length(text);
  const position = (value: unknown): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= size;
  check(Array.isArray(review.relations), '关联依据');
  for (const entry of review.relations) {
    const relation = record(entry, '关联依据');
    const { start, end, subject_start: subject, object_start: object } = relation;
    check(typeof relation.type === 'string' && position(start) && position(end) && start < end
      && position(subject) && subject < size && position(object) && object < size, '关联依据位置');
    for (const key of ['statement_start', 'statement_end', 'question_start', 'question_end']) {
      check(relation[key] === undefined || position(relation[key]), '关联依据位置');
    }
    for (const key of ['name', 'value', 'source', 'valueKey']) {
      check(relation[key] == null || typeof relation[key] === 'string', '关联依据');
    }
    check(relation.scope === undefined || Number.isSafeInteger(relation.scope), '关联依据');
    check(relation.roles === undefined || Array.isArray(relation.roles)
      && relation.roles.every(role => typeof role === 'string'), '关联依据');
  }
  if (review.decisions === null) return;
  check(Array.isArray(review.decisions), '复核记录');
  const ids = new Set<number>();
  for (const entry of review.decisions) {
    const row = record(entry, '复核记录');
    const { id, start, end, original, type, group, action, replacement } = row;
    check(typeof id === 'number' && Number.isSafeInteger(id) && id > 0 && !ids.has(id), '复核项编号');
    ids.add(id);
    check(position(start) && position(end) && start < end && slice(text, start, end) === original, '复核项原文位置');
    check(typeof type === 'string' && Object.hasOwn(labels, type)
      && (group === null || typeof group === 'string' && Object.hasOwn(groups, group))
      && (action === 'replace' || action === 'keep' || action === 'review')
      && typeof replacement === 'string', '复核项决定');
    check(typeof row.reason === 'string' && (row.object === null || typeof row.object === 'string')
      && (row.name === null || typeof row.name === 'string'), '复核记录');
    for (const key of ['definitions', 'sourceDefinitions']) {
      const values = row[key];
      check(values === undefined || Array.isArray(values) && values.every(position), '复核项依据位置');
    }
    for (const key of ['aliasType', 'alias_display']) {
      check(row[key] === undefined || typeof row[key] === 'string', '复核项别称');
    }
    const match = row.match;
    check(match === undefined || Array.isArray(match) && match.length === 2
      && match.every(value => typeof value === 'string'), '复核项匹配值');
  }
}

export function decodeProject(value: unknown): Workspace {
  const file = record(value, '文件头');
  if (file.format !== format) throw new Error('请选择 LegalRedactor 项目文件。');
  if (file.schemaVersion !== schemaVersion) throw new Error('此项目的格式版本与当前应用不兼容。');
  const workspace = record(file.workspace, '工作区');
  const groups = groupsOf(workspace.groups);
  const materialIds = new Set<string>();
  let lastId = 0;
  check(Array.isArray(workspace.materials), '材料列表');
  const materials = workspace.materials.map((entry): Material => {
    const doc = record(entry, '材料');
    const { id, title, text, exported } = doc;
    check(typeof id === 'string' && /^[1-9][0-9]*$/.test(id) && Number.isSafeInteger(Number(id))
      && !materialIds.has(id), '材料编号');
    materialIds.add(id);
    lastId = Math.max(lastId, Number(id));
    check(typeof title === 'string' && title.trim().length && typeof text === 'string'
      && (exported === undefined || typeof exported === 'string'), '材料内容');
    validateReview(doc, text, groups);
    const material: Material = { id, title, text, sourcePath: null, revision: 1, exported,
      decisions: doc.decisions as Row[] | null, relations: doc.relations as Material['relations'] };
    if (doc.previousReview !== undefined) {
      const previous = record(doc.previousReview, '历史复核');
      check(typeof previous.text === 'string' && Array.isArray(previous.decisions), '历史复核');
      const previousGroups = groupsOf(previous.groups);
      validateReview(previous, previous.text, previousGroups);
      material.previousReview = { text: previous.text, decisions: previous.decisions as Row[],
        relations: previous.relations as PreviousReview['relations'], groups: previousGroups };
      material.previousOutput = viewMaterial({ ...material, ...material.previousReview }).output;
    }
    return material;
  });

  const { activeId, nextMaterialId, sourcePaths } = workspace;
  check(materials.length ? typeof activeId === 'string' && materialIds.has(activeId) : activeId === null, '当前材料');
  check(typeof nextMaterialId === 'number' && Number.isSafeInteger(nextMaterialId) && nextMaterialId > lastId, '下一个材料编号');
  check(Array.isArray(sourcePaths) && sourcePaths.every(path => typeof path === 'string'), '原件路径');
  return { materials, groups, activeId: activeId as string | null, nextMaterialId, sourcePaths, undo: null, revision: 0 };
}
