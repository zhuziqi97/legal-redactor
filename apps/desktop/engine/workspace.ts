import { overlap, type Relation } from './context.js';
import { displayBase } from './display.js';
import { NUMBER_KINDS, PERSON_VALUE, TITLE } from './field-rules.js';
import { typicalName } from './fields.js';
import { buildPlan, completeNumber, labels, normalized, reviewDecisions, validCode, type Action, type Scan } from './pipeline.js';
import { amend, checkedOutput, displayCode, requireDecisions, viewMaterial, type MaterialItem } from './review.js';
import { project, revisionBlocks } from './revision.js';
import { bisect, indexOf, keyOf, length, lineNumber, rule, slice, trim, type Span } from './text.js';
import type {
  Change, CodeOccupant, Group, Issue, Material, MergeOption, MergeReason, Occurrence, Position, PreviousReview, Request, Row, Workspace,
} from './workspace-types.js';

const nameKinds = new Set(['person', 'nickname', 'organization']);
const shortName = rule('(?:小|老|阿)[\\u3400-\\u9fff]');
const revisedReview = '原文或关联依据有改动，请复核';
type Member = [material: Material, row: Row];
type Primaries = Record<string, {original: string}>;
type Adjustment = {changed?: boolean; focus?: Occurrence | null; groupId?: string; primaries?: Primaries};
type AdjustmentResult = Adjustment | {issue: Issue};

function* members(state: Workspace, id: string): Generator<Member> {
  for (const doc of state.materials) {
    for (const row of doc.decisions ?? []) if (row.group === id && row.action === 'replace') yield [doc, row];
  }
}

function literalCodes(text: string) {
  return [...validCode.finditer(text)].map(match => match.value);
}

function occupied(state: Workspace) {
  const codes = new Set(Object.values(state.groups).map(group => group.code));
  for (const doc of state.materials) {
    for (const code of literalCodes(doc.text)) codes.add(code);
    for (const row of doc.decisions ?? []) if (row.action === 'replace') codes.add(row.replacement);
  }
  return codes;
}

function allocateCode(kind: string, raw: string, used: Set<string>) {
  const [stem, first] = displayBase(kind, raw, labels[kind]);
  let number = first;
  let code = `【${stem}${number || ''}】`;
  while (used.has(code)) code = `【${stem}${++number}】`;
  return code;
}

function updateCode(row: Row, code: string) {
  if (row.alias_display === row.replacement) row.alias_display = code;
  row.replacement = code;
}

function lookupMaterial(state: Workspace, id: string) {
  const doc = state.materials.find(item => item.id === id);
  if (!doc) throw new Error('找不到这份材料。');
  return doc;
}

function findGroup(state: Workspace, id?: string) {
  const group = id && Object.hasOwn(state.groups, id) ? state.groups[id] : undefined;
  if (!group) throw new Error('找不到这个映射。');
  return group;
}

const compatible = (left: string, right: string) => left === right || (
  ['person', 'nickname'].includes(left) && ['person', 'nickname'].includes(right)
);

function occurrence(doc: Material, row: Pick<Row, 'start' | 'end'> & Partial<Row>): Occurrence {
  const {start, end} = row;
  const {text} = doc;
  return {
    materialId: doc.id, title: doc.title, itemId: row.id ?? null, start, end, line: lineNumber(text, start),
    original: slice(text, start, end), before: slice(text, Math.max(0, start - 22), start).split('\n').at(-1)!,
    after: slice(text, end, end + 25).split('\n')[0], replacement: row.replacement ?? '',
    group: row.group ?? null, action: row.action ?? null,
  };
}

function workspaceView(state: Workspace) {
  const groups = Object.fromEntries(Object.entries(state.groups).map(([id, group]) =>
    [id, {...group, occurrences: [] as Occurrence[]}]));
  const documents = [];
  const pending: Occurrence[] = [];
  let current = null;
  for (const doc of state.materials) {
    const result = viewMaterial(doc);
    let count = 0;
    for (const row of result.items) {
      if (row.action === 'review') {
        pending.push(occurrence(doc, row));
        count++;
      } else if (row.group) groups[row.group].occurrences.push(occurrence(doc, row));
    }
    const summary = {id: doc.id, title: doc.title, revision: doc.revision ?? 1,
      status: doc.decisions ? 'ready' : 'unrecognized', pending: count,
      exportState: doc.exported == null ? null : doc.exported === result.output ? 'current' : 'changed'};
    documents.push(summary);
    if (doc.id === state.activeId) current = {...summary, text: doc.text, ...result, previousOutput: doc.previousOutput ?? null};
  }
  return {documents, current, groups: Object.values(groups), pending, canUndo: state.undo !== null, revision: state.revision};
}

function normalizedText(input: string) {
  const text = input.replace(/\r\n?/gu, '\n');
  if (!trim(text)) throw new Error('请输入原文。');
  return text;
}

function addMaterial(state: Workspace, request: Extract<Request, {op: 'add'}>) {
  const text = normalizedText(request.text);
  const index = state.nextMaterialId ?? state.materials.reduce((max, doc) => Math.max(max, Number(doc.id)), 0) + 1;
  state.nextMaterialId = index + 1;
  const path = request.sourcePath ?? null;
  if (path) {
    state.sourcePaths ??= [];
    if (!state.sourcePaths.includes(path)) state.sourcePaths.push(path);
  }
  state.materials.push({id: String(index), title: trim(request.title) || `材料${String(index).padStart(2, '0')}`,
    sourcePath: path, text, decisions: null, relations: [], revision: 1});
  state.activeId = String(index);
}

function reuseRegistry(state: Workspace) {
  const matches = new Map<string, {kind: string; value: string; groups: Set<string>}>();
  for (const doc of state.materials) {
    for (const row of doc.decisions ?? []) {
      if (!row.match || row.action !== 'replace' || !row.group) continue;
      const key = keyOf(...row.match);
      const [kind, value] = row.match;
      if (!matches.has(key)) matches.set(key, {kind, value, groups: new Set()});
      matches.get(key)!.groups.add(row.group);
    }
  }
  const known = new Map<string, string>();
  const records: Record<string, {kind: string; value: string; identity: null; replacement: string; scope: null}> = {};
  const names: Record<string, string> = Object.create(null);
  let next = 1;
  for (const [key, {kind, value, groups}] of matches) {
    if (groups.size !== 1) continue;
    const id = groups.values().next().value!;
    const code = state.groups[id].code;
    known.set(key, id);
    if (kind === 'person') names[value] = code;
    else records[String(next++)] = {kind, value, identity: null, replacement: code, scope: null};
  }
  return {known, records, names};
}

function aliasCode(state: Workspace, group: Group, raw: string, type: string, reserved: Set<string>) {
  if (!type) return group.code;
  for (const [, row] of members(state, group.id)) {
    if (row.original === raw && row.aliasType === type) return row.replacement;
  }
  let number = 1;
  let code = `${group.code.slice(0, -1)}-${type}${number}】`;
  while (reserved.has(code)) code = `${group.code.slice(0, -1)}-${type}${++number}】`;
  reserved.add(code);
  return code;
}

function attachScanRow(row: Row, group: Group, code: string, literal: Set<string>) {
  updateCode(row, code);
  if (literal.has(code)) Object.assign(row, {action: 'review', reason: '案内代号与本份原文已有记号相同'});
  else row.group = group.id;
}

function candidate(doc: Material, start: number, end: number) {
  const rows = requireDecisions(doc);
  const selected = {start, end};
  if (!(0 <= start && start < end && end <= length(doc.text)) || !trim(slice(doc.text, start, end))) {
    throw new Error('请在原文中选中要处理的文字。');
  }
  const conflict = rows.find(row => overlap(row, selected));
  if (conflict?.start === start && conflict.end === end) return occurrence(doc, conflict);
  const result = occurrence(doc, selected);
  if (conflict) result.conflict = `与「${conflict.original}」重叠`;
  return result;
}

function search(state: Workspace, request: Extract<Request, {op: 'search'}>) {
  const word = trim(request.text);
  if (!word) return [];
  const size = length(word);
  const found = [];
  for (const doc of state.materials) {
    if (!doc.decisions || (request.materialId != null && request.materialId !== doc.id)) continue;
    for (let at = indexOf(doc.text, word); at >= 0; at = indexOf(doc.text, word, at + size)) {
      found.push(candidate(doc, at, at + size));
    }
  }
  return found;
}

function editSuggestions(state: Workspace, request: Extract<Request, {op: 'editSuggestions'}>) {
  const word = request.text;
  if (!trim(word)) return [];
  const size = length(word);
  const group = findGroup(state, request.groupId);
  const masks = new Map<string, {ordered: Row[]; ends: number[]}>();
  const suggestions = [];
  for (const [doc, old] of members(state, group.id)) {
    const origin = request.origin;
    if (origin ? doc.id !== origin.materialId || old.id !== origin.itemId : old.original !== request.original) continue;
    const {text} = doc;
    const {start, end} = old;
    if (!masks.has(doc.id)) {
      const ordered = [...requireDecisions(doc)].sort((a, b) => a.start - b.start);
      masks.set(doc.id, {ordered, ends: ordered.map(row => row.end)});
    }
    const {ordered, ends} = masks.get(doc.id)!;
    const lower = Math.max(0, start - size + 1);
    const upper = Math.min(length(text), end + size - 1);
    const candidates = [];
    for (let at = indexOf(text, word, lower); at >= 0 && at + size <= upper; at = indexOf(text, word, at + 1)) {
      const stop = at + size;
      let index = bisect(ends, at, true);
      let coversOther = false;
      while (index < ordered.length && ordered[index].start < stop) {
        if (ordered[index++].id !== old.id) {
          coversOther = true;
          break;
        }
      }
      const contained = (start <= at && stop <= end) || (at <= start && end <= stop);
      candidates.push({position: occurrence(doc, {start: at, end: stop, id: old.id}),
        clear: contained && !coversOther, overlap: coversOther});
    }
    suggestions.push({original: occurrence(doc, old), candidates});
  }
  return suggestions;
}

function resolvePosition(state: Workspace, position: Position, kind?: string): Member | {issue: Issue} {
  const doc = lookupMaterial(state, position.materialId);
  const rows = requireDecisions(doc);
  let found = rows.find(row => row.id === position.itemId);
  const conflict = rows.find(row => row !== found && overlap(row, position));
  if (conflict) return {issue: {message: `选区与「${conflict.original}」重叠。`, materialId: doc.id, itemId: conflict.id}};
  if (!found || position.start !== found.start || position.end !== found.end) {
    const result = amend(doc, {id: position.itemId, start: position.start, end: position.end,
      type: kind || found?.type || 'person', action: 'keep'});
    if ('issue' in result) return {issue: {...result.issue, materialId: doc.id}};
    doc.decisions = result.decisions;
    found = doc.decisions.find(row => row.id === result.itemId)!;
    delete found.match;
  }
  return [doc, found];
}

function resolveCoverage(state: Workspace, positions: Position[], kind?: string): Member[] | {issue: Issue} {
  const entries = new Map<string, [number, Position][]>();
  const resolved: Member[] = [];
  for (const [index, position] of positions.entries()) {
    if (!entries.has(position.materialId)) entries.set(position.materialId, []);
    entries.get(position.materialId)!.push([index, position]);
  }
  for (const [id, selections] of entries) {
    const doc = lookupMaterial(state, id);
    const existing = requireDecisions(doc);
    const ordered = selections.map(([, position]) => position).sort((a, b) => a.start - b.start);
    for (let i = 1; i < ordered.length; i++) {
      const first = ordered[i - 1];
      const second = ordered[i];
      if (second.start < first.end) {
        return {issue: {message: '两个已选范围重叠，请取消其中一处。', materialId: id,
          start: second.start, end: second.end, positions: [occurrence(doc, first), occurrence(doc, second)]}};
      }
    }
    const byId = new Map(existing.map(row => [row.id, row]));
    const byRange = new Map(existing.map(row => [keyOf(row.start, row.end), row]));
    const ends = ordered.map(position => position.end);
    let nextId = existing.reduce((max, row) => Math.max(max, row.id), 0) + 1;
    const reused = new Set<number>();
    const displaced = new Set<number>();
    const rows: Row[] = [];
    for (const [index, {start, end, itemId}] of selections) {
      if (!(0 <= start && start < end && end <= length(doc.text)) || !trim(slice(doc.text, start, end))) {
        throw new Error('请在原文中选中要处理的文字。');
      }
      const exact = byRange.get(keyOf(start, end));
      const referenced = itemId == null ? undefined : byId.get(itemId);
      if (itemId != null && !referenced) throw new Error('找不到这处复核项，请重新选定。');
      const old = exact ?? referenced;
      let row: Row;
      if (exact) row = {...exact};
      else {
        const amended = amend({...doc, decisions: old ? [old] : []}, {
          id: old?.id, start, end, type: kind || old?.type || 'person', action: 'keep',
        });
        if ('issue' in amended) return amended;
        row = amended.decisions[0];
        delete row.match;
      }
      if (referenced) displaced.add(referenced.id);
      if (!old || reused.has(old.id)) row.id = nextId++;
      reused.add(row.id);
      rows.push(row);
      resolved[index] = [doc, row];
    }
    doc.decisions = [...existing.filter(row => {
      const next = bisect(ends, row.start, true);
      return !(next < ordered.length && ordered[next].start < row.end) && !displaced.has(row.id);
    }), ...rows];
  }
  return resolved;
}

function manual(row: Row, group: Group | null, code: string, action: Action, aliasType = '', keepEvidence = false) {
  if (keepEvidence && row.definitions?.length) row.sourceDefinitions = row.definitions;
  else if (!keepEvidence) delete row.sourceDefinitions;
  delete row.definitions;
  delete row.alias_display;
  Object.assign(row, {group: group?.id ?? null, action, replacement: code, aliasType, reason: '人工订正'});
}

function restoreManualReview(state: Workspace, doc: Material, previous: PreviousReview) {
  const blocks = [...revisionBlocks(previous.text, doc.text)];
  const oldEvidence = new Map(previous.relations.map(link => [link.start, link]));
  const evidenceKey = (link: Relation, start = link.start) => keyOf(start, link.type, link.name, link.value);
  const newEvidence = new Set(doc.relations.map(link => evidenceKey(link)));
  const literal = new Set(literalCodes(doc.text));
  for (const old of previous.decisions) {
    if (old.reason !== '人工订正' && old.reason !== revisedReview) continue;
    const target = project(blocks, old.start, old.end);
    if (!target) continue;
    let [start, end, unchanged] = target;
    const surface = slice(doc.text, start, end);
    start += length(surface) - length(trim(surface, undefined, 'left'));
    end -= length(surface) - length(trim(surface, undefined, 'right'));
    if (start >= end) continue;
    const keys = [];
    for (const key of old.sourceDefinitions ?? []) {
      const link = oldEvidence.get(key);
      const mapped = link && project(blocks, link.start, link.end);
      if (link && mapped && mapped[2] && newEvidence.has(evidenceKey(link, mapped[0]))) keys.push(mapped[0]);
      else unchanged = false;
    }
    let group = old.group ? state.groups[old.group] : undefined;
    if (unchanged && old.group && !group) {
      const reserved = previous.groups[old.group];
      if (occupied(state).has(reserved.code)) unchanged = false;
      else group = state.groups[reserved.id] = {...reserved};
    }
    const resolved = resolveCoverage(state, [{materialId: doc.id, start, end}], old.type);
    if ('issue' in resolved) throw new Error(resolved.issue.message);
    const [, row] = resolved[0];
    delete row.match;
    if (unchanged && (!group || !literal.has(group.code))) {
      const label = old.aliasType ?? '';
      const code = group ? aliasCode(state, group, row.original, label, occupied(state)) : '';
      manual(row, group ?? null, code, old.action, label);
      if (keys.length) row.sourceDefinitions = keys;
    } else {
      manual(row, null, '', 'review');
      row.reason = revisedReview;
    }
  }
}

function repairGroups(state: Workspace, primaries: Primaries) {
  const live = new Map<string, string[]>();
  for (const doc of state.materials) {
    for (const row of doc.decisions ?? []) {
      if (row.action !== 'replace' || !row.group) continue;
      if (!live.has(row.group)) live.set(row.group, []);
      live.get(row.group)!.push(row.original);
    }
  }
  for (const [id, group] of Object.entries(state.groups)) {
    const terms = live.get(id);
    if (!terms) {
      delete state.groups[id];
      continue;
    }
    const chosen = primaries[id];
    if (chosen) {
      if (!terms.includes(chosen.original)) throw new Error('请选择映射中仍有位置的主名。');
      group.primary = chosen.original;
    } else if (!terms.includes(group.primary)) group.primary = terms[0];
  }
}

type NewId = () => string;
function newGroup(state: Workspace, type: string, primary: string, code: string, newId: NewId) {
  const id = newId();
  return state.groups[id] = {id, type, primary, code};
}

function settleAliases(state: Workspace, newId: NewId) {
  const used = occupied(state);
  for (const doc of state.materials) {
    if (!doc.decisions) continue;
    const {rows} = reviewDecisions(doc.text, doc.relations, doc.decisions);
    const independent = new Map<string, Group>();
    for (const [index, row] of rows.entries()) {
      const before = doc.decisions[index];
      if (before.action === row.action && before.replacement === row.replacement) continue;
      row.group = null;
      row.aliasType = '';
      if (row.action === 'replace') {
        const key = keyOf(row.type, row.original, row.replacement);
        let group = independent.get(key);
        if (!group) {
          const code = allocateCode(row.type, row.original, used);
          used.add(code);
          group = newGroup(state, row.type, row.original, code, newId);
          independent.set(key, group);
        }
        row.group = group.id;
        row.replacement = group.code;
      }
    }
    doc.decisions = rows;
  }
}

async function scanMaterial(state: Workspace, doc: Material, newId: NewId, scan?: Scan) {
  if (doc.decisions) throw new Error('这份材料已经识别。');
  const {known, records, names} = reuseRegistry(state);
  const used = occupied(state);
  const previous = doc.previousReview;
  if (previous) {
    for (const row of previous.decisions) {
      if (row.group && row.reason === '人工订正') used.add(previous.groups[row.group].code);
    }
  }
  const [raw, objects, relations] = await buildPlan(doc.text, records, scan, doc.id, names);
  const {rows, links: supported} = reviewDecisions(doc.text, relations, raw);
  doc.decisions = rows.map((row, index) => ({...row, id: index + 1, group: null, aliasType: ''}));
  doc.relations = relations;
  const local = new Map<string, Group>();
  const waiting: [Row, Relation][] = [];
  const links = new Map(supported.filter(link => link.type !== '证件').map(link => [link.start, link]));
  const at = new Map(doc.decisions.map(row => [row.start, row]));
  const literal = new Set(literalCodes(doc.text));
  for (const row of doc.decisions) {
    if (row.action !== 'replace') continue;
    const link = (row.definitions ?? []).map(key => links.get(key)).find(Boolean);
    if (link && link.subject_start !== row.start) {
      waiting.push([row, link]);
      continue;
    }
    const record = row.object ? objects[row.object] : undefined;
    let match: Row['match'];
    if (row.type === 'person') {
      const name = row.original;
      if (name === row.name && PERSON_VALUE.fullmatch(name) && typicalName(name) &&
        !TITLE.fullmatch(name) && !shortName.fullmatch(name)) match = ['person', name];
    } else if (record && record.scope === null && record.kind === row.type) {
      const value = normalized(row.type, row.original);
      if (value === record.value) match = [row.type, value];
    }
    if (match) row.match = match;
    const key = keyOf(...(match ?? [row.type, row.replacement]));
    const knownId = match && known.get(key);
    let group = (knownId && state.groups[knownId]) || local.get(key);
    if (!group) {
      const code = used.has(row.replacement) ? allocateCode(row.type, row.original, used) : row.replacement;
      used.add(code);
      group = newGroup(state, row.type, row.original, code, newId);
      local.set(key, group);
    }
    attachScanRow(row, group, group.code, literal);
  }
  for (const [row, link] of waiting) {
    const subject = at.get(link.subject_start);
    const group = subject?.group && state.groups[subject.group];
    if (!group) {
      Object.assign(row, {action: 'review', reason: '请核对别称归属'});
      continue;
    }
    const label = link.type === '聊天昵称' ? '微信昵称' : link.type === '曾用名' ? '曾用名' : '';
    const code = aliasCode(state, group, row.original, label, used);
    row.aliasType = label;
    attachScanRow(row, group, code, literal);
  }
  if (previous) restoreManualReview(state, doc, previous);
  state.undo = null;
  settleAliases(state, newId);
  repairGroups(state, {});
}

function moveMembers(state: Workspace, rows: Iterable<Member>, target: Group, used: Set<string>, keepEvidence = false) {
  for (const [, row] of rows) {
    const label = row.aliasType ?? '';
    const code = aliasCode(state, target, row.original, label, used);
    manual(row, target, code, 'replace', label, keepEvidence);
  }
}

function literalIssue(state: Workspace, requested: Set<string>) {
  const positions = state.materials.flatMap(doc => [...validCode.finditer(doc.text)]
    .filter(match => requested.has(match.value))
    .map(match => occurrence(doc, {start: match.start(), end: match.end()})));
  return positions.length ? {issue: {message: '原文已有相同标记，请另选代号。', positions}} : undefined;
}

function sameCompleteValue(kind: string, raw: string, original: string) {
  return normalized(kind, raw) === normalized(kind, original) &&
    (!NUMBER_KINDS.has(kind) || completeNumber(kind, raw, '人工订正'));
}

function codeOccupants(state: Workspace, requested: Set<string>, excludedId?: string) {
  const found = new Map<string, CodeOccupant>();
  for (const group of Object.values(state.groups)) {
    if (group.id !== excludedId && requested.has(group.code)) {
      found.set(keyOf(group.id, group.code), {groupId: group.id, code: group.code, kind: 'primary'});
    }
  }
  for (const doc of state.materials) {
    for (const row of doc.decisions ?? []) {
      if (!row.group || row.group === excludedId || row.action !== 'replace' || !requested.has(row.replacement)) continue;
      const key = keyOf(row.group, row.replacement);
      if (!found.has(key)) found.set(key, {groupId: row.group, code: row.replacement, kind: 'alias'});
    }
  }
  return [...found.values()];
}

type Conflict = {reason: MergeReason | null; targets: Group[]; occupants?: CodeOccupant[]} | {issue: Issue};
function mappingEditConflict(state: Workspace, group: Group, positions: Position[], code: string): Conflict {
  const others = Object.values(state.groups).filter(target => target !== group);
  const codes = new Map<string, Set<string>>();
  const originals = new Map<string, Set<string>>();
  for (const doc of state.materials) {
    for (const row of doc.decisions ?? []) {
      if (!row.group || row.action !== 'replace') continue;
      if (!codes.has(row.group)) {
        codes.set(row.group, new Set());
        originals.set(row.group, new Set());
      }
      codes.get(row.group)!.add(row.replacement);
      originals.get(row.group)!.add(row.original);
    }
  }
  if (code !== group.code) {
    const requested = new Set([code, ...[...(codes.get(group.id) ?? [])]
      .map(value => code.slice(0, -1) + slice(value, length(group.code) - 1))]);
    const issue = literalIssue(state, requested);
    if (issue) return issue;
    const occupants = codeOccupants(state, requested, group.id);
    if (occupants.length) {
      const owners = new Set(occupants.map(item => item.groupId));
      return {reason: 'code', targets: others.filter(target => owners.has(target.id)), occupants};
    }
  }
  const touched = new Set<string>();
  const values = new Set<string>();
  for (const position of positions) {
    const doc = lookupMaterial(state, position.materialId);
    values.add(slice(doc.text, position.start, position.end));
    for (const row of requireDecisions(doc)) if (row.group && overlap(row, position)) touched.add(row.group);
  }
  const overlaps = others.filter(target => touched.has(target.id));
  if (overlaps.length) return {reason: 'range', targets: overlaps};
  const matches = others.filter(target => compatible(group.type, target.type) &&
    [...(originals.get(target.id) ?? [])].some(value => values.has(value)));
  return {reason: matches.length ? 'value' : null, targets: matches};
}

function editMapping(state: Workspace, group: Group, change: Change, used: Set<string>) {
  const positions = change.positions ?? [];
  const rebind = change.rebindPositions ?? [];
  const code = displayCode(change.code!);
  const sourceRows = [...members(state, group.id)];
  const sourceIds = new Map(sourceRows.map(([doc, row]) => [keyOf(doc.id, row.id), row]));
  const positionKey = (position: Position) => keyOf(position.materialId, position.itemId);
  const originals = positions.map(position => sourceIds.get(positionKey(position)));
  if (originals.some(row => !row)) throw new Error('要修改的位置已变更，请重新选择。');
  const conflicts = mappingEditConflict(state, group, positions, code);
  if ('issue' in conflicts) return conflicts;
  const {reason, targets, occupants} = conflicts;
  const selectedPositions = positions.length ? positions : rebind;
  if (rebind.some(position => !sourceIds.has(positionKey(position)))) throw new Error('要改绑的位置已变更，请重新选择。');
  const options: MergeOption[] = [];
  let codeChoices = false;
  for (const target of targets) {
    const {type} = target;
    if (!compatible(group.type, type)) continue;
    if (reason === 'code' && target.code !== code) continue;
    let whole = nameKinds.has(type) || type === 'address';
    let selected = !!selectedPositions.length;
    if (!whole) {
      const sameValue = (raw: string) => sameCompleteValue(type, raw, target.primary);
      const replacementValues = positions.map(pos => slice(lookupMaterial(state, pos.materialId).text, pos.start, pos.end));
      const selectedValues = positions.length ? replacementValues : rebind.map(pos => sourceIds.get(positionKey(pos))!.original);
      const modified = new Set(positions.map(positionKey));
      selected = selected && selectedValues.every(sameValue);
      whole = replacementValues.every(sameValue) && sourceRows.every(([doc, row]) =>
        modified.has(keyOf(doc.id, row.id)) || sameValue(row.original));
      if (reason === 'code' && !positions.length) codeChoices ||= sourceRows.some(([, row]) => sameValue(row.original));
    }
    if (reason === 'code' && !positions.length) codeChoices ||= whole;
    options.push({groupId: target.id, whole, selected});
  }
  const {mode: choice, targetId} = change.resolution ?? {};
  const canRetain = reason === 'range' || reason === 'value';
  const validTarget = (choice === 'whole' || choice === 'selected') && options.some(option => option.groupId === targetId && option[choice]);
  if (reason && !(choice === 'retain' && canRetain) && !validTarget) {
    const messages = {code: '这个代号已被其他映射使用。', range: '新选区与其他映射重叠。', value: '新原词已出现在其他映射中。'};
    return {issue: {message: messages[reason], merge: {reason, groups: targets.map(target => target.id), options, canRetain, codeChoices,
      ...(occupants && {occupants})}}};
  }

  const destination = reason && validTarget ? findGroup(state, targetId) : group;
  if (destination === group && code !== group.code) {
    renameMapping(state, group, code, used);
    used = occupied(state);
  }
  let editedPrimary: string | undefined;
  let focus = null;
  if (positions.length) {
    const resolved = resolveCoverage(state, positions, group.type);
    if ('issue' in resolved) return resolved;
    for (const [index, [, row]] of resolved.entries()) {
      if (originals[index]!.original === group.primary && editedPrimary == null) editedPrimary = row.original;
    }
    moveMembers(state, resolved, destination, used);
    const [doc, row] = resolved.at(-1)!;
    focus = occurrence(doc, row);
  }
  if (destination !== group && choice === 'whole') {
    moveMembers(state, [...members(state, group.id)], destination, used, true);
  } else if (destination !== group && choice === 'selected' && !positions.length) {
    const checked = new Set(rebind.map(positionKey));
    moveMembers(state, sourceRows.filter(([doc, row]) => checked.has(keyOf(doc.id, row.id))), destination, used, true);
  }
  let primary = destination === group ? change.primary : undefined;
  if (!primary && editedPrimary && destination === group &&
    ![...members(state, group.id)].some(([, row]) => row.original === group.primary)) primary = editedPrimary;
  return {changed: true, groupId: destination.id, focus, primaries: primary ? {[group.id]: {original: primary}} : {}};
}

function renameMapping(state: Workspace, group: Group, code: string, used: Set<string>) {
  if (code === group.code) return {};
  const affected = [...members(state, group.id)];
  const oldCodes = new Set(affected.map(([, row]) => row.replacement));
  const literals = new Set(state.materials.flatMap(doc => literalCodes(doc.text)));
  const current = new Set([...oldCodes].filter(value => !literals.has(value)));
  const replacements = new Map([...oldCodes].map(old => [old, old === group.code
    ? code : code.slice(0, -1) + slice(old, length(group.code) - 1)]));
  if (used.has(code) || [...replacements.values()].some(value => used.has(value) && !current.has(value))) {
    throw new Error('这个代号或其别称代号已在使用，请另选代号。');
  }
  for (const [, row] of affected) updateCode(row, replacements.get(row.replacement)!);
  group.code = code;
  return {changed: true};
}

function apply(state: Workspace, change: Change, newId: NewId, cover: boolean): AdjustmentResult {
  const op = change.mode;
  let group = change.groupId ? findGroup(state, change.groupId) : undefined;
  const used = occupied(state);
  if (op === 'editMapping') return editMapping(state, group!, change, used);
  if (op === 'rename') return renameMapping(state, group!, displayCode(change.code!), used);
  if (op === 'primary') return {changed: true, primaries: {[group!.id]: change.term!}};
  if (op === 'merge' || op === 'delete') {
    const affected = [...members(state, group!.id)];
    if (op === 'merge') {
      const target = findGroup(state, change.targetId);
      if (target === group || !compatible(group!.type, target.type) || (!nameKinds.has(group!.type) && group!.type !== 'address')) {
        throw new Error('请选择同类的其他人物、机构或地址映射。');
      }
      moveMembers(state, affected, target, used, true);
    } else {
      for (const [, row] of affected) manual(row, null, '', change.keep ? 'keep' : 'review');
    }
    return {changed: true};
  }

  const positions = change.positions ?? [];
  if (!positions.length) throw new Error('请先选择要处理的位置。');
  const kind = change.type;
  if (kind != null && !Object.hasOwn(labels, kind)) throw new Error('请选择有效的脱敏类别。');
  if (op === 'create' && !kind) throw new Error('请选择脱敏类别。');
  const targetKind = kind || group?.type;
  let resolved: Member[];
  if (cover && ['create', 'bind', 'range'].includes(op)) {
    const result = resolveCoverage(state, positions, targetKind);
    if ('issue' in result) return result;
    resolved = result;
  } else {
    const identifiers: [Material, number][] = [];
    for (const position of positions) {
      const result = resolvePosition(state, position, targetKind);
      if ('issue' in result) return result;
      identifiers.push([result[0], result[1].id]);
    }
    resolved = identifiers.map(([doc, id]) => [doc, requireDecisions(doc).find(row => row.id === id)!]);
  }
  if (op === 'create') {
    const raw = resolved[0][1].original;
    const code = trim(change.code ?? '') ? displayCode(change.code!) : allocateCode(kind!, raw, used);
    if (used.has(code)) {
      const issue = literalIssue(state, new Set([code]));
      if (issue) return issue;
      const occupants = codeOccupants(state, new Set([code]));
      const ownerIds = new Set(occupants.map(item => item.groupId));
      const owners = Object.values(state.groups).filter(candidate => ownerIds.has(candidate.id));
      const eligible = owners.filter(candidate => candidate.code === code && compatible(kind!, candidate.type) &&
        (nameKinds.has(candidate.type) || candidate.type === 'address' ||
          resolved.every(([, row]) => sameCompleteValue(candidate.type, row.original, candidate.primary))));
      group = eligible.find(candidate => change.resolution?.mode === 'selected' && change.resolution.targetId === candidate.id);
      if (!group) return {issue: {message: '这个代号已被其他映射使用。', merge: {reason: 'code', canRetain: false,
        codeChoices: false, groups: owners.map(candidate => candidate.id), occupants,
        options: eligible.map(candidate => ({groupId: candidate.id, whole: false, selected: true}))}}};
    } else {
      group = newGroup(state, kind!, raw, code, newId);
    }
    used.add(group.code);
  }
  for (const [, row] of resolved) {
    if (op === 'create' || op === 'bind' || op === 'range') {
      if (op === 'bind') {
        const groupKind = group!.type;
        if (row.group && !compatible(row.type, groupKind)) throw new Error(`「${row.original}」与目标映射类别不同。`);
        if (!nameKinds.has(groupKind) && groupKind !== 'address' && row.group !== group!.id) {
          const matches = normalized(groupKind, row.original) === normalized(groupKind, group!.primary) &&
            (!NUMBER_KINDS.has(groupKind) || completeNumber(groupKind, row.original, row.reason));
          if (!matches) throw new Error('号码和其他标识只能绑定实际相同的完整值。');
        }
      }
      const label = op !== 'create' ? row.aliasType ?? '' : '';
      if (kind && !compatible(row.type, kind)) delete row.match;
      if (kind) row.type = kind;
      const code = aliasCode(state, group!, row.original, label, used);
      manual(row, group!, code, 'replace', label);
    } else {
      manual(row, null, '', op === 'keep' ? 'keep' : 'review');
    }
  }
  const [doc, last] = resolved.at(-1)!;
  return {changed: true, focus: occurrence(doc, last), primaries: change.primaries ?? {}};
}

function applyReview(state: Workspace, change: Change, newId: NewId, cover: boolean) {
  const result = apply(state, change, newId, cover);
  if (!('issue' in result) && result.changed) {
    settleAliases(state, newId);
    repairGroups(state, result.primaries ?? {});
    delete result.primaries;
  }
  return result;
}

const maskedRanges = (rows: Row[]): Span[] => rows.filter(row => row.action !== 'keep').map(row => [row.start, row.end]);

function restoredRanges(before: Span[], after: Span[]) {
  const restored: Span[] = [];
  let index = 0;
  for (const [start, end] of before) {
    while (index < after.length && after[index][1] <= start) index++;
    let cursor = start;
    let next = index;
    while (next < after.length && after[next][0] < end) {
      const [left, right] = after[next++];
      if (left > cursor) restored.push([cursor, left]);
      cursor = Math.max(cursor, right);
    }
    if (cursor < end) restored.push([cursor, end]);
  }
  return restored;
}

function outputOffset(items: MaterialItem[], offset: number) {
  const row = items.findLast(item => item.end <= offset);
  return row ? offset + row.output_end - row.end : offset;
}

function adjustmentImpact(doc: Material, before: ReturnType<typeof viewMaterial>, after: ReturnType<typeof viewMaterial>) {
  const old = new Map(before.items.map(row => [keyOf(row.start, row.end), row]));
  const next = new Map(after.items.map(row => [keyOf(row.start, row.end), row]));
  const intervals: Span[] = [];
  const ranges = [...new Set([...old.keys(), ...next.keys()])].flatMap(key => {
    const a = old.get(key);
    const b = next.get(key);
    if (a?.action === b?.action && a?.replacement === b?.replacement && a?.group === b?.group) return [];
    const row = a ?? b!;
    return [[row.start, row.end] as Span];
  }).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  for (const [start, end] of ranges) {
    const previous = intervals.at(-1);
    if (previous && start < previous[1]) previous[1] = Math.max(end, previous[1]);
    else intervals.push([start, end]);
  }

  const restored = restoredRanges(maskedRanges(before.items), maskedRanges(after.items));
  const changes = intervals.map(([start, end]) => {
    let cursor = outputOffset(after.items, start);
    const newEnd = outputOffset(after.items, end);
    const oldStart = outputOffset(before.items, start);
    const oldEnd = outputOffset(before.items, end);
    const parts: {text: string; restored?: true}[] = [];
    for (const [a, b] of restored) {
      if (start > a || b > end) continue;
      const left = outputOffset(after.items, a);
      const right = outputOffset(after.items, b);
      if (left > cursor) parts.push({text: slice(after.output, cursor, left)});
      parts.push({text: slice(after.output, left, right), restored: true});
      cursor = right;
    }
    if (cursor < newEnd) parts.push({text: slice(after.output, cursor, newEnd)});
    return {start, end, line: lineNumber(doc.text, start), before: slice(before.output, oldStart, oldEnd), after: parts};
  });
  return {materialId: doc.id, title: doc.title, changes, removedCount: [...old.keys()].filter(key => !next.has(key)).length,
    restoredCount: restored.length};
}

function previewAdjustment(state: Workspace, change: Change, newId: NewId) {
  const trial = {...state, groups: structuredClone(state.groups),
    materials: state.materials.map(doc => ({...doc, decisions: structuredClone(doc.decisions)}))};
  const result = applyReview(trial, change, newId, true);
  if ('issue' in result) return result;
  const materials = state.materials.flatMap((doc, index) => {
    const proposed = trial.materials[index];
    if (JSON.stringify(doc.decisions) === JSON.stringify(proposed.decisions)) return [];
    const impact = adjustmentImpact(doc, viewMaterial(doc), viewMaterial(proposed));
    return impact.changes.length ? [impact] : [];
  });
  const group = findGroup(trial, result.groupId || result.focus?.group || undefined);
  return {preview: {revision: state.revision, code: group.code, materials, primary: group.primary}};
}

export async function runWorkspace(state: Workspace, request: Request, scan?: Scan,
  newId: NewId = () => crypto.randomUUID().replaceAll('-', '')) {
  // The caller owns the committed snapshot. Only a returned state may replace it.
  const op = request.op;
  if (op === 'search') return search(state, request);
  if (op === 'editSuggestions') return editSuggestions(state, request);
  if (op === 'view') return {view: workspaceView(state)};
  if (op === 'candidate') return candidate(lookupMaterial(state, request.materialId), request.start, request.end);
  if (op === 'previewAdjustment') return previewAdjustment(state, request.change, newId);
  if (op === 'suggest') return allocateCode(request.type, request.text, occupied(state));
  if (op === 'output') {
    const doc = lookupMaterial(state, request.materialId);
    if (!doc.decisions) throw new Error('当前修订尚未完成分析。');
    const result = checkedOutput(doc, request.decisionsOnly ?? false);
    if ('issues' in result) return result;
    const title = doc.title.replace(/[<>:"/\\|?*]/gu, '-');
    const paths = new Set([...(state.sourcePaths ?? []), ...state.materials.flatMap(item => item.sourcePath ? [item.sourcePath] : [])]);
    return {...result, sourcePaths: [...paths].sort(), filename: `${title}_脱敏.txt`};
  }

  let result: Adjustment = {};
  if (op === 'apply') {
    const revision = request.expectedRevision;
    if (revision != null && revision !== state.revision) {
      return {issue: {message: '材料已更新，请查看最新的影响预览。', stalePreview: true}};
    }
    const before = {groups: structuredClone(state.groups),
      rows: Object.fromEntries(state.materials.map(doc => [doc.id, structuredClone(doc.decisions)]))};
    const change = applyReview(state, request.change, newId, revision != null);
    if ('issue' in change) return change;
    result = change;
    if (result.changed) {
      state.undo = before;
      state.revision++;
    }
  } else if (op === 'undo') {
    if (state.undo) {
      state.groups = state.undo.groups;
      for (const doc of state.materials) if (Object.hasOwn(state.undo.rows, doc.id)) doc.decisions = state.undo.rows[doc.id];
      state.undo = null;
      state.revision++;
    }
  } else if (op === 'add') {
    addMaterial(state, request);
    state.revision++;
  } else if (op === 'renameMaterial' || op === 'editMaterial' || op === 'deleteMaterial') {
    const doc = lookupMaterial(state, request.materialId);
    if (op === 'renameMaterial') {
      const title = trim(request.title);
      if (!title) throw new Error('请输入材料名称。');
      doc.title = title;
    } else if (op === 'editMaterial') {
      const text = normalizedText(request.text);
      if (text !== doc.text) {
        if (doc.decisions) {
          doc.previousOutput = viewMaterial(doc).output;
          doc.previousReview = {text: doc.text, decisions: doc.decisions, relations: doc.relations,
            groups: Object.fromEntries(doc.decisions.flatMap(row => row.group ? [[row.group, {...state.groups[row.group]}]] : []))};
        }
        Object.assign(doc, {text, decisions: null, relations: [], revision: (doc.revision ?? 1) + 1});
        state.undo = null;
        repairGroups(state, {});
      }
    } else {
      const index = state.materials.indexOf(doc);
      state.materials.splice(index, 1);
      if (state.activeId === doc.id) state.activeId = state.materials[Math.min(index, state.materials.length - 1)]?.id ?? null;
      state.undo = null;
      settleAliases(state, newId);
      repairGroups(state, {});
    }
    state.revision++;
  } else if (op === 'open' || op === 'scan' || op === 'markExported') {
    const doc = lookupMaterial(state, request.materialId);
    if (op === 'open') state.activeId = doc.id;
    else if (op === 'scan') {
      const revision = doc.revision ?? 1;
      if ((request.revision ?? revision) !== revision) throw new Error('材料已更新，请分析最新修订。');
      await scanMaterial(state, doc, newId, scan);
      delete doc.previousOutput;
      delete doc.previousReview;
      state.revision++;
    } else if (op === 'markExported') doc.exported = request.text;
  } else throw new Error('未知操作。');
  return {...result, state, view: workspaceView(state)};
}
