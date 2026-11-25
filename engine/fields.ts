import * as R from './field-rules.js';
import { _BANK_PREFIX, _EMAIL, _LABELED_USCC, _USCC } from './number-rules.js';
import { structuralCandidates, luhn, translateWidth } from './numbers.js';
import { hasSurname, languageSuspects } from './suspects.js';
import { COMPOUND_SURNAMES, _ORG_SUFFIX_RE } from './suspect-rules.js';
import { ascii, bisect, char, digits, endsAny, indexOf, keyOf, length, rule, slice, startsAny, trim, type Span } from './text.js';

export type Hit = {
  start: number; end: number; kind: string; reason: string; priority: number; value_limit: number | null; needs_context: boolean;
};
export type Passage = { start: number; end: number; context: string };
export type Layout = { hits: Hit[]; free: Passage[]; sections: number[]; answers: [Span, Span][]; speakers: Map<number, Span>;
  courtReplies: Passage[] };
export const hit = (start: number, end: number, kind: string, reason: string, priority: number,
    value_limit: number | null = null, needs_context = false): Hit => ({start, end, kind, reason, priority, value_limit, needs_context});

export function typicalName(value: string) {
  return ascii(value) || value.includes('·') || value.includes('・')
    || hasSurname(value) && (length(value) <= 3 || startsAny(value, COMPOUND_SURNAMES));
}

const dateTime = rule(R.DATE_TIME);
const direction = rule('借方?|贷方?|进账|入账|出账|收入|支出');
const shortDefinition = rule('[（(]\\s*(?:以下)?简称');
const organizationEnding = rule('税务所|大队|支队|小学|中学');
export const genericOrganization = rule('医院|法院|人民法院|检察院|人民检察院|合议庭|(?:保险|物业|快递|物流|担保)?公司|'
  + '(?:社区|当地|定点|公立|私立)医院|商业银行|银行|大学|学校|小学|中学');
export const referenceLead = rule('^(?:该(?:家|所|名)?|[这那](?:家|所|个|位)|[一各](?:家|所)|某(?:家|所)?|对方(?:的)?|本(?=院|校|公司))');
const nameClause = rule('^(?:请[向给]|我(?:把|让|送|陪)|由)|让我|让他|让她|如果|所在的?|判决|是在|是由|的是');
const organizationToken = rule('[\\u3400-\\u9fffA-Za-z0-9（）()·&]+');
export function organizationValue(value: string) {
  if (!organizationToken.fullmatch(value) || genericOrganization.fullmatch(value) || referenceLead.match(value)) return false;
  const suffix = R.ORG_END.search(value)
    ?? [..._ORG_SUFFIX_RE.finditer(value), ...organizationEnding.finditer(value)].find(part => part.end() === length(value));
  return !!suffix && suffix.start() > 0 && !nameClause.search(slice(value, 0, suffix.start()));
}
const signatureRole = rule(R.SIGN_ROLE);
const areaSeparators = rule('[、,， \\t　]');
const bareDigits = rule('\\D');
const units = rule('(?:年|月|日|时|分(?!机)|秒|人|次|个|件|份|笔|页|台|元|万|%)');
const completeNumbers: Record<string, ReturnType<typeof rule>> = {
  mobile: rule('1[3-9]\\d{9}|0\\d{9,11}'), id_card: rule('\\d{17}[0-9Xx]|\\d{15}'), bank_account: rule('\\d{8,22}'), tail: rule('\\d{4}'),
};
const mobile = rule('1[3-9]\\d{9}');

function scalarField(text: string, a: number, b: number, label: string) {
  const raw = slice(text, a, b);
  let value = trim(raw, ' \t\r\n　|｜');
  if (R.EMPTY.has(value)) return undefined;
  const start = a + indexOf(raw, value);
  let end = start + length(value);
  let kind = R.FIELD_TYPES[label] ?? 'nickname';
  if (kind === 'keep') {
    const boundary = (R.REFERENCE_IDS.has(label) ? R.DEVICE_VALUE
      : ['日期', '时间', '交易日期', '交易时间'].includes(label) ? dateTime
      : ['方向', '借贷方向'].includes(label) ? direction : R.AMOUNT_FIELD).match(value);
    return boundary ? hit(start, start + length(trim(boundary.value, undefined, 'right')), kind, label, 110) : undefined;
  }
  if (['party', 'organization', 'person'].includes(kind)) {
    const definition = shortDefinition.search(value);
    if (definition) {
      value = trim(slice(value, 0, definition.start()), undefined, 'right');
      end = start + length(value);
    }
  }
  if (kind === 'nickname' && ['发言者', '通话方'].includes(label) && (R.TITLE.fullmatch(value) || R.ROLE.fullmatch(value))) {
    return hit(start, end, 'keep', label, 100);
  }
  if (kind === 'party') kind = organizationValue(value) ? 'organization' : 'person';
  if (kind === 'person' && (R.ROLE.fullmatch(value) || length(value) === 1 || R.TITLE.fullmatch(value))) kind = 'keep';
  if (kind === 'person' && (!R.PERSON_VALUE.fullmatch(value) || R.PERSON_NOTE.test(value))) return undefined;
  const needsContext = kind === 'person' && (!['姓名', '被询问人', '被讯问人'].includes(label) || !typicalName(value))
    || kind === 'organization' && !organizationValue(value);
  return hit(start, end, kind, label, 100, null, needsContext);
}

function signatureValues(text: string, start: number, end: number, label: string) {
  const rows: Hit[] = [];
  for (const piece of R.SIGN_LIST.finditer(text, start, end)) {
    const value = trim(piece.value);
    if (R.EMPTY.has(value)) continue;
    const a = piece.start() + indexOf(piece.value, value);
    const b = a + length(value);
    if (R.SIGN_STATUS.fullmatch(value) || signatureRole.fullmatch(value)) {
      rows.push(hit(a, b, 'keep', '签署情况', 112));
      continue;
    }
    if (R.TITLE.fullmatch(value)) continue;
    const verb = R.SIGN_VERB_END.search(value);
    if (verb && !(verb.start() === 1 && verb.value === '签')) {
      const who = R.SIGN_ACTOR.fullmatch(trim(slice(value, 0, verb.start()), undefined, 'right'));
      if (who && !signatureRole.fullmatch(who.group('name')!) && !R.TITLE.fullmatch(who.group('name')!)) {
        rows.push(hit(a + who.start('name'), a + who.end('name'), 'signature', label, 0, b));
      }
      rows.push(hit(a + verb.start(), b, 'keep', '签署动作', 112));
      continue;
    }
    if (R.PERSON_VALUE.fullmatch(value)) rows.push(hit(a, b, 'signature', label, 0));
  }
  return rows;
}

export function* administrativeParts(value: string): Generator<[stem: string, suffix: string, level: number, end: number]> {
  const levels: Record<string, number> = R.LEVEL;
  let position = 0;
  let level = -1;
  for (let part = R.AREA.match(value, position); part; part = R.AREA.match(value, position)) {
    const stem = part.group(1)!;
    const suffix = part.group(2)!;
    if (levels[suffix] <= level) break;
    position = part.end();
    level = levels[suffix];
    yield [stem, suffix, level, position];
  }
}

function continuesArea(first: string, second: string) {
  const compact = areaSeparators.replace(first, '');
  const previous = [...administrativeParts(compact)].at(-1);
  if (!previous || previous[3] !== length(compact)) return false;
  const following = administrativeParts(second).next().value;
  return following ? previous[2] < following[2] : !!(R.ADDRESS_CONTINUATION.match(second) || R.PREMISE.match(second) || R.ADDRESS_DETAIL.fullmatch(second));
}

export function deliveryEnd(text: string, start: number, limit: number) {
  const boundary = R.ADDRESS_BREAK.search(text, start, limit);
  const stop = boundary ? boundary.start() : limit;
  let end = start;
  while (end < stop) {
    let at = end;
    while (at < stop && ' \t　'.includes(char(text, at))) at++;
    let part = R.BUILDING.match(text, at, stop) || R.PREMISE.match(text, at, stop) || R.NAMED_BUILDING.match(text, at, stop);
    if (!part && endsAny(slice(text, Math.max(0, end - 2), end), ['号楼', '座', '栋', '幢', '单元', '层', '楼'])) {
      part = R.ROOM_AFTER_BUILDING.match(text, at, stop);
    }
    if (!part) break;
    end = part.end();
  }
  return end;
}

const namedSite = rule('[\\u3400-\\u9fffA-Za-z0-9]{1,16}?(?:交易市场|市场|大楼|停车场)');
const siteDetail = rule('停车场|停车库|车库');
const villageNumber = rule('[\\u3400-\\u9fff]{0,7}\\d+(?:[-－]\\d+)?号(?!楼)');
const placeJoin = rule('的(?=(?:\\d|[一二两三四五六七八九十])+(?:楼|层|栋|单元|室))');
const placeBreak = rule('^(?:的|由|向|对|从|与|其|他们|我们|村里|家中|位于|曾在|用手|使用|人民政府)');
export function addressComponentEnd(text: string, start: number, limit: number, level = -1) {
  let detailStart = start;
  for (const [stem, , depth, end] of administrativeParts(slice(text, start, limit))) {
    if (depth <= level || placeBreak.match(stem) || /的|由|向|其|曾在|搬到|走到/u.test(stem)) break;
    detailStart = start + end;
    level = depth;
  }
  let end = detailStart;
  if (!placeBreak.match(slice(text, end, limit))) {
    const road = R.ROAD_VALUE.match(text, end, limit);
    const site = R.PREMISE.match(text, end, limit) ?? namedSite.match(text, end, limit);
    const door = level === R.LEVEL['村'] ? villageNumber.match(text, end, limit) : undefined;
    const component = road ?? site ?? door;
    if (component && !/的|由|向|其/u.test(component.value)) {
      end = component.end();
      if (component === site) {
        const building = namedSite.match(text, end, limit);
        if (building?.value.endsWith('大楼')) end = building.end();
      }
    }
  }
  const join = end > start || level >= 0 ? placeJoin.match(text, end, limit) : undefined;
  const detail = deliveryEnd(text, join?.end() ?? end, limit);
  if (!join || detail > join.end()) end = detail;
  return (end > detailStart || detailStart > start ? siteDetail.match(text, end, limit)?.end() : undefined) ?? end;
}

function* addressParts(text: string, start: number, end: number): Generator<[annotation: boolean, start: number, end: number]> {
  let depth = 0;
  let cursor = start;
  let opened = start;
  for (const part of R.ADDRESS_PUNCT.finditer(text, start, end)) {
    if ('(（'.includes(part.value)) {
      if (!depth) { yield [false, cursor, part.start()]; opened = part.start(); }
      depth++;
    } else if (')）'.includes(part.value) && depth) {
      depth--;
      if (!depth) { yield [true, opened, part.end()]; cursor = part.end(); }
    } else if (!depth) {
      yield [false, cursor, part.start()];
      cursor = part.end();
    }
  }
  yield [false, depth ? opened + 1 : cursor, end];
}

function addressValues(text: string, start: number, end: number, label: string, insideNote = false): Hit[] {
  const rows: Hit[] = [];
  for (const [annotation, a, b] of addressParts(text, start, end)) {
    const last = rows.at(-1);
    if (annotation) {
      if (last?.kind === 'address' && !trim(slice(text, last.end, a)) && R.ADDRESS_DETAIL.fullmatch(trim(slice(text, a + 1, b - 1)))) {
        rows[rows.length - 1] = hit(last.start, b, 'address', label, 100);
      } else rows.push(...addressValues(text, a + 1, b - 1, label, true));
      continue;
    }
    const piece = slice(text, a, b);
    const value = trim(piece);
    let lo = a + indexOf(piece, value);
    let hi = lo + length(value);
    if (R.ADDRESS_STATUS.fullmatch(value)) { rows.push(hit(lo, hi, 'keep', '住址情况', 112)); continue; }
    if (R.EMPTY.has(value)) continue;
    if ('从由'.includes(char(text, lo)) && R.ROAD_VALUE.match(text, lo + 1, hi)) lo++;
    const route = R.ROUTED_ADDRESS.match(text, lo, hi);
    if (route) lo = route.end();
    let needsContext = false;
    const road = R.ROAD_VALUE.match(text, lo, hi);
    const site = road ? undefined : R.PREMISE.match(text, lo, hi);
    if (road || site) hi = deliveryEnd(text, (road ?? site)!.end(), hi);
    else if (!(R.ADDRESS_DETAIL.fullmatch(slice(text, lo, hi)) || (!insideNote && a === start) || route || R.ADDRESS_CONTINUATION.fullmatch(slice(text, lo, hi)))) continue;
    else {
      const stop = R.ADDRESS_BREAK.search(text, lo, hi);
      if (stop) hi = stop.start();
      needsContext = !(R.ADDRESS_DETAIL.fullmatch(slice(text, lo, hi)) || R.ADDRESS_CONTINUATION.fullmatch(slice(text, lo, hi)));
    }
    const valueLimit = road && hi < b ? b : null;
    if (last?.kind === 'address' && !route && !insideNote && !trim(slice(text, last.end, lo), '，, \t　')
        && continuesArea(slice(text, last.start, last.end), slice(text, lo, hi))) {
      rows[rows.length - 1] = hit(last.start, hi, 'address', label, 100, valueLimit);
    } else if (hi > lo) rows.push(hit(lo, hi, 'address', label, 100, valueLimit, needsContext));
  }
  return rows;
}

const groups = rule('[^\\s]+');
const spaced = rule('[\\s-]');
function numberParts(text: string, start: number, end: number, kind: string): Span[] {
  const value = slice(text, start, end);
  const matches = [...groups.finditer(value)];
  const complete = completeNumbers[kind] ?? completeNumbers.tail;
  if (matches.length > 1 && matches.every(match => complete.fullmatch(match.value))) {
    return matches.map(match => [start + match.start(), start + match.end()]);
  }
  if (kind !== 'mobile' || matches.length < 2) return [[start, end]];
  const parts: Span[] = [];
  let offset = 0;
  while (offset < matches.length) {
    const first = matches[offset].start();
    let next = offset;
    for (let i = offset; i < matches.length; i++) {
      const last = matches[i].end();
      const compact = spaced.replace(slice(value, first, last), '');
      if (length(compact) > 11) return [[start, end]];
      if (mobile.fullmatch(compact)) { parts.push([start + first, start + last]); next = i + 1; break; }
    }
    if (next === offset) return [[start, end]];
    offset = next;
  }
  return parts;
}

function identifierValues(text: string, start: number, end: number, kind: string, reason: string,
                          priority: number, protectedRows: Hit[], minimumLength = 0) {
  const pattern = kind === 'case_number' ? R.CASE_VALUE : R.VALUE_PATTERNS[kind];
  const rows: Hit[] = [];
  const barriers: Span[] = [];
  if (kind !== 'case_number') {
    const starts = protectedRows.map(row => row.start);
    const limit = bisect(starts, end);
    for (let index = Math.max(0, bisect(starts, start, true) - 1); index < limit; index++) {
      const row = protectedRows[index];
      if (row.end > start) barriers.push([Math.max(start, row.start), Math.min(end, row.end)]);
    }
  }
  if (kind === 'social') for (const note of R.NOTE.finditer(text, start, end)) barriers.push(note.span());
  barriers.sort(([a, b], [x, y]) => a - x || b - y);
  barriers.push([end, end]);
  let cursor = start;
  for (const [a, b] of barriers) {
    if (cursor <= a) for (const match of pattern.finditer(text, cursor, a)) {
      const [lo, hi] = match.span();
      if (/[\r\n\f]/u.test(match.value)) continue;
      if (!(kind in R.VALUE_LENGTHS)) {
        const prefix = kind === 'social' ? trim(slice(text, start, lo), undefined, 'right') : '';
        if (!prefix || endsAny(prefix, ['为', '是', '、', '，', ',', '；', ';', '/', '／', '和', '与', '及'])) rows.push(hit(lo, hi, kind, reason, priority));
        continue;
      }
      if (lo > start && /^[A-Za-z0-9]$/.test(char(text, lo - 1))) continue;
      if (units.match(text, hi, end)) continue;
      for (const [x, y] of numberParts(text, lo, hi, kind)) {
        const raw = slice(text, x, y);
        const count = Array.from(raw).filter(value => digits(value) || 'xX*×'.includes(value)).length;
        const [low, upper] = R.VALUE_LENGTHS[kind];
        const high = kind === 'mobile' && slice(text, x, x + 2) === '00' ? upper + 2 : upper;
        const preceding = kind === 'mobile' && count < 7 ? trim(slice(text, start, x), undefined, 'right') : '';
        if (kind === 'mobile' && count < 7 && x !== start && preceding && !'、，,；;/／为是'.includes(char(preceding, -1))
            && !R.EXTENSION.search(text, Math.max(start, x - 6), y) && !/[*×Xx]/.test(raw)) continue;
        if (count < (minimumLength || low) || (count > high && minimumLength)) continue;
        rows.push(hit(x, y, count > high ? 'number' : kind, reason, priority));
      }
    }
    cursor = Math.max(cursor, b);
  }
  if (kind === 'mobile') for (const ext of R.EXTENSION.finditer(text, start, end)) rows.push(hit(...ext.span(1), 'mobile', '分机', priority + 1));
  return [...new Map(rows.map(row => [keyOf(row), row])).values()].sort((a, b) => a.start - b.start || b.priority - a.priority || b.end - a.end);
}

function fieldValues(text: string, start: number, end: number, label: string, protectedRows: Hit[]) {
  const kind = R.FIELD_TYPES[label];
  if (R.SIGNATURE_LABELS.has(label)) return signatureValues(text, start, end, label);
  if (kind in R.VALUE_PATTERNS || kind === 'case_number') return identifierValues(text, start, end, kind, label, 110, protectedRows);
  if (label === '房号') {
    const first = start + length(slice(text, start, end)) - length(trim(slice(text, start, end), undefined, 'left'));
    const unit = propertyUnit.match(text, first, end);
    if (!unit) return [];
    const detail = propertyDetail.match(text, unit.end(), end);
    return [hit(first, first + length(trim(slice(text, first, detail?.end() ?? unit.end()), undefined, 'right')), kind, label, 102)];
  }
  if (kind === 'address') return addressValues(text, start, end, label);
  const row = scalarField(text, start, end, label);
  return row ? [row] : [];
}

function separator(line: string) {
  return line.includes('\t') ? '\t' : line.includes('|') ? '|' : line.includes(',') ? ','
    : trim(line).includes('  ') ? '  ' : null;
}

function csvRecord(text: string, start: number): [Span[], number] | undefined {
  const cells: Span[] = [];
  let cursor = start;
  for (;;) {
    const match = R.CSV_CELL.match(text, cursor);
    if (!match) return undefined;
    const [a, b] = match.span(1);
    cells.push(char(text, a) === '"' ? [a + 1, b - 1] : [a, b]);
    if (char(text, b) !== ',') return [cells, b];
    cursor = b + 1;
  }
}

const cellPatterns = {'\t': rule('[^\\t]*'), '|': rule('[^|]*')};
const alignedCell = rule('[^ \\t\\r\\n\\f]+(?: [^ \\t\\r\\n\\f]+)*');
function cellsOf(line: string, offset: number, delim: string | null): Span[] {
  if (!delim) return [];
  if (delim === ',') return (csvRecord(line, 0)?.[0] ?? []).map(([a, b]) => [a + offset, b + offset]);
  if (delim === '  ') return [...alignedCell.finditer(line)].map(match => [offset + match.start(), offset + match.end()]);
  const cells: Span[] = [];
  for (const match of cellPatterns[delim as keyof typeof cellPatterns].finditer(line)) {
    if (match.start() === 0 || char(line, match.start() - 1) === delim) cells.push([offset + match.start(), offset + match.end()]);
  }
  if (delim === '|') {
    if (trim(line, undefined, 'left').startsWith('|')) cells.shift();
    if (trim(line, undefined, 'right').endsWith('|')) cells.pop();
  }
  return cells;
}

const numericHeader = rule('\\d(?:[ \\t.-]*\\d){2}');
const fourDigits = rule('\\d{4}');
const hasLabels = (values: string[]) => values.filter(value => Object.hasOwn(R.FIELD_TYPES, value)).length >= 2;
const sequenceCaptions = new Set(['序号', '债权编号', '债权人编号']);
const partyCaptions = new Map([['债权人', '债权人名称'], ['债权人姓名或名称', '债权人名称'], ['债权人姓名', '姓名'], ['职工姓名', '姓名']]);
const amountCaption = rule('(?:金额|总额|余额)(?:[（(](?:人民币|万)?元[）)])?$');
const amountColumns = new Set(['本金', '利息', '罚息', '工资', '医疗费', '伤残补助', '养老金垫付',
  '医保金垫付', '公积金', '补偿金', '职工债权（合计）', '普通债权（赔偿金）', '普通债权（劣后）']);
const totalsCaption = rule('小计|合计|总计');
const blankRecords = rule('(?:[ \\t]*(?:\\r\\n|\\r|\\n))*');
const propertyUnit = rule('(?:[\\u3400-\\u9fff]{1,8}[ \\t]*(?=\\d))?'
  + '(?:(?:\\d+[A-Za-z]?(?:号楼|栋|幢|楼|层|单元|室|号|房)|负[一二三四五六七八九十\\d]+层)[ \\t]*)+\\d{0,6}|\\d{1,6}(?!\\d)');
const propertyDetail = rule('(?:宿舍)?(?:由[东南西北]向[东南西北])?第[ \\t]*[一二三四五六七八九十百\\d]+'
  + '(?:[ \\t]*间(?:及前方)?|个(?:车位|柱子)|至第[一二三四五六七八九十百\\d]+个柱子之间)');

function columnLabels(values: string[], delim: string | null) {
  const numbered = delim === '  ' && sequenceCaptions.has(values[0]);
  return values.map(value => {
    const compact = value.replace(/\s/gu, '');
    if (amountCaption.search(compact) || amountColumns.has(compact)) return '金额';
    if (numbered && ['名称', '主体名称'].includes(compact)) return '债权人名称';
    return partyCaptions.get(compact) ?? (Object.hasOwn(R.FIELD_TYPES, compact) || sequenceCaptions.has(compact) ? compact : value);
  });
}

function isHeader(values: string[], columns: string[], text: string, following: number, delimiter: string | null) {
  if (!hasLabels(values) || values.some(value => numericHeader.test(value))) return false;
  if (values.every(value => Object.hasOwn(R.FIELD_TYPES, value) || R.HEADER_NAMES.has(value)
      || sequenceCaptions.has(value) || columns.includes(value))) return true;
  const start = blankRecords.match(text, following)?.end() ?? following;
  const record = delimiter === ',' ? csvRecord(text, start) : undefined;
  const cells = record?.[0] ?? cellsOf(slice(text, start, R.RECORD_END.search(text, start)?.start()), start, delimiter);
  if (cells.length !== values.length) return false;
  return cells.some(([a, b], index) => {
    const value = trim(slice(text, a, b));
    const kind = R.FIELD_TYPES[values[index]];
    return ['id_card', 'bank_account', 'mobile'].includes(kind) && fourDigits.test(value)
      || kind === 'keep' && !!dateTime.fullmatch(value)
      || values[index] === '金额' && !!R.AMOUNT_FIELD.fullmatch(value);
  });
}

const blankValue = rule('[:\\- ]+');
const keepDelimiter = rule('[，。；;|｜\\t]');
const generalDelimiter = rule('[，,。；;|｜\\t]');
const internationalCode = rule('00\\d{1,3}[ (（-]');
const measureSuffix = rule('(?:元|万|%)');
const sentenceEnd = rule('[。！？.!?；;]$');
const courtTurn = rule('^[ \\t]*[\\[【]([^\\]】\\r\\n]{1,32})[\\]】][ \\t]*[：:]');
const courtRole = rule('(?:审判长|审判员|人民陪审员|法官(?:助理)?|书记员|技术调查官|公诉人|辩护人|诉讼代理人|'
  + '上诉人|被上诉人|被告人?|原告|申请人|被申请人|第三人|主持人)(?=$|[ \\t　])');
const signingRoles = ['审判长', '审判员', '人民陪审员', '法官助理', '书记员'].map(role => [...role].join('[ \\t　]*')).join('|');
const courtSignature = rule('^[ \\t　]*(' + signingRoles + ')(?:[ \\t　]{2,}|\\t+)'
  + '([\\u3400-\\u9fff](?:[\\u3400-\\u9fff]|[ \\t　])*?)[ \\t　]*$');
const courtNumber = rule('[（(〔【]\\d{4}[）)〕】][ \\t]*(?:最高法|[京津沪渝冀豫云辽黑湘皖鲁新苏浙赣鄂桂甘晋蒙陕吉闽贵粤青藏川宁琼兵军港澳台])'
  + '[ \\t]*(?:\\d{2,6}[ \\t]*)?(?:民|刑|行|执|知|商|赔|清|破|辖|认|仲)[ \\t]*(?:[\\u3400-\\u9fff]{1,5}[ \\t]*)?\\d+[ \\t]*号');
const officeEnding = rule('(?:财政局|(?:国资|市场)监管局|税务(?:总局|分局|局)|管理局|分局|办事处)$');
const englishOrganization = /(?:bank|company|group|university|corporation)\b.*\b(?:branch|limited|ltd|inc|llc)\.?$/iu;
const partyList = rule('[^、，,；;\\r\\n\\f]+');

function tableParties(text: string, start: number, end: number, nameOnly: boolean) {
  function kind(value: string) {
    if (genericOrganization.fullmatch(value) || referenceLead.match(value)) return undefined;
    const isName = R.PERSON_VALUE.fullmatch(value) && typicalName(value)
      && !R.ROLE.fullmatch(value) && !R.TITLE.fullmatch(value) && !R.PERSON_NOTE.search(value);
    if (isName && (nameOnly || !ascii(value))) return 'person';
    const office = officeEnding.search(value);
    if (!nameOnly && (organizationValue(value) || englishOrganization.test(value)
        || (office && office.start() > 0 && organizationToken.fullmatch(value) && !nameClause.search(slice(value, 0, office.start()))))) {
      return 'organization';
    }
    return isName ? 'person' : undefined;
  }
  function party(raw: string, start: number) {
    const value = trim(raw);
    const type = value && kind(value);
    const at = start + indexOf(raw, value);
    return type ? hit(at, at + length(value), type, '表格主体', 102) : undefined;
  }
  const complete = party(slice(text, start, end), start);
  if (complete) return [complete];
  return [...partyList.finditer(text, start, end)].flatMap(match => party(match.value, match.start()) ?? []);
}

function fieldEnd(line: string, start: number, limit: number, label: string) {
  const kind = R.FIELD_TYPES[label];
  const delimiter = R.IDENTIFIER_FIELDS.has(kind) || R.SIGNATURE_LABELS.has(label) ? R.CONTACT_END
    : kind === 'address' ? R.FIELD_END : kind === 'keep' ? keepDelimiter : generalDelimiter;
  return delimiter.search(line, start, limit)?.start() ?? limit;
}

export function readFields(source: string): Layout {
  const text = translateWidth(source);
  const total = length(text);
  const layout: Layout = {hits: [], free: [], sections: [], answers: [], speakers: new Map(), courtReplies: []};
  const {hits, free} = layout;
  const protectedRows = [...R.DATE_AMOUNT.finditer(text)].map(match => hit(...match.span(), 'keep', '日期、时间或金额', 108));
  protectedRows.push(...[..._EMAIL.finditer(text)].map(match => hit(...match.span(), 'email', '邮箱', 109)));
  protectedRows.sort((a, b) => a.start - b.start);
  let pendingLabel: string | undefined;
  let question: Span | undefined;
  let answer: Span | undefined;
  let columns: string[] = [];
  let tableSeparator: string | null = null;
  let afterBlank = false;
  let chat = false;
  let proseContinues = false;
  const courtRoles = new Set<string>();
  let courtQuestion = '';
  let offset = 0;
  while (offset < total) {
    const previousProse = proseContinues;
    proseContinues = false;
    if (char(text, offset) === '\f') {
      if (question && answer) layout.answers.push([question, answer]);
      question = answer = undefined;
      courtQuestion = '';
      pendingLabel = undefined;
      columns = [];
      layout.sections.push(offset++);
      continue;
    }
    let newline = R.RECORD_END.search(text, offset);
    let end = newline?.start() ?? total;
    let following = newline?.value === '\f' ? end : (newline?.end() ?? end);
    let line = slice(text, offset, end);
    let delim: string | null = columns.length ? tableSeparator : separator(line);
    const csv = columns.length && delim === ',' ? csvRecord(text, offset) : undefined;
    let cells: Span[];
    if (csv && csv[0].length === columns.length) {
      [cells, end] = csv;
      newline = R.RECORD_END.match(text, end);
      following = newline?.value === '\f' ? end : (newline?.end() ?? end);
      line = slice(text, offset, end);
    } else cells = cellsOf(line, offset, delim);
    let values = cells.map(([a, b]) => trim(slice(text, a, b)));
    let labels = columnLabels(values, delim);
    if (columns.length && (afterBlank || cells.length !== columns.length)) {
      const candidate = separator(line);
      if (candidate && candidate !== delim) {
        const candidateCells = cellsOf(line, offset, candidate);
        const candidateValues = candidateCells.map(([a, b]) => trim(slice(text, a, b)));
        const candidateLabels = columnLabels(candidateValues, candidate);
        if (isHeader(candidateLabels, columns, text, following, candidate)) {
          [delim, cells, values, labels] = [candidate, candidateCells, candidateValues, candidateLabels];
        }
      }
    }
    if (!trim(line)) {
      afterBlank = true;
      pendingLabel = undefined;
      offset = following;
      continue;
    }
    const newHeader = isHeader(labels, columns, text, following, delim);
    const numberedTable = columns.some(label => sequenceCaptions.has(label));
    const totals = numberedTable && totalsCaption.fullmatch(values[0] ?? '')
      && values.slice(1).every(value => R.EMPTY.has(value) || R.AMOUNT_FIELD.fullmatch(value));
    const inTable = newHeader || totals || (columns.length > 0 && cells.length === columns.length);
    const chatHeading = R.CHAT_HEADING.match(line);
    const heading = R.HEADING.match(line) || chatHeading;
    const turn = inTable ? undefined : R.TURN.match(line);
    const interviewee = R.INTERVIEWEE.match(line);
    if (heading || interviewee || turn) chat = !!chatHeading;
    const court = inTable || turn ? undefined : courtTurn.match(line);
    let speaker = inTable || turn ? undefined : (court ?? R.CHAT.match(line));
    if (!speaker && chat && !heading) {
      const bare = R.BARE_CHAT.match(line);
      if (bare && (!(bare.group(1)! in R.FIELD_TYPES) || R.ROLE.fullmatch(bare.group(1)!))) speaker = bare;
    }
    const messageStart = offset + (speaker?.end() ?? 0);
    if (speaker) layout.speakers.set(messageStart, [offset + speaker.start(1), offset + speaker.end(1)]);
    if (heading || interviewee || newHeader || (columns.length && !inTable)) layout.sections.push(offset);

    const asks = turn?.group(1)?.startsWith('问');
    if (inTable || heading || speaker || interviewee || asks) {
      if (question && answer) layout.answers.push([question, answer]);
      question = undefined;
      answer = undefined;
    }
    if (asks) question = [offset + turn!.end(), end];
    else if (question && (turn || answer)) answer = [answer ? answer[0] : offset + turn!.end(), end];

    const continuation = pendingLabel;
    pendingLabel = undefined;
    afterBlank = false;
    if (newHeader) {
      columns = labels;
      tableSeparator = delim;
      hits.push(hit(offset, end, 'keep', '表头', 115));
    } else if (totals) {
      hits.push(hit(offset, end, 'keep', '表内汇总', 114));
      if (values[0] !== '小计') columns = [];
    } else if (columns.length && cells.length === columns.length) {
      for (let i = 0; i < columns.length; i++) {
        const label = columns[i];
        const [a, b] = cells[i];
        const value = values[i];
        if (!value || blankValue.fullmatch(value)) continue;
        const typed = numberedTable && ['债权人名称', '姓名'].includes(label) ? tableParties(text, a, b, label === '姓名')
          : label in R.FIELD_TYPES ? fieldValues(text, a, b, label, protectedRows) : [];
        const context = label ? `${label}：` : '';
        if (typed.length) {
          hits.push(...typed);
          if (R.SIGNATURE_LABELS.has(label) || typed.some(row => row.value_limit !== null || row.needs_context)) {
            free.push({start: a, end: b, context});
            continue;
          }
          let cursor = a;
          for (const row of typed) {
            if (trim(slice(text, cursor, row.start))) free.push({start: cursor, end: row.start, context});
            cursor = row.end;
          }
          if (trim(slice(text, cursor, b))) free.push({start: cursor, end: b, context});
        } else if (!R.EMPTY.has(value)) free.push({start: a, end: b, context});
      }
    } else {
      columns = [];
      const bodyStart = messageStart - offset;
      const fields = [...R.LABEL.finditer(line, bodyStart), ...R.INLINE_IDENTIFIER.finditer(line, bodyStart)]
        .sort((a, b) => a.start() - b.start());
      let context = question && answer ? slice(text, ...question) : '';
      if (continuation && !speaker && !turn && !heading) {
        const first = length(line) - length(trim(line, undefined, 'left'));
        const kind = R.FIELD_TYPES[continuation];
        const pattern = kind === 'case_number' ? R.CASE_VALUE : R.VALUE_PATTERNS[kind];
        const limit = fieldEnd(line, first, fields[0]?.start() ?? length(line), continuation);
        if (first < limit && (!pattern || pattern.match(line, first, limit))) {
          hits.push(...fieldValues(text, offset + first, offset + limit, continuation, protectedRows));
          context ||= `${continuation}：`;
        }
      }
      const party = speaker ? undefined : R.PARTY_DEFINITION.match(line);
      if (party) {
        const row = scalarField(text, offset + party.start(2), offset + party.end(2), party.group(1)!);
        if (row) hits.push(row);
      }
      if (speaker) {
        const [a, b] = layout.speakers.get(messageStart)!;
        if (court && !chat) {
          const role = courtRole.match(text, a, b);
          if (role) {
            courtRoles.add(role.value);
            hits.push(hit(a, role.end(), 'keep', '庭审角色', 112));
            const utterance = slice(text, messageStart, end);
            if (utterance.includes('自然情况') && /[？?]/u.test(utterance)) courtQuestion = utterance;
            else if (courtQuestion) {
              layout.courtReplies.push({start: messageStart, end, context: courtQuestion});
              context = courtQuestion;
              courtQuestion = '';
            }
          }
          const value = trim(slice(text, role?.end() ?? a, b));
          if (value && (role || courtRoles.size && typicalName(value)) && R.PERSON_VALUE.fullmatch(value)) {
            const row = scalarField(text, role?.end() ?? a, b, '姓名');
            if (row) hits.push(row);
          }
        } else {
          const row = scalarField(text, a, b, '发言者');
          if (row) hits.push(row);
        }
      }
      const signature = !speaker && !fields.length ? courtSignature.fullmatch(line) : undefined;
      if (signature) {
        const name = signature.group(2)!.replace(/\s/gu, '');
        if (R.PERSON_VALUE.fullmatch(name) && typicalName(name)) {
          hits.push(hit(offset + signature.start(2), offset + signature.end(2), 'person', '裁判署名', 102));
          hits.push(hit(offset + signature.start(1), offset + signature.end(1), 'keep', '裁判署名职务', 112));
        }
      }
      for (let index = 0; index < fields.length; index++) {
        const field = fields[index];
        const limit = fields[index + 1]?.start() ?? length(line);
        const label = field.group(1)!;
        if (index === fields.length - 1 && !trim(slice(line, field.end(), limit))) pendingLabel = label;
        hits.push(...fieldValues(text, offset + field.end(), offset + fieldEnd(line, field.end(), limit, label), label, protectedRows));
      }
      const prose = !(speaker || turn || fields.length || heading || signature || continuation);
      const previous = free.at(-1);
      if (previous && ((answer && !turn && previous.start <= answer[0] && answer[0] < previous.end)
          || (prose && previousProse))) {
        previous.end = end;
      } else {
        free.push({start: court && !chat ? offset : messageStart, end, context: slice(context, -96)});
      }
      proseContinues = prose && !sentenceEnd.search(trim(line, undefined, 'right'));
    }
    offset = following;
  }
  if (question && answer) layout.answers.push([question, answer]);

  const roles = courtRoles.size ? rule([...courtRoles].sort((a, b) => b.length - a.length).join('|')) : undefined;
  const roleLead = rule('(?:请|向|由|申请|通知|要求|询问)[ \\t]*$');
  const roleTail = rule('[，：,:]|到庭|出庭|说明|询问|回答');
  for (const passage of free) {
    for (const match of courtNumber.finditer(text, passage.start, passage.end)) {
      if (/[ \t]/u.test(match.value)) hits.push(hit(...match.span(), 'case_number', '法院案号', 106));
    }
    if (!roles) continue;
    for (const match of roles.finditer(text, passage.start, passage.end)) {
      const before = slice(text, passage.start, match.start());
      if (!trim(before) || roleLead.search(before) || roleTail.match(text, match.end(), passage.end)) {
        hits.push(hit(...match.span(), 'keep', '庭审角色', 112));
      }
    }
  }
  for (const prefix of _BANK_PREFIX.finditer(text)) {
    const number = R.NUMBER_GROUP.match(text, prefix.end());
    if (number) hits.push(...identifierValues(text, ...number.span(), 'bank_account', '账号上下文', 94, protectedRows, 8));
  }
  for (const match of R.INTERNATIONAL.finditer(text)) {
    const value = match.value;
    if (/[\r\n]/.test(value) || !(value.startsWith('+') || internationalCode.match(value))) continue;
    const count = length(bareDigits.replace(value, '')) - (value.startsWith('00') ? 2 : 0);
    if (count >= 8 && count <= 15 && !measureSuffix.match(char(text, match.end()))) hits.push(hit(...match.span(), 'mobile', '国际电话号码', 90));
  }
  for (const match of R.NUMBER_GROUP.finditer(text)) {
    if (R.GROUPED_CARD.fullmatch(match.value) && luhn(bareDigits.replace(match.value, ''))) hits.push(hit(...match.span(), 'bank_account', '分组卡号', 92));
  }
  for (const match of R.TAIL.finditer(text)) hits.push(hit(...match.span(1), 'tail', '尾号字段', 99));
  hits.push(...protectedRows);
  for (const match of _LABELED_USCC.finditer(text)) {
    const value = match.group(1)!;
    if (!/[\r\n\f]/u.test(value) && _USCC.fullmatch(value.replace(/\s/gu, '').toUpperCase())
        && !/^[A-Za-z0-9]$/u.test(char(text, match.end(1)))) {
      hits.push(hit(...match.span(1), 'uscc', '统一社会信用代码', 112));
    }
  }
  for (const match of structuralCandidates(text)) {
    const kind = R.STRUCTURAL[match.category];
    if (kind && match.auto_replace && !/[\r\n\f\t]/u.test(match.text)) {
      hits.push(hit(match.start, match.end, kind, match.notes || match.category, 86));
    }
  }
  return layout;
}

const organizationLead = rule('让我给|委托给|交给|转给|发送给|发给|签约方为|来自');
export function languageRules(text: string) {
  return languageSuspects(text).flatMap(row => {
    if (R.ROLE.fullmatch(row.text) || R.TITLE.fullmatch(row.text) || row.reason === 'org_suffix_unanchored') return [];
    const boundary = row.category === 'organization' ? [...organizationLead.finditer(row.text)].at(-1) : undefined;
    return [hit(row.start + (boundary?.end() ?? 0), row.end, row.category, row.reason, row.category === 'organization' ? 58 : 65)];
  });
}

export function streetAddresses(text: string) {
  const rows: Hit[] = [];
  const end = length(text);
  for (const intro of R.DELIVERY_INTRO.finditer(text)) {
    const start = intro.end();
    const road = R.ROAD_VALUE.match(text, start);
    const part = road || R.PREMISE.match(text, start);
    if (part && !R.ADDRESS_BREAK.search(text, start, part.end())) {
      const stop = deliveryEnd(text, part.end(), end);
      if (stop > part.end() || road) rows.push(hit(start, stop, 'address', '叙述中的投递地址', 87));
    }
  }
  for (const match of R.STREET_ADDRESS.finditer(text)) {
    const intro = [...R.ADDRESS_INTRO.finditer(match.value.split('市', 1)[0])].at(-1);
    const start = match.start() + (intro?.end() ?? 0);
    if (slice(text, start, match.end()).includes('的')) continue;
    if (match.end() - start >= 6) rows.push(hit(start, deliveryEnd(text, match.end(), end), 'address', '街路门牌', 87));
  }
  return rows;
}
