import { bisect, escape, rule, slice, type Span } from './text.js';

const banks = ['中国人民银行', '中国建设银行', '建设银行'];
const ministries = ['司法部', '教育部', '财政部', '公安部'];
export const publicForms = new Set([...banks, '中国共产党', '中共',
  ...ministries.flatMap(name => ['中华人民共和国' + name, name])]);
const publicPattern = rule([...publicForms].sort((a, b) => b.length - a.length).map(escape).join('|'));
export const GENERIC_OFFICE = rule('(?:[本该]?[省市区县乡镇]?(?:人民政府|政府|人大|政协)|公安机关|派出所|监委)');
export const OFFICE_TYPE = '(?:(?:中级|高级|基层)?人民法院|人民检察院|人民政府|公安局|教育局|'
  + '监察委员会|监委|看守所|(?:政协|人大)(?:委员会|常委会)?|图书馆)';
export const NUMBERED_TYPE = '(?:中学|小学|学校|大学|学院|医院|监狱)';
export const ORDINAL = '第[零〇一二两三四五六七八九十百\\d]+';
export const REGIONAL_UNIT = rule(`(?:${OFFICE_TYPE}|法院|(?:${ORDINAL})?${NUMBERED_TYPE}|分行|支行|分公司|分院|分校)`);
export const BRANCH_TYPE = '(?:分行|支行|分公司|分院|分校)';
const localBranch = rule('(?<region>[一-鿿]{2,8}?(?:省|市|县|区))(?<unit>分行|支行)');
const clauseJoin = rule('与|以及|或者|的|向|前往|办理|位于|设在');
export const PARTY_OFFICE = rule('(?:中共|中国共产党)(?<region>[一-鿿]{2,12}?(?:省|市|区|县))(?<unit>委员会|委)');

export function independentForms(text: string) {
  const spans = [...publicPattern.finditer(text)].map(match => match.span());
  const starts = spans.map(([start]) => start);
  return (start: number, end: number) => {
    const index = bisect(starts, start, true) - 1;
    return index >= 0 && end <= spans[index][1];
  };
}

export function* publicUnits(text: string, knownSpans: Set<string>): Iterable<Span> {
  for (const bank of publicPattern.finditer(text)) {
    if (!bank.value.endsWith('银行')) continue;
    const branch = localBranch.match(text, bank.end());
    if (!branch || clauseJoin.search(branch.group('region')!)) continue;
    const full: Span = [bank.start(), branch.end()];
    if ([full, branch.span('region'), branch.span()].some(span => knownSpans.has(span.join('/')))) yield full;
  }
  for (const match of PARTY_OFFICE.finditer(text)) {
    if (!clauseJoin.search(slice(text, ...match.span('region')))) yield match.span();
  }
}
