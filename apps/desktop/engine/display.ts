import { ADDRESS_DETAIL, ORG_END, PREMISE, TITLE } from './field-rules.js';
import { administrativeParts } from './fields.js';
import { letters, phrases } from './pinyin-data.js';
import { COMPOUND_SURNAMES } from './suspect-rules.js';
import { hasSurname } from './suspects.js';
import { char, length, rule, slice, trim } from './text.js';

const initials = new Map(Object.entries(letters).flatMap(([letter, values]) => [...values].map(value => [value, letter])));
const road = rule('([\\u3400-\\u9fffA-Za-z]{1,16}?)(大道|街道|路|街|巷|弄)');
const placeName = rule('[\\u3400-\\u9fff]{2,12}');

export function initial(value: string) {
  const first = char(value, 0);
  if (/^[a-zA-Z]$/.test(first)) return first.toUpperCase();
  const phrase = phrases[first]?.find(([candidate]) => value.startsWith(candidate));
  return phrase?.[1] ?? initials.get(first) ?? '';
}

export function displayBase(kind: string, value: string, fallback: string): [base: string, firstNumber: number] {
  if (kind === 'person' && hasSurname(value) && !TITLE.fullmatch(value) && !/[·・]/u.test(value)) {
    return [(COMPOUND_SURNAMES.find(name => value.startsWith(name)) ?? char(value, 0)) + '某', 0];
  }
  if (kind !== 'address' && kind !== 'organization') return [fallback, 1];
  let area = '';
  let end = 0;
  for (const [stem, suffix, , stop] of administrativeParts(value)) {
    if (area && suffix === '小区') break;
    area += (stem === '长宁' ? 'C' : initial(stem)) + suffix;
    end = stop;
  }
  if (kind === 'organization') {
    const unit = ORG_END.search(value);
    if (unit) {
      const body = slice(value, end, unit.start());
      if (area && ['', '人民'].includes(body)) return [area + unit.value, 0];
      const letter = initial(body || slice(value, 0, unit.start()));
      if (letter && letter + unit.value !== value) return [letter + unit.value, 0];
    }
    const letter = initial(value);
    return letter ? [letter + fallback, 0] : [fallback, 1];
  }
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
