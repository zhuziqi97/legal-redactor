export type Span = [start: number, end: number];

const supplementary = /[\uD800-\uDBFF][\uDC00-\uDFFF]/;
type TextIndex = {units?: number[]; breaks?: number[]};
const recentIndexes = new Map<string, TextIndex>();

function textIndex(text: string) {
  const prior = recentIndexes.get(text);
  if (prior) return prior;
  const index: TextIndex = {};
  if (supplementary.test(text)) {
    const units = [0];
    for (const char of text) units.push(units[units.length - 1] + char.length);
    index.units = units;
  }
  if (recentIndexes.size >= 16) recentIndexes.delete(recentIndexes.keys().next().value!);
  recentIndexes.set(text, index);
  return index;
}

function offsets(text: string) {
  if (text.length < 128 && !supplementary.test(text)) return undefined;
  return textIndex(text).units;
}

export function bisect(values: number[], value: number, right = false) {
  let left = 0;
  let end = values.length;
  while (left < end) {
    const mid = Math.floor((left + end) / 2);
    if (values[mid] < value || (right && values[mid] === value)) left = mid + 1;
    else end = mid;
  }
  return left;
}

export function length(text: string) {
  const index = offsets(text);
  return index ? index.length - 1 : text.length;
}

export function unit(text: string, position: number) {
  const index = offsets(text);
  const size = index ? index.length - 1 : text.length;
  const at = Math.min(Math.max(position < 0 ? size + position : position, 0), size);
  return index?.[at] ?? at;
}

export function point(text: string, offset: number) {
  const index = offsets(text);
  return index ? bisect(index, offset) : offset;
}

export function slice(text: string, start = 0, end = length(text)) {
  return text.slice(unit(text, start), unit(text, end));
}

export function char(text: string, position: number) {
  const at = position < 0 ? length(text) + position : position;
  return at < 0 || at >= length(text) ? '' : slice(text, at, at + 1);
}

export function indexOf(text: string, value: string, from = 0) {
  const at = text.indexOf(value, unit(text, from));
  return at < 0 ? -1 : point(text, at);
}

export function lineNumber(text: string, at: number) {
  const index = textIndex(text);
  if (!index.breaks) {
    index.breaks = [];
    for (let offset = text.indexOf('\n'); offset >= 0; offset = text.indexOf('\n', offset + 1)) {
      index.breaks.push(index.units ? bisect(index.units, offset) : offset);
    }
  }
  return bisect(index.breaks, at) + 1;
}

const whitespace = '\\u0009-\\u000d\\u001c-\\u0020\\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const space = new RegExp(`^[${whitespace}]$`, 'u');
const word = '\\p{L}\\p{N}_';

function regExpSource(source: string) {
  let output = '';
  let inClass = false;
  for (let i = 0; i < source.length; i++) {
    const current = source[i];
    if (current === '\\') {
      const next = source[++i];
      if (next === 'd') output += '\\p{Nd}';
      else if (next === 'D') output += '\\P{Nd}';
      else if (next === 's') output += inClass ? whitespace : `[${whitespace}]`;
      else if (next === 'S' && !inClass) output += `[^${whitespace}]`;
      else if (next === 'w') output += inClass ? word : `[${word}]`;
      else if (next === 'W' && !inClass) output += `[^${word}]`;
      else if (next === 'b' && !inClass) output += `(?:(?<![${word}])(?=[${word}])|(?<=[${word}])(?![${word}]))`;
      else if (next === 'A') output += '(?<![\\s\\S])';
      else if (next === 'Z' || next === 'z') output += '(?![\\s\\S])';
      else if (next === '-') output += '\\x2d';
      else if ('"\' #,:!'.includes(next)) output += next;
      else output += current + next;
      continue;
    }
    if (current === '[') inClass = true;
    else if (current === ']') inClass = false;
    output += current;
  }
  return output.replace(/\(\?P</g, '(?<').replace(/\(\?P=([a-zA-Z_]\w*)\)/g, '\\k<$1>');
}

export class Match {
  constructor(readonly text: string, private readonly result: RegExpExecArray) {}

  get value() { return this.result[0]; }
  group(key: number | string = 0): string | undefined {
    return typeof key === 'number' ? this.result[key] : this.result.groups?.[key];
  }
  span(key: number | string = 0): Span {
    const raw = typeof key === 'number' ? this.result.indices?.[key] : this.result.indices?.groups?.[key];
    return raw ? [point(this.text, raw[0]), point(this.text, raw[1])] : [-1, -1];
  }
  start(key: number | string = 0) { return this.span(key)[0]; }
  end(key: number | string = 0) { return this.span(key)[1]; }
}

export class Rule {
  private readonly source: string;
  private readonly flags: string;
  private readonly full: RegExp;

  constructor(readonly pattern: string, flags = '') {
    const prefix = /^\(\?([ims]+)\)/.exec(pattern);
    this.flags = [...new Set(`du${flags}${prefix?.[1] ?? ''}`)].join('');
    this.source = regExpSource(prefix ? pattern.slice(prefix[0].length) : pattern);
    this.full = new RegExp(`(?:${this.source})(?![\\s\\S])`, `${this.flags}y`);
  }

  search(text: string, start = 0, end = length(text)) {
    const expression = new RegExp(this.source, `${this.flags}g`);
    expression.lastIndex = unit(text, start);
    const match = expression.exec(text.slice(0, unit(text, end)));
    return match ? new Match(text, match) : undefined;
  }

  match(text: string, start = 0, end = length(text)) {
    const expression = new RegExp(this.source, `${this.flags}y`);
    expression.lastIndex = unit(text, start);
    const match = expression.exec(text.slice(0, unit(text, end)));
    return match ? new Match(text, match) : undefined;
  }

  fullmatch(text: string, start = 0, end = length(text)) {
    this.full.lastIndex = unit(text, start);
    const match = this.full.exec(text.slice(0, unit(text, end)));
    return match ? new Match(text, match) : undefined;
  }

  *finditer(text: string, start = 0, end = length(text)) {
    const expression = new RegExp(this.source, `${this.flags}g`);
    expression.lastIndex = unit(text, start);
    const input = text.slice(0, unit(text, end));
    for (const match of input.matchAll(expression)) yield new Match(text, match);
  }

  test(text: string) { return this.search(text) !== undefined; }

  replace(text: string, value: string) {
    return text.replace(new RegExp(this.source, `${this.flags}g`), value);
  }
}

export const rule = (pattern: string, flags?: string) => new Rule(pattern, flags);
export const ascii = (text: string) => /^[\x00-\x7f]*$/.test(text);
export const digits = (text: string) => /^\p{Nd}+$/u.test(text);
export const startsAny = (text: string, prefixes: readonly string[]) => prefixes.some(prefix => text.startsWith(prefix));
export const endsAny = (text: string, suffixes: readonly string[]) => suffixes.some(suffix => text.endsWith(suffix));
export const keyOf = (...values: unknown[]) => JSON.stringify(values);
export const escape = (text: string) => text.replace(/[.*+?^$\{\}()|\[\]\\]/g, '\\$&');

export function trim(text: string, allowed?: string, side: 'both' | 'left' | 'right' = 'both') {
  const removable = (value: string) => allowed === undefined ? space.test(value) : value !== '' && allowed.includes(value);
  let first = 0;
  let last = length(text);
  if (side !== 'right') while (first < last && removable(char(text, first))) first++;
  if (side !== 'left') while (last > first && removable(char(text, last - 1))) last--;
  return slice(text, first, last);
}
