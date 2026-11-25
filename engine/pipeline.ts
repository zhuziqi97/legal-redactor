import { answerNames, choose, definitions, identityEvidence, namesInStatements, type Relation } from './context.js';
import { PERSON_ALIAS } from './context-rules.js';
import { displayBase } from './display.js';
import { NUMBER_KINDS, PERSON_VALUE, TITLE } from './field-rules.js';
import { hit, languageRules, readFields, streetAddresses, typicalName, type Hit, type Passage } from './fields.js';
import { locationBoundaries } from './locations.js';
import { idChecksum, translateWidth } from './numbers.js';
import { hasSurname } from './suspects.js';
import { bisect, char, escape, keyOf, length, rule, slice, trim } from './text.js';

export const labels: Record<string, string> = {
  person: '人员', organization: '机构', address: '地址', id_card: '证件',
  mobile: '电话', bank_account: '账号', tail: '尾号', case_number: '案号',
  number: '号码', social: '社交账号', nickname: '昵称', email: '邮箱',
};

export type Action = 'replace' | 'keep' | 'review';
export type Decision = {
  start: number; end: number; original: string; type: string; reason: string; object: string | null;
  action: Action; replacement: string; name: string | null; definitions?: number[]; alias_display?: string;
};
export type Registered = {
  kind: string; value: string; identity?: string | null; replacement: string; scope?: string | null;
};
export type Registry = Record<string, Registered>;
export type Scan = (text: string, free: Passage[], known: Hit[]) => Promise<Hit[]> | Hit[];
export type Plan = [rows: Decision[], objects: Registry, relations: Relation[]];

const personAction = rule('表示|同意|拒绝|承认|否认|签字|签署|随后|称|说');
const bodyPart = rule('(?:头|面|颈|肩|胸|背|腹|腿)部|手臂');
const numberSeparators = rule('[\\s()（）－—-]');
const legacyId = rule('\\d{15}');
const completeMobile = rule('\\+\\d{8,15}|1[3-9]\\d{9}|0\\d{9,11}|[48]00\\d{7}');
const completeAccount = rule('\\d{8,22}');
export const validCode = rule('【[^【】\\r\\n]{1,40}】');
const namedKinds = new Set(['person', 'organization', 'address']);

export function normalized(kind: string, value: string) {
  if (kind === 'address') {
    return translateWidth(value).replaceAll('（', '(').replaceAll('）', ')')
      .replace(/(?<=市|省|县|区)[，,](?=[\u3400-\u9fff])/g, '')
      .replace(/(?<=[\u3400-\u9fff])[ \t　]+|[ \t　]+(?=[\u3400-\u9fff])/g, '');
  }
  if (NUMBER_KINDS.has(kind)) {
    const digits = numberSeparators.replace(translateWidth(value), '').toUpperCase();
    return kind === 'mobile' && digits.startsWith('00') && length(digits) > 6 ? '+' + slice(digits, 2) : digits;
  }
  if (kind === 'case_number') {
    return translateWidth(value).replaceAll('（', '(').replaceAll('）', ')').replaceAll(' ', '');
  }
  return value;
}

export function completeNumber(kind: string, raw: string, reason: string) {
  if (kind === 'tail' || kind === 'number' || reason === '分机') return false;
  const value = normalized(kind, raw);
  if (kind === 'id_card') return !!legacyId.fullmatch(value) || idChecksum(value);
  if (kind === 'mobile') return !!completeMobile.fullmatch(value);
  return !!completeAccount.fullmatch(value);
}

class Objects {
  readonly records: Registry;
  readonly names: Map<string, string>;
  private readonly used: Set<string>;
  private readonly keys = new Map<string, string>();
  private nextId: number;

  constructor(registry: Registry, displays: Record<string, string>, private text: string, private document: string) {
    this.records = Object.fromEntries(Object.entries(registry).map(([key, item]) => [key, {...item}]));
    this.names = new Map(Object.entries(displays));
    this.nextId = Math.max(0, ...Object.keys(this.records).map(Number)) + 1;
    for (const [key, item] of Object.entries(this.records)) {
      if (item.kind === 'person' && !this.names.has(item.value)) this.names.set(item.value, item.replacement);
      const lookup = keyOf(item.kind, normalized(item.kind, item.value), item.identity ?? null, item.scope ?? null);
      if (!this.keys.has(lookup)) this.keys.set(lookup, key);
    }
    this.used = new Set([...Object.values(this.records).map(item => item.replacement), ...this.names.values()]);
  }

  allocate(kind: string, value: string) {
    const [base, initial] = displayBase(kind, value, labels[kind]);
    let number = initial;
    while (true) {
      const display = `【${base}${number || ''}】`;
      if (!this.used.has(display) && !this.text.includes(display)) {
        this.used.add(display);
        return display;
      }
      number++;
    }
  }

  name(value: string) {
    if (!this.names.has(value)) this.names.set(value, this.allocate('person', value));
    return this.names.get(value)!;
  }

  get(kind: string, raw: string, identity: string | null = null, section: number | string | null = null) {
    const value = normalized(kind, raw);
    const scope = section === null ? null : section === 0 ? this.document : `${this.document}/${section}`;
    const key = keyOf(kind, value, identity, scope);
    if (!this.keys.has(key)) {
      const id = String(this.nextId++);
      this.records[id] = {kind, value, identity, replacement: kind === 'person' ? this.name(value) : this.allocate(kind, value), scope};
      this.keys.set(key, id);
    }
    return this.keys.get(key)!;
  }
}

export async function buildPlan(text: string, registry: Registry = {}, scan?: Scan, doc = '',
  displays: Record<string, string> = {}): Promise<Plan> {
  const layout = readFields(text);
  const tentative = scan ? layout.hits.filter(item => item.needs_context) : [];
  const rules = layout.hits.filter(item => item.kind !== 'signature' && (!item.needs_context || !scan));
  rules.push(...streetAddresses(text), ...answerNames(text, layout));
  const narrative = [...text];
  for (const [message, [start]] of layout.speakers) narrative.fill(' ', start, message);
  let language = [...languageRules(narrative.join('')), ...namesInStatements(text)];
  const predicted = scan ? await scan(text, layout.free, rules) : [];
  const known = new Set(rules.filter(item => namedKinds.has(item.kind) && item.priority >= 95)
    .map(item => keyOf(item.kind, slice(text, item.start, item.end))));
  for (const item of Object.values(registry)) {
    if (namedKinds.has(item.kind)) known.add(keyOf(item.kind, item.value));
  }
  for (const name of Object.keys(displays)) known.add(keyOf('person', name));
  if (tentative.length) {
    const fieldSpans = new Set(tentative.map(item => keyOf(item.start, item.end)));
    language = language.filter(item => !fieldSpans.has(keyOf(item.start, item.end)) ||
      !['role_anchored', 'labeled_person'].includes(item.reason));
    const recognized = new Set(predicted.map(item => keyOf(item.start, item.end, item.kind)));
    const confirmed = tentative.filter(item => recognized.has(keyOf(item.start, item.end, item.kind)) ||
      known.has(keyOf(item.kind, slice(text, item.start, item.end))));
    rules.push(...confirmed);
    for (const item of confirmed) known.add(keyOf(item.kind, slice(text, item.start, item.end)));
  }

  const boundaries = locationBoundaries(text, predicted, language, rules);
  const personEnds = new Map(predicted.filter(item => item.kind === 'person').map(item => [item.start, item.end]));
  for (const slot of layout.hits) {
    if (slot.kind !== 'signature') continue;
    const raw = slice(text, slot.start, slot.end);
    const stop = personEnds.get(slot.start) ?? 0;
    if (known.has(keyOf('person', raw))) rules.push(hit(slot.start, slot.end, 'person', '签名栏已登记姓名', 100));
    else if (slot.end < stop && stop <= (slot.value_limit || slot.end)) {
      rules.push(hit(slot.start, slot.end, 'person', '模型人名截至签署动作', 61));
    } else if (!scan && typicalName(raw)) {
      rules.push(hit(slot.start, slot.end, 'person', '纯规则签名', 58));
    }
  }
  language = language.map(item => {
    const stop = personEnds.get(item.start);
    return item.kind === 'person' && stop && stop < item.end && ['说', '称', '表示'].includes(slice(text, stop, item.end))
      ? hit(item.start, stop, item.kind, item.reason, item.priority) : item;
  });

  const candidates = [...rules, ...language, ...predicted, ...boundaries];
  const hits = choose(candidates);
  const {targets, scope, extra, links} = definitions(text, hits, layout);
  const people = new Map<string, number>();
  const knownPeople = new Set<string>();
  const organizations = new Map<string, Set<number>>();
  for (const item of hits) {
    const raw = slice(text, item.start, item.end);
    if (item.kind === 'person') {
      people.set(raw, (people.get(raw) ?? 0) + 1);
      if (item.priority >= 65) knownPeople.add(raw);
    } else if (item.kind === 'organization' && item.priority >= 65) {
      if (!organizations.has(raw)) organizations.set(raw, new Set());
      organizations.get(raw)!.add(scope(item.start));
    }
  }
  for (const [raw, count] of people) {
    if (count >= 2 && hasSurname(raw)) knownPeople.add(raw);
  }
  const names = [...new Set([...knownPeople, ...organizations.keys()])]
    .sort((a, b) => length(b) - length(a) || (a < b ? -1 : a > b ? 1 : 0));
  const positions = hits.map(item => item.start);
  if (names.length) {
    for (const match of rule(names.map(escape).join('|')).finditer(text)) {
      const [start, end] = match.span();
      const current = hits[bisect(positions, start, true) - 1];
      const raw = match.value;
      if (organizations.get(raw)?.has(scope(start))) {
        extra.push(hit(start, end, 'organization', '全文全称', 59));
      } else if (knownPeople.has(raw) &&
        (((start === 0 || '\r\n。！？；，：:'.includes(char(text, start - 1))) && personAction.match(text, end)) ||
         bodyPart.match(text, end) ||
         [...PERSON_ALIAS.finditer(text, Math.max(0, start - 24), start)].some(item => item.end() === start))) {
        extra.push(hit(start, end, 'person', '全文姓名', 64));
      } else if (people.has(raw) && current?.reason === 'Otter' && current.kind === 'person' &&
        current.start <= start && end <= current.end && (start !== current.start || end !== current.end) &&
        ['', '的', '吗', '呢'].includes(slice(text, end, current.end)) &&
        ['', '由', '让', '将', '给'].includes(slice(text, current.start, start))) {
        extra.push(hit(start, end, 'person', '全文姓名边界', 61));
      }
    }
  }

  const chosen = choose([...candidates, ...extra]);
  const evidence = identityEvidence(text, chosen);
  const objects = new Objects(registry, displays, text, doc);
  const direct = new Map(links.map(link => [keyOf(link.start, link.end), link]));
  const rows: Decision[] = [];
  for (const item of chosen) {
    if (item.kind === 'keep') continue;
    const {start, end, reason} = item;
    const raw = slice(text, start, end);
    const key = keyOf(start, end);
    let kind = item.kind;
    let target = raw;
    const link = direct.get(key);
    if (kind === 'person' || kind === 'organization') {
      if (link && link.type !== '聊天昵称') target = link.name!;
      else if (reason === '全文称呼') target = targets.get(key)![0];
    }
    if (kind === 'nickname' && ['发言者', '通话方'].includes(reason) && PERSON_VALUE.fullmatch(raw) &&
        (objects.names.has(raw) || people.has(raw))) kind = 'person';
    let object: string | null;
    let replacement: string;
    if (kind === 'person') {
      replacement = objects.name(target);
      const identity = evidence.get(key);
      object = identity ? objects.get(kind, target, identity) : null;
    } else {
      let section: string | number | null = kind === 'nickname' ? scope(start) : null;
      if (kind === 'nickname' && link) section = `${scope(start)}/${link.type}/${link.name}`;
      if (NUMBER_KINDS.has(kind) && !completeNumber(kind, raw, reason)) section = `${scope(start)}@${start}`;
      object = objects.get(kind, target, null, section);
      replacement = objects.records[object].replacement;
      if (kind === 'nickname' && link && ['聊天昵称', '曾用名'].includes(link.type) && replacement.startsWith('【昵称')) {
        const person = objects.name(link.name!).slice(1, -1);
        const label = link.type === '聊天昵称' ? '微信昵称' : '曾用名';
        replacement = `【${person}-${label}${replacement.slice(3, -1)}】`;
        objects.records[object].replacement = replacement;
      }
    }
    const row: Decision = {start, end, original: raw, type: kind, reason, object,
      action: item.priority === 54 ? 'review' : 'replace', replacement, name: kind === 'person' ? target : null};
    if (reason === '全文称呼' || link) {
      row.definitions = targets.get(key)?.[1] ?? [start];
      row.alias_display = replacement;
    }
    rows.push(row);
  }
  const relations = [...links];
  for (let i = 1; i < chosen.length; i++) {
    const who = chosen[i - 1];
    const card = chosen[i];
    if (card.kind === 'id_card' && evidence.has(keyOf(who.start, who.end))) {
      relations.push({type: '证件', subject_start: who.start, object_start: card.start, start: who.start, end: card.end});
    }
  }

  const used = new Set(rows.map(row => row.object));
  return [rows, Object.fromEntries(Object.entries(objects.records).filter(([key]) => used.has(key))), relations];
}

export function render<Row extends Decision>(text: string, decisions: Row[], preview = false) {
  const chunks: string[] = [];
  const replacements: Array<Row & {output_start: number; output_end: number}> = [];
  let cursor = 0;
  let output = 0;
  const end = length(text);
  for (const row of [...decisions].sort((a, b) => a.start - b.start || a.end - b.end)) {
    const {start, end: stop, action} = row;
    const original = slice(text, start, stop);
    if (cursor > start || start >= stop || stop > end || original !== row.original) {
      throw new Error(`复核区间重叠、越界或原值不符：${start}–${stop}`);
    }
    if (!['replace', 'keep', 'review'].includes(action)) throw new Error(`未知复核决定：${action}`);
    if (action === 'review' && !preview) throw new Error(`还有待核位置：${start}–${stop}。请在复核 JSON 或本地页面中处理。`);
    let value = row.replacement;
    if (action === 'replace') {
      if (!value || !validCode.fullmatch(value) || value === original) {
        throw new Error(`替换须使用有效的【代号】：${start}–${stop}`);
      }
    } else value = action === 'review' ? '【待核】' : original;
    chunks.push(slice(text, cursor, start), value);
    output += start - cursor;
    const outputEnd = output + length(value);
    if (action === 'replace') replacements.push({...row, output_start: output, output_end: outputEnd});
    cursor = stop;
    output = outputEnd;
  }
  chunks.push(slice(text, cursor));
  return {output: chunks.join(''), replacements};
}

export function reviewDecisions<Row extends Decision>(text: string, relations: Relation[], input: Row[]) {
  const rows = input.map(row => ({...row}));
  const at = new Map(rows.filter(row => row.action === 'replace').map(row => [row.start, row]));
  const links: Relation[] = [];
  const supported = new Set<number>();
  for (const link of relations) {
    const subject = at.get(link.subject_start);
    const alias = at.get(link.object_start);
    if (!subject || !alias) continue;
    if (link.type === '证件') {
      if (subject.object && alias.type === 'id_card') links.push(link);
      continue;
    }
    if (!link.name || subject.original !== link.name || alias.original !== link.value) continue;
    let consistent = subject.replacement === alias.replacement;
    if (link.type === '聊天昵称' || link.type === '曾用名') {
      const label = link.type === '聊天昵称' ? '微信昵称' : '曾用名';
      consistent = alias.replacement.startsWith(subject.replacement.slice(0, -1) + '-' + label);
    }
    if (consistent) {
      supported.add(link.start);
      links.push(link);
    }
  }
  const used = new Set(rows.map(row => row.replacement));
  const independent = new Map<string, string>();
  for (const row of rows) {
    const evidence = row.definitions;
    if (!evidence?.length || evidence.some(value => supported.has(value))) continue;
    const proposed = row.alias_display;
    delete row.definitions;
    delete row.alias_display;
    row.object = null;
    row.name = row.type === 'person' ? row.original : null;
    if (row.action !== 'replace' || row.replacement !== proposed) continue;
    if (TITLE.fullmatch(row.original)) {
      row.action = 'keep';
      row.reason = '称呼归属未确认';
      continue;
    }
    const key = keyOf(evidence, row.original);
    if (!independent.has(key)) {
      const [base, first] = displayBase(row.type, row.original, labels[row.type]);
      let index = first;
      let code = `【${base}${index || ''}】`;
      while (used.has(code) || text.includes(code)) code = `【${base}${++index}】`;
      independent.set(key, code);
      used.add(code);
    }
    row.replacement = independent.get(key)!;
    row.reason = '按出现位置独立遮盖';
  }
  return {rows, links};
}

export function checkSourceValues(text: string, rows: Decision[]) {
  const numbers = choose(readFields(text).hits).filter(item => item.priority >= 86 &&
    (NUMBER_KINDS.has(item.kind) || ['case_number', 'social', 'email'].includes(item.kind)));
  const ordered = [...rows].sort((a, b) => a.start - b.start);
  let index = 0;
  for (const value of numbers) {
    let cursor = value.start;
    while (index < ordered.length && ordered[index].end <= cursor) index++;
    let next = index;
    while (next < ordered.length && ordered[next].start < value.end) {
      if (trim(slice(text, cursor, ordered[next].start), ' \t　-－—()（）')) break;
      cursor = Math.max(cursor, ordered[next++].end);
    }
    if (cursor < value.end && trim(slice(text, cursor, value.end), ' \t　-－—()（）')) {
      throw new Error(`原文 ${value.start}–${value.end} 的${labels[value.kind]}仍有未处理部分。请补选范围或明确保留。`);
    }
  }
}
