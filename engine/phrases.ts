import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { allSpans } from './context.js';
import { ALIAS_SUFFIX } from './context-rules.js';
import { administrativeParts, hit, organizationValue, type Hit } from './fields.js';
import { housingEnd } from './housing.js';
import { ORDINAL, publicPattern, REGIONAL_UNIT } from './organizations.js';
import { char, length, point, rule, slice, startsAny, endsAny, unit, trim, type Span } from './text.js';

const localUnit = rule('(?:人民)?政府(?:办公室)?|(?:职业技术|技术|技师)学院|(?:工商行政|市场监督)管理局'
  + '|(?:民政|司法|税务|财政)局|' + ORDINAL + '看守所');
const specialCourt = rule('(?:铁路运输|知识产权|海事|金融|互联网)(?:中级|高级)?(?:人民)?法院');
const subunit = rule('(?<name>[一-鿿]{0,6}?)(?<type>派出所|分局|总队|支队|大队)');
const ranks: Record<string, number> = {分局: 1, 总队: 1, 支队: 2, 大队: 3, 派出所: 4};
const link = rule('以及|或者|出具|收到|提出|申请|工作|出警|民警|负责|转送|所属|另一|[向由在的是与将后其某该到]');
const village = rule('([一-鿿]{1,5}?)(?:社区|行政村|村)');
const settlement = rule('(?:新区|开发区|园区|街道|镇|村|乡|县|区|市|省)$');
const addressLabel = rule('(?:户籍地址|户籍地|住址|住所地?|地址)(?:在|位于)?[：: ]*$');
const zone = rule('([一-鿿]{1,7}?)(?:开发区|园区)');
const mask = rule('[＊*×某Xx]');
const maskedRoad = rule('(?:[＊*×某Xx]+(?:大道|街道|路|街|巷|弄))+(?:(?<door>\\d+(?:[-－]\\d+)?号)|[＊*×某Xx]+号)');
const anonymousSite = rule('(?:某+|[×＊*Xx]+)(?<site>(?:[一-鿿]{0,4}?)(?:小区|社区|花园|家园|公寓|住宅楼|大厦))?');
const floors = rule('(?:、[ \\t]*(?:地下)?\\d+(?:楼|层))+');
const ward = rule('(?:住院部|门诊部)(?:[一-鿿]{1,4}?科)?');
const courtUnit = rule('(?:执行局|立案庭|(?:民事|刑事|行政|执行)?审判(?:第[一二三四五六七八九十\\d]+)?庭)(?!长)');
const taxUnit = rule('(?:' + ORDINAL + ')?稽查局(?!长)');
const legalForm = rule('(?:（[一-鿿]{2,6}）|\\([一-鿿]{2,6}\\))?(?:股份有限公司|有限责任公司|有限公司)');
const regionalBranch = rule('([一-鿿]{1,16}?)(分公司|分行|支行)');
const publishedUnit = rule('(?<![A-Za-zＡ-Ｚａ-ｚ0-9])([A-ZＡ-Ｚ])(?:银行|医院|学校|'
  + '(?:融资担保|担保|保险|物业|物流)?(?:股份有限公司|有限责任公司|有限公司|公司))');
const maskedBank = rule('(?:某+|[＊*×]+)银行');
const addressLead = rule('(?:户籍地址|户籍地|住所地?|住址)[：:]?(?:位于|在)?|(?:居住在|居住于|住在|位于|坐落于|到达|前往|从|往|在|到)');
const floorEnding = rule('\\d+(?:楼|层|室)$');
let vocabulary: ReturnType<typeof loadVocabulary> | undefined;
let genericPlaces: Set<string> | undefined;

function loadVocabulary() {
  const codes = new Map<string, string[]>();
  const towns = new Map<string, Map<string, Set<string>>>();
  const cities = new Set<string>();
  for (const line of gunzipSync(readFileSync(new URL('./lexicon/districts.tsv.gz', import.meta.url))).toString('utf8').trimEnd().split('\n')) {
    const [code, name] = line.split('\t');
    if (code.length === 9) {
      for (const parent of [code.slice(0, 4), code.slice(0, 6)]) {
        if (!towns.has(parent)) towns.set(parent, new Map());
        const index = towns.get(parent)!;
        const first = char(name, 0);
        if (!index.has(first)) index.set(first, new Set());
        index.get(first)!.add(name);
      }
    } else {
      if (!codes.has(name)) codes.set(name, []);
      codes.get(name)!.push(code);
      if (name.endsWith('市')) cities.add(slice(name, 0, -1));
    }
  }
  const initial = new Map<string, string[]>();
  for (const name of codes.keys()) {
    const first = char(name, 0);
    if (!initial.has(first)) initial.set(first, []);
    initial.get(first)!.push(name);
  }
  for (const names of initial.values()) names.sort((a, b) => length(b) - length(a));
  return {codes, towns, cities, initial};
}

export function commonPlaces() {
  return genericPlaces ??= new Set(readFileSync(new URL('./lexicon/generic_places.txt', import.meta.url), 'utf8').trimEnd().split('\n'));
}

export function namedUnitEnd(text: string, start: number, end: number) {
  const name = slice(text, start, end);
  if (name.endsWith('法院')) return courtUnit.match(text, end)?.end() ?? end;
  if (name.endsWith('税务局')) return taxUnit.match(text, end)?.end() ?? end;
  if (endsAny(name, ['医院', '病院'])) {
    const child = ward.match(text, end);
    if (child && !link.search(child.value)) return child.end();
  }
  return end;
}

function isTownOf(parent: string, region: string, lexicon: ReturnType<typeof loadVocabulary>) {
  if (length(region) < 2) return false;
  const forms = [region, region + '镇', region + '乡', region + '街道'];
  for (let n = 2; n <= length(parent); n++) {
    const prefix = slice(parent, 0, n);
    const codes = [...(lexicon.codes.get(prefix) ?? []), ...(lexicon.codes.get(prefix + '市') ?? [])];
    for (const code of codes) {
      const towns = lexicon.towns.get(code)?.get(char(region, 0));
      if (forms.some(form => towns?.has(form))) return true;
    }
  }
  return false;
}

export function regionalBranchEnd(text: string, start: number, end: number) {
  const parent = slice(text, start, end);
  const bankIndex = parent.lastIndexOf('银行');
  const suffix = parent.slice(bankIndex + 2);
  const bank = bankIndex >= 0 && (!suffix || legalForm.fullmatch(suffix));
  if (!bank && !endsAny(parent, ['有限公司', '有限责任公司'])) return end;
  const cursor = parent.endsWith('银行') ? legalForm.match(text, end)?.end() ?? end : end;
  const lexicon = vocabulary ??= loadVocabulary();
  let allowed = bank ? ['分行', '支行'] : ['分公司'];
  for (let child = regionalBranch.match(text, cursor); child; child = regionalBranch.match(text, end)) {
    const region = child.group(1)!;
    const kind = child.group(2)!;
    if (!allowed.includes(kind) || !lexicon.codes.has(region) && !lexicon.cities.has(region) && !isTownOf(parent, region, lexicon)) break;
    end = child.end();
    if (kind !== '分行') break;
    allowed = ['支行'];
  }
  return end;
}

function* namedBranches(text: string, evidence: Hit[]): Iterable<Hit> {
  const parents = new Map<string, Span>();
  for (const match of publicPattern.finditer(text)) {
    if (match.value.endsWith('银行')) parents.set(match.span().join('/'), match.span());
  }
  for (const row of evidence) {
    if (row.kind !== 'organization') continue;
    const value = slice(text, row.start, row.end);
    const bank = value.indexOf('银行');
    const parent = bank > 0 ? value.slice(0, bank + 2) : value;
    if (!mask.search(parent) && !link.search(parent) && organizationValue(parent)) {
      const span: Span = [row.start, row.start + length(parent)];
      parents.set(span.join('/'), span);
    }
  }
  for (const [start, end] of parents.values()) {
    const branchEnd = regionalBranchEnd(text, start, end);
    if (branchEnd > end) yield hit(start, branchEnd, 'organization', '具名单位与辖区分支', 88);
  }
}

export function publishedOrganizationSpans(text: string): Span[] {
  const names = new Set<string>();
  for (const party of publishedUnit.finditer(text)) {
    const end = regionalBranchEnd(text, party.start(), party.end());
    const alias = ALIAS_SUFFIX.match(text, end);
    if (!alias) continue;
    const short = trim(trim(alias.group(1)!), '“”「」"');
    if (short.startsWith(party.group(1)!) && publishedUnit.fullmatch(short)) {
      names.add(slice(text, party.start(), end));
      names.add(short);
    }
  }
  const spans: Span[] = [];
  for (const [, start, end] of allSpans(text, names)) {
    if (start === 0 || !/^[A-Za-zＡ-Ｚａ-ｚ0-9]$/u.test(char(text, start - 1))) spans.push([start, end]);
  }
  for (const parent of maskedBank.finditer(text)) {
    const end = regionalBranchEnd(text, parent.start(), parent.end());
    if (end > parent.end()) spans.push([parent.start(), end]);
  }
  return spans;
}

function policeEnd(text: string, end: number) {
  let level = 0;
  for (let child = subunit.match(text, end); child; child = subunit.match(text, end)) {
    const name = child.group('name')!;
    const type = child.group('type')!;
    const rank = ranks[type];
    if (rank <= level || !name || link.search(name)) break;
    level = rank;
    end = child.end();
    if (type === '派出所') break;
  }
  return end;
}

function* territorialNames(text: string): Iterable<Hit> {
  const {codes, towns, initial, cities} = vocabulary ??= loadVocabulary();
  const areas = new Map<number, string>();
  let offset = 0;
  for (const first of text) {
    const name = initial.get(first)?.find(term => text.startsWith(term, offset));
    if (name) areas.set(offset, name);
    offset += first.length;
  }
  for (const [startUnit, term] of areas) {
    const start = point(text, startUnit);
    let pos = start + length(term);
    let parents = codes.get(term)!;
    for (let child = areas.get(unit(text, pos)); child; child = areas.get(unit(text, pos))) {
      const next = codes.get(child)!.filter(code => parents.some(parent => code !== parent && code.startsWith(parent)));
      if (!next.length) break;
      parents = next;
      pos += length(child);
    }
    const first = char(text, pos);
    const names = new Set(parents.flatMap(parent => [...(towns.get(parent)?.get(first) ?? [])]));
    const town = [...names].filter(name => text.startsWith(name, unit(text, pos))).sort((a, b) => length(b) - length(a))[0] ?? '';
    let cursor = pos + length(town);
    let shortEnd = cursor;
    if (!town) {
      for (const name of names) {
        if (name.endsWith('街道') && text.startsWith(slice(name, 0, -2), unit(text, pos))
          && maskedRoad.match(text, pos + length(name) - 2)) {
          shortEnd = pos + length(name) - 2;
          break;
        }
      }
    }
    const road = maskedRoad.match(text, shortEnd);
    if (road) {
      yield hit(start, shortEnd, 'address', '遮名道路中的地域', 96);
      if (road.group('door')) yield hit(...road.span('door'), 'address', '遮名道路中的门牌', 96);
      continue;
    }
    const office = localUnit.match(text, cursor) ?? REGIONAL_UNIT.match(text, cursor);
    if (office) {
      const end = office.value === '公安局' ? policeEnd(text, office.end()) : office.end();
      yield hit(start, namedUnitEnd(text, start, end), 'organization', '地域与完整单位', 88);
      continue;
    }
    const hamlet = town ? village.match(text, cursor) : undefined;
    let officeType = town.endsWith('街道') ? '办事处' : '';
    if (hamlet && !link.search(hamlet.group(1)!) && !endsAny(hamlet.value, ['农村', '城中村'])) {
      cursor = hamlet.end();
      officeType = hamlet.value.endsWith('社区') ? '居民委员会' : '民委员会';
    }
    if (town) {
      if (officeType && text.startsWith(officeType, unit(text, cursor))) {
        yield hit(start, cursor + length(officeType), 'organization', '基层单位与辖区', 88);
        continue;
      }
      yield hit(start, cursor, 'address', '连续辖区及聚落', 75);
    }
    if (addressLabel.search(slice(text, Math.max(0, start - 12), start))) {
      const district = zone.match(text, cursor);
      if (district && !link.search(district.group(1)!) && mask.match(text, district.end())) {
        yield hit(start, district.end(), 'address', '住所中的已知地域', 100);
      }
    }
  }
  for (const court of specialCourt.finditer(text)) {
    for (let start = Math.max(0, court.start() - 9); start < court.start() - 1; start++) {
      if (!cities.has(slice(text, start, court.start()))) continue;
      yield hit(start, court.end(), 'organization', '地域与专门法院', 88);
      break;
    }
  }
}

export function completePhrases(text: string, predicted: Hit[], fields: Hit[], existing: Hit[], language: Hit[]) {
  const lexicon = vocabulary ??= loadVocabulary();
  const evidence = [...predicted, ...fields, ...existing, ...language]
    .filter(row => ['address', 'organization'].includes(row.kind) && row.reason !== 'org_suffix');
  const result: Hit[] = [];
  for (const site of anonymousSite.finditer(text)) {
    const end = housingEnd(text, site.end(), !!site.group('site'));
    if (end <= site.end()) continue;
    result.push(hit(site.end(), end, 'address', '已隐名处所的可见房号', 103));
    for (const row of evidence) {
      if (row.kind !== 'address' || row.start >= site.start() || row.end < site.end()) continue;
      const prefix = slice(text, row.start, site.start());
      const parts = [...administrativeParts(prefix)];
      if (parts.at(-1)?.[3] === length(prefix)) {
        result.push(hit(row.start, site.start(), 'address', '已隐名处所前的辖区', 103));
      }
    }
  }
  const parents = new Map(evidence.filter(row => row.kind === 'organization' && slice(text, row.start, row.end).endsWith('税务总局'))
    .map(row => [row.end, row.start]));
  for (const place of [...territorialNames(text), ...namedBranches(text, evidence)]) {
    const parent = parents.get(place.start);
    const row = parent !== undefined && place.kind === 'organization' && slice(text, place.start, place.end).includes('税务局')
      ? hit(parent, place.end, 'organization', '上级机关与辖区下属单位', place.priority) : place;
    const inside = (ref: Hit) => row.start <= ref.start && ref.end <= row.end;
    if (evidence.some(ref => row.start < ref.end && ref.start < row.end && !inside(ref) &&
        !(ref.kind === 'address' && row.reason === '住所中的已知地域' && mask.search(slice(text, ref.start, ref.end))))) continue;
    if (row.kind === 'organization') {
      for (const ref of evidence) if (ref.kind === row.kind && inside(ref)) row.priority = Math.max(row.priority, ref.priority);
    }
    result.push(row);
  }
  for (const row of evidence) {
    const value = slice(text, row.start, row.end);
    if (row.kind === 'organization') {
      const end = namedUnitEnd(text, row.start, row.end);
      if (end > row.end) result.push(hit(row.start, end, row.kind, '具名机构与直属部门', Math.max(69, row.priority)));
    }
    if (row.kind !== 'address') continue;
    if (endsAny(value, ['园', '苑', '小区', '公寓', '大厦', '号']) && !mask.search(value)) {
      const end = housingEnd(text, row.end);
      if (end > row.end && !evidence.some(other => other.kind === 'address' && other.start <= row.start && end <= other.end
          && (other.start < row.start || end < other.end))) {
        result.push(hit(row.start, end, 'address', '已知处所与房号', Math.max(88, row.priority)));
      }
    }
    const suffix = slice(value, 1);
    if (row.reason === 'Otter' && startsAny(value, ['到', '从', '往', '在']) && settlement.search(suffix) &&
        length(value) >= 4 && (lexicon.codes.has(suffix) || endsAny(value, ['新区', '街道']))) {
      result.push(hit(row.start + 1, row.end, row.kind, '去向与地域边界', row.priority + 1));
    }
    const label = row.reason === 'Otter' ? addressLead.match(value) : undefined;
    if (label && lexicon.initial.get(char(value, label.end()))?.some(term => slice(value, label.end()).startsWith(term))) {
      result.push(hit(row.start + label.end(), row.end, row.kind, '正文地域起点', row.priority + 1));
    }
    if (value.endsWith('的') && settlement.search(slice(value, 0, -1))) {
      result.push(hit(row.start, row.end - 1, row.kind, '地域与所属助词', row.priority + 1));
    }
    const next = floorEnding.search(value) && floors.match(text, row.end);
    if (next) result.push(hit(row.start, next.end(), row.kind, '同址并列楼室', row.priority));
  }
  return result;
}
