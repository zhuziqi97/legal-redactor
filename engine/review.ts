import { readFields } from './fields.js';
import { checkSourceValues, labels, render, reviewDecisions, sourceValues, validCode, type Action } from './pipeline.js';
import { length, slice, trim } from './text.js';
import type { Issue, Material, Row } from './workspace-types.js';

export type MaterialItem = Row & {output_start: number; output_end: number};
export function requireDecisions(doc: Material, message = '请先识别这份材料。') {
  if (!doc.decisions) throw new Error(message);
  return doc.decisions;
}

export function viewMaterial(doc: Material) {
  const items: MaterialItem[] = [];
  if (!doc.decisions) return {output: '', items, evidence: []};
  const {rows, links: evidence} = reviewDecisions(doc.text, doc.relations, doc.decisions);
  const {output, replacements} = render(doc.text, rows, true);
  const originals = new Map(doc.decisions.map(row => [row.id, row]));
  const replaced = new Map(replacements.map(row => [row.id, row]));
  let delta = 0;
  for (const row of rows.sort((a, b) => a.start - b.start)) {
    const output_start = row.start + delta;
    const output_end = row.action === 'replace' ? replaced.get(row.id)!.output_end
      : row.action === 'review' ? output_start + 4 : row.end + delta;
    const raw = originals.get(row.id)!;
    const group = row.action === 'replace' && row.replacement === raw.replacement ? raw.group : null;
    items.push({...row, group, output_start, output_end});
    delta = output_end - row.end;
  }
  return {output, items, evidence};
}

export function displayCode(input: string) {
  const value = trim(input);
  const code = value.startsWith('【') && value.endsWith('】') ? value : `【${value}】`;
  if (!validCode.fullmatch(code)) throw new Error('请输入有效代号（1 至 40 字）。');
  return code;
}

export function amend(doc: Material, change: {
  id?: number | null; start: number; end: number; type: string; action: Action; replacement?: string;
}, allocate?: (kind: string, value: string) => string): {decisions: Row[]; itemId: number} | {issue: Issue} {
  const decisions = requireDecisions(doc).map(row => ({...row}));
  let row = decisions.find(item => item.id === change.id);
  if (change.id != null && !row) throw new Error('找不到这处复核项，请重新选定。');
  const {start, end, type, action} = change;
  const original = slice(doc.text, start, end);
  if (!(0 <= start && start < end && end <= length(doc.text)) || !trim(original)) {
    throw new Error('请在原文中选中要处理的文字。');
  }
  const conflict = decisions.find(item => item !== row && start < item.end && item.start < end);
  if (conflict) return {issue: {message: `选区与「${conflict.original}」重叠。`, itemId: conflict.id}};
  if (!Object.hasOwn(labels, type) || !['replace', 'keep'].includes(action)) throw new Error('请选择类别和处理方式。');
  let replacement = row?.replacement ?? '';
  if (action === 'replace') {
    const value = trim(change.replacement ?? '');
    replacement = value ? displayCode(value) : allocate!(type, original);
  }
  if (!row) {
    const id = decisions.reduce((max, item) => Math.max(max, item.id), 0) + 1;
    row = {id, object: null, name: null, group: null, start, end, original, type, reason: '人工订正', action, replacement};
    decisions.push(row);
  } else {
    if (start !== row.start || end !== row.end || type !== row.type) {
      delete row.definitions;
      delete row.alias_display;
      Object.assign(row, {object: null, name: null, group: null});
    }
    if (replacement !== row.replacement) row.group = null;
    Object.assign(row, {start, end, original, type, reason: '人工订正', action, replacement});
  }
  return {decisions, itemId: row.id};
}

export function checkedOutput(doc: Material, decisionsOnly: boolean): {issues: Issue[]} | {decisions: Row[]} | {output: string} {
  const input = requireDecisions(doc, '请先识别当前材料。');
  const {rows} = reviewDecisions(doc.text, doc.relations, input);
  const pending = rows.filter(row => row.action === 'review').map(row => ({
    message: '请决定是否替换或保留这一处。', itemId: row.id,
  }));
  if (pending.length) return {issues: pending};
  try {
    checkSourceValues(doc.text, rows, doc.sourceValues ?? sourceValues(readFields(doc.text, true)));
  } catch (error) {
    const message = (error as Error).message;
    const match = /原文 (\d+)–(\d+)/u.exec(message);
    return {issues: [match ? {
      message: message.slice(match.index + match[0].length).replace(/^ 的/u, ''),
      start: Number(match[1]), end: Number(match[2]),
    } : {message}]};
  }
  return decisionsOnly ? {decisions: rows} : {output: render(doc.text, rows).output};
}
