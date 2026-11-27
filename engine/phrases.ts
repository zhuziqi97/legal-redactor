import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { hit, type Hit } from './fields.js';
import { REGIONAL_UNIT } from './organizations.js';
import { char, length, point, rule, slice, startsAny, endsAny, unit } from './text.js';

const localUnit = rule('(?:人民)?政府(?:办公室)?|(?:职业技术|技术|技师)学院|(?:工商行政|市场监督)管理局');
const specialCourt = rule('(?:铁路运输|知识产权|海事|金融|互联网)(?:中级|高级)?(?:人民)?法院');
const subunit = rule('(?<name>[一-鿿]{0,6}?)(?<type>派出所|分局|总队|支队|大队)');
const ranks: Record<string, number> = {分局: 1, 总队: 1, 支队: 2, 大队: 3, 派出所: 4};
const link = rule('以及|或者|出具|收到|提出|申请|工作|出警|民警|负责|转送|所属|另一|[向由在的是与将后其某该到]');
const village = rule('([一-鿿]{1,5}?)(?:社区|行政村|村)');
const settlement = rule('(?:新区|开发区|园区|街道|镇|村|乡|县|区|市|省)$');
const addressLabel = rule('(?:户籍地址|户籍地|住址|住所地?|地址)(?:在|位于)?[：: ]*$');
const zone = rule('([一-鿿]{1,7}?)(?:开发区|园区)');
const mask = rule('[＊*×某Xx]');
const maskedRoad = rule('(?:(?:[＊*×某Xx]+)(?:大道|街道|路|街|巷|弄))+(?<door>\\d+(?:[-－]\\d+)?号)');
const floors = rule('(?:、[ \\t]*(?:地下)?\\d+(?:楼|层|室))+');
const ward = rule('(?:住院部|门诊部)(?:[一-鿿]{1,4}?科)?');
const residenceLabel = rule('(?:户籍地址|户籍地|住所地|住址)[：:]?');
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
      yield hit(...road.span('door'), 'address', '遮名道路中的门牌', 96);
      continue;
    }
    const office = localUnit.match(text, cursor) ?? REGIONAL_UNIT.match(text, cursor);
    if (office) {
      yield hit(start, office.value === '公安局' ? policeEnd(text, office.end()) : office.end(), 'organization', '地域与完整单位', 88);
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
  for (const row of territorialNames(text)) {
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
    if (row.kind === 'organization' && endsAny(value, ['医院', '病院'])) {
      const next = ward.match(text, row.end);
      if (next && !link.search(next.value)) result.push(hit(row.start, next.end(), row.kind, '具名医院科室', Math.max(69, row.priority)));
    }
    if (row.kind !== 'address') continue;
    const suffix = slice(value, 1);
    if (row.reason === 'Otter' && startsAny(value, ['到', '从', '往', '在']) && settlement.search(suffix) &&
        length(value) >= 4 && (lexicon.codes.has(suffix) || endsAny(value, ['新区', '街道']))) {
      result.push(hit(row.start + 1, row.end, row.kind, '去向与地域边界', row.priority + 1));
    }
    const label = row.reason === 'Otter' ? residenceLabel.match(value) : undefined;
    if (label && lexicon.initial.get(char(value, label.end()))?.some(term => slice(value, label.end()).startsWith(term))) {
      result.push(hit(row.start + label.end(), row.end, row.kind, '住所标签与地域边界', row.priority + 1));
    }
    if (value.endsWith('的') && settlement.search(slice(value, 0, -1))) {
      result.push(hit(row.start, row.end - 1, row.kind, '地域与所属助词', row.priority + 1));
    }
    const next = floorEnding.search(value) && floors.match(text, row.end);
    if (next) result.push(hit(row.start, next.end(), row.kind, '同址并列楼室', row.priority));
  }
  return result;
}
