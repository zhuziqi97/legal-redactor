import { ADDRESS_DETAIL, ORG_END, PREMISE, TITLE } from './field-rules.js';
import { administrativeParts } from './fields.js';
import { BRANCH_TYPE, NUMBERED_TYPE, OFFICE_TYPE, PARTY_OFFICE, REGIONAL_UNIT } from './organizations.js';
import { letters, phrases } from './pinyin-data.js';
import { COMPOUND_SURNAMES } from './suspect-rules.js';
import { hasSurname } from './suspects.js';
import { char, endsAny, length, rule, slice, trim } from './text.js';

const initials = new Map(Object.entries(letters).flatMap(([letter, values]) => [...values].map(value => [value, letter])));
const road = rule('([\\u3400-\\u9fffA-Za-z]{1,16}?)(大道|街道|路|街|巷|弄)');
const placeName = rule('[\\u3400-\\u9fff]{2,12}');

export function initial(value: string) {
  const first = char(value, 0);
  if (/^[a-zA-Z]$/.test(first)) return first.toUpperCase();
  const phrase = phrases[first]?.find(([candidate]) => value.startsWith(candidate));
  return phrase?.[1] ?? initials.get(first) ?? '';
}

const business = rule('(贸易|物流|饮食服务|健康管理|商贸|矿业|机电|理工)(有限公司|有限责任公司|公司|学院|大学)$');
const branchName = rule(`(.+?(?:银行|集团|公司|学院|大学|医院))(.+?)(${BRANCH_TYPE})`);
const publicBanks = new Map([['中国人民银行', '中国人民银行'], ['中国建设银行', '建设银行'], ['建设银行', '建设银行']]);
const officeType = rule(`(?:${OFFICE_TYPE}|${NUMBERED_TYPE})$`);

type Areas = Map<string, string>;

function areaParts(value: string, areas: Areas, parts: Areas): [string, number] {
  const labels: string[] = [];
  let end = 0;
  for (const [stem, suffix, , stop] of administrativeParts(value)) {
    if (labels.length && suffix === '小区') break;
    const raw = stem + suffix;
    const letter = stem === '长宁' ? 'C' : initial(stem);
    let label = areas.get(raw);
    if (!label) {
      const used = new Set(areas.values());
      label = letter + suffix;
      let index = 1;
      while (used.has(label)) label = letter + index++ + suffix;
      areas.set(raw, label);
    }
    parts.set(raw, label);
    labels.push(label);
    end = stop;
  }
  return [labels.join(''), end];
}

function shortArea(value: string, areas: Areas, parts: Areas, complete = false): [string, number] {
  const matches = [...areas].filter(([raw]) => {
    const stem = slice(raw, 0, -1);
    return endsAny(raw, ['市', '省', '区', '县']) && (complete ? value === stem : value.startsWith(stem));
  });
  if (matches.length !== 1) return ['', 0];
  const [[raw, label]] = matches;
  parts.set(raw, label);
  return [label, length(raw) - 1];
}

export function displayBase(kind: string, value: string, fallback: string,
  areas: Areas = new Map(), parts: Areas = new Map()): [base: string, firstNumber: number] {
  if (kind === 'person' && hasSurname(value) && !TITLE.fullmatch(value) && !/[·・]/u.test(value)) {
    return [(COMPOUND_SURNAMES.find(name => value.startsWith(name)) ?? char(value, 0)) + '某', 1];
  }
  if (kind !== 'address' && kind !== 'organization') return [fallback, 1];
  if (kind === 'organization') {
    const party = PARTY_OFFICE.fullmatch(value);
    if (party) {
      const region = party.group('region')!;
      const [label, end] = areaParts(region, areas, parts);
      if (end === length(region)) return [label + party.group('unit')!, 0];
    }
    const branch = branchName.fullmatch(value);
    if (branch) {
      const parent = branch.group(1)!;
      const region = branch.group(2)!;
      let [label, end] = areaParts(region, areas, parts);
      if (!label) [label, end] = shortArea(region, areas, parts, true);
      if (label && end === length(region)) {
        const type = ORG_END.search(parent);
        const parentLabel = publicBanks.get(parent) ?? (type ? initial(parent) + type.value : '机构');
        return [parentLabel + label + branch.group(3)!, 0];
      }
    }
  }
  let [area, end] = areaParts(value, areas, parts);
  if (kind === 'organization') {
    if (!area) [area, end] = shortArea(value, areas, parts);
    const body = slice(value, end);
    if (area) {
      if (REGIONAL_UNIT.fullmatch(body)) return [area + body, 0];
      const activity = business.search(body);
      if (activity) return [area + activity.value, 0];
    }
    const unit = ORG_END.search(value) ?? officeType.search(value);
    if (unit) {
      const body = slice(value, end, unit.start());
      if (area && ['', '人民'].includes(body)) return [area + unit.value, 0];
      const letter = initial(body || slice(value, 0, unit.start()));
      if (letter && letter + unit.value !== value) return [letter + unit.value, 0];
    }
    const letter = initial(value);
    return letter ? [letter + fallback, 0] : [fallback, 1];
  }
  if (!area) [area, end] = shortArea(value, areas, parts, true);
  if (area) return end === length(value) ? [area, 0] : [area + '地址', 1];
  const match = road.match(value);
  if (match) return [initial(match.group(1)!) + match.group(2) + '地址', 1];
  if (ADDRESS_DETAIL.fullmatch(trim(value))) return ['房址', 1];
  const site = PREMISE.match(value);
  if (site) return [initial(site.group(1)!) + site.group(2) + '地址', 1];
  if (placeName.fullmatch(value)) {
    const letter = initial(value);
    if (letter) return [letter + '地', 0];
  }
  return [fallback, 1];
}

export function availableDisplay(base: string, number: number, used: Set<string>, text = '') {
  for (;;) {
    const code = `【${base}${number || ''}】`;
    if (!used.has(code) && !text.includes(code)) return code;
    number++;
  }
}

export function projectAreas(groups: Iterable<{kind: string; value: string; replacement: string; areas?: Record<string, string>}>) {
  const areas: Areas = new Map();
  for (const {kind, value, replacement, areas: parts} of groups) {
    for (const [region, label] of Object.entries(parts ?? {})) {
      if (!areas.has(region)) areas.set(region, label);
    }
    if (parts || kind !== 'address' || areas.has(value) || !/^【[A-Z][0-9]*(?:省|市|区|县)】$/u.test(replacement)) continue;
    const first = administrativeParts(value).next().value;
    if (first?.[3] === length(value) && replacement.endsWith(first[1] + '】')) {
      areas.set(value, slice(replacement, 1, -1));
    }
  }
  return areas;
}
