import * as R from './field-rules.js';
import { _BANK_PREFIX, _EMAIL } from './number-rules.js';
import { structuralCandidates, luhn, translateWidth } from './numbers.js';
import { hasSurname, languageSuspects } from './suspects.js';
import { COMPOUND_SURNAMES } from './suspect-rules.js';
import { ascii, bisect, char, digits, endsAny, indexOf, keyOf, length, rule, slice, startsAny, trim, type Span } from './text.js';

export type Hit = {
  start: number; end: number; kind: string; reason: string; priority: number; value_limit: number | null; needs_context: boolean;
};
export type Passage = { start: number; end: number; context: string };
export type Layout = { hits: Hit[]; free: Passage[]; sections: number[]; answers: [Span, Span][]; speakers: Map<number, Span> };
export const hit = (start: number, end: number, kind: string, reason: string, priority: number,
    value_limit: number | null = null, needs_context = false): Hit => ({start, end, kind, reason, priority, value_limit, needs_context});

export function typicalName(value: string) {
  return ascii(value) || value.includes('·') || value.includes('・')
    || hasSurname(value) && (length(value) <= 3 || startsAny(value, COMPOUND_SURNAMES));
}

const dateTime = rule(R.DATE_TIME);
const direction = rule('借方?|贷方?|进账|入账|出账|收入|支出');
const shortDefinition = rule('[（(]\\s*(?:以下)?简称');
const organization = rule(R.ORG);
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
    const boundary = (['设备编号', '设备号'].includes(label) ? R.DEVICE_VALUE
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
  if (kind === 'party') kind = R.ORG_END.test(value) || organization.test(value) ? 'organization' : 'person';
  if (kind === 'person' && (R.ROLE.fullmatch(value) || length(value) === 1 || R.TITLE.fullmatch(value))) kind = 'keep';
  if (kind === 'person' && (!R.PERSON_VALUE.fullmatch(value) || R.PERSON_NOTE.test(value))) return undefined;
  const needsContext = kind === 'person' && (!['姓名', '被询问人', '被讯问人'].includes(label) || !typicalName(value))
    || kind === 'organization' && !R.ORG_END.test(value);
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
  if (kind === 'address') return addressValues(text, start, end, label);
  const row = scalarField(text, start, end, label);
  return row ? [row] : [];
}

function separator(line: string) {
  return line.includes('\t') ? '\t' : line.includes('|') ? '|' : line.includes(',') ? ',' : null;
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
function cellsOf(line: string, offset: number, delim: string | null): Span[] {
  if (!delim) return [];
  if (delim === ',') return (csvRecord(line, 0)?.[0] ?? []).map(([a, b]) => [a + offset, b + offset]);
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

function isHeader(values: string[], columns: string[], following = '') {
  if (!hasLabels(values) || values.some(value => numericHeader.test(value))) return false;
  if (values.every(value => R.HEADER_NAMES.has(value) || columns.includes(value))) return true;
  const cells = cellsOf(following, 0, separator(following));
  if (cells.length !== values.length) return false;
  return cells.some(([a, b], index) => {
    const value = trim(slice(following, a, b));
    const kind = R.FIELD_TYPES[values[index]];
    return ['id_card', 'bank_account', 'mobile'].includes(kind) && fourDigits.test(value)
      || kind === 'keep' && !!dateTime.fullmatch(value);
  });
}

const blankValue = rule('[:\\- ]+');
const keepDelimiter = rule('[，。；;|｜\\t]');
const generalDelimiter = rule('[，,。；;|｜\\t]');
const internationalCode = rule('00\\d{1,3}[ (（-]');
const measureSuffix = rule('(?:元|万|%)');
const sentenceEnd = rule('[。！？.!?；;]$');

function fieldEnd(line: string, start: number, limit: number, label: string) {
  const kind = R.FIELD_TYPES[label];
  const delimiter = R.IDENTIFIER_FIELDS.has(kind) || R.SIGNATURE_LABELS.has(label) ? R.CONTACT_END
    : kind === 'address' ? R.FIELD_END : kind === 'keep' ? keepDelimiter : generalDelimiter;
  return delimiter.search(line, start, limit)?.start() ?? limit;
}

export function readFields(source: string): Layout {
  const text = translateWidth(source);
  const total = length(text);
  const layout: Layout = {hits: [], free: [], sections: [], answers: [], speakers: new Map()};
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
  let offset = 0;
  while (offset < total) {
    const previousProse = proseContinues;
    proseContinues = false;
    if (char(text, offset) === '\f') {
      if (question && answer) layout.answers.push([question, answer]);
      question = answer = undefined;
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
    if (columns.length && (afterBlank || cells.length !== columns.length)) {
      const candidate = separator(line);
      if (candidate && candidate !== delim) {
        const candidateCells = cellsOf(line, offset, candidate);
        const candidateValues = candidateCells.map(([a, b]) => trim(slice(text, a, b)));
        if (isHeader(candidateValues, columns)) [delim, cells, values] = [candidate, candidateCells, candidateValues];
      }
    }
    if (!trim(line)) {
      afterBlank = true;
      pendingLabel = undefined;
      offset = following;
      continue;
    }
    let next = '';
    if (hasLabels(values) && values.some(value => !R.HEADER_NAMES.has(value) && !columns.includes(value))) {
      next = slice(text, following, R.RECORD_END.search(text, following)?.start() ?? total);
    }
    const newHeader = isHeader(values, columns, next);
    const inTable = newHeader || (columns.length > 0 && cells.length === columns.length);
    const chatHeading = R.CHAT_HEADING.match(line);
    const heading = R.HEADING.match(line) || chatHeading;
    const turn = inTable ? undefined : R.TURN.match(line);
    const interviewee = R.INTERVIEWEE.match(line);
    if (heading || interviewee || turn) chat = !!chatHeading;
    let speaker = inTable || turn ? undefined : R.CHAT.match(line);
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
      columns = values;
      tableSeparator = delim;
      hits.push(hit(offset, end, 'keep', '表头', 115));
    } else if (columns.length && cells.length === columns.length) {
      for (let i = 0; i < columns.length; i++) {
        const label = columns[i];
        const [a, b] = cells[i];
        const value = values[i];
        if (!value || blankValue.fullmatch(value)) continue;
        const typed = label in R.FIELD_TYPES ? fieldValues(text, a, b, label, protectedRows) : [];
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
        const row = scalarField(text, ...layout.speakers.get(messageStart)!, '发言者');
        if (row) hits.push(row);
      }
      for (let index = 0; index < fields.length; index++) {
        const field = fields[index];
        const limit = fields[index + 1]?.start() ?? length(line);
        const label = field.group(1)!;
        if (index === fields.length - 1 && !trim(slice(line, field.end(), limit))) pendingLabel = label;
        hits.push(...fieldValues(text, offset + field.end(), offset + fieldEnd(line, field.end(), limit, label), label, protectedRows));
      }
      const prose = !(speaker || turn || fields.length || heading || continuation);
      const previous = free.at(-1);
      if (previous && ((answer && !turn && previous.start <= answer[0] && answer[0] < previous.end)
          || (prose && previousProse))) {
        previous.end = end;
      } else {
        free.push({start: messageStart, end, context: slice(context, -96)});
      }
      proseContinues = prose && !sentenceEnd.search(trim(line, undefined, 'right'));
    }
    offset = following;
  }
  if (question && answer) layout.answers.push([question, answer]);

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
  for (const match of structuralCandidates(text)) {
    const kind = R.STRUCTURAL[match.category];
    if (kind && !/[\r\n\t]/.test(match.text)) hits.push(hit(match.start, match.end, kind, match.notes || match.category, match.auto_replace ? 86 : 54));
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
    if (match.end() - start >= 6) rows.push(hit(start, deliveryEnd(text, match.end(), end), 'address', '街路门牌', 87));
  }
  return rows;
}
