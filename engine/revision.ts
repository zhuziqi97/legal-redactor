import type { Relation } from './context.js';
import type { Layout } from './fields.js';
import { anonymousBranchMention, publishedOrganizationSpans } from './phrases.js';
import { bisect, keyOf, length, type Span } from './text.js';

type Opcode = 'equal' | 'replace' | 'insert' | 'delete';
type Block = [kind: Opcode, oldStart: number, oldEnd: number, newStart: number, newEnd: number];
type Match = [oldStart: number, newStart: number, size: number];

function matchingBlocks(before: string[], after: string[], autoJunk: boolean) {
  const positions = new Map<string, number[]>();
  after.forEach((token, index) => {
    if (!positions.has(token)) positions.set(token, []);
    positions.get(token)!.push(index);
  });
  // SequenceMatcher omits very frequent tokens as anchors on long inputs.
  if (autoJunk && after.length >= 200) {
    const limit = Math.floor(after.length / 100) + 1;
    for (const [token, matches] of positions) if (matches.length > limit) positions.delete(token);
  }
  function longest(a: number, b: number, c: number, d: number): Match {
    let old = a;
    let next = c;
    let size = 0;
    let previous = new Map<number, number>();
    for (let left = a; left < b; left++) {
      const current = new Map<number, number>();
      for (const right of positions.get(before[left]) ?? []) {
        if (right < c) continue;
        if (right >= d) break;
        const run = (previous.get(right - 1) ?? 0) + 1;
        current.set(right, run);
        if (run > size) {
          old = left - run + 1;
          next = right - run + 1;
          size = run;
        }
      }
      previous = current;
    }
    while (old > a && next > c && before[old - 1] === after[next - 1]) {
      old--;
      next--;
      size++;
    }
    while (old + size < b && next + size < d && before[old + size] === after[next + size]) size++;
    return [old, next, size];
  }
  const ranges: [number, number, number, number][] = [[0, before.length, 0, after.length]];
  const found: Match[] = [];
  while (ranges.length) {
    const [a, b, c, d] = ranges.pop()!;
    const [left, right, size] = longest(a, b, c, d);
    if (!size) continue;
    found.push([left, right, size]);
    if (a < left && c < right) ranges.push([a, left, c, right]);
    if (left + size < b && right + size < d) ranges.push([left + size, b, right + size, d]);
  }
  const matches: Match[] = [];
  for (const [left, right, size] of found.sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
    const last = matches.at(-1);
    if (last && last[0] + last[2] === left && last[1] + last[2] === right) last[2] += size;
    else matches.push([left, right, size]);
  }
  matches.push([before.length, after.length, 0]);
  return matches;
}

function* opcodes(before: string[], after: string[], autoJunk: boolean): Generator<Block> {
  let old = 0;
  let next = 0;
  for (const [left, right, size] of matchingBlocks(before, after, autoJunk)) {
    if (old < left && next < right) yield ['replace', old, left, next, right];
    else if (old < left) yield ['delete', old, left, next, right];
    else if (next < right) yield ['insert', old, left, next, right];
    old = left + size;
    next = right + size;
    if (size) yield ['equal', left, old, right, next];
  }
}

const lines = (text: string) => text.match(/[^\r\n\v\f\x1c-\x1e\x85\u2028\u2029]*(?:\r\n|[\r\n\v\f\x1c-\x1e\x85\u2028\u2029])|[^\r\n\v\f\x1c-\x1e\x85\u2028\u2029]+$/gu) ?? [];

const offsets = (lines: string[]) => {
  const result = [0];
  for (const line of lines) result.push(result.at(-1)! + length(line));
  return result;
};

export function* revisionBlocks(old: string, next: string): Generator<Block> {
  const before = lines(old);
  const after = lines(next);
  const starts = offsets(before);
  const targets = offsets(after);
  for (const [kind, a, b, c, d] of opcodes(before, after, true)) {
    if (kind !== 'replace' || b - a !== d - c) {
      yield [kind, starts[a], starts[b], targets[c], targets[d]];
      continue;
    }
    for (let left = a, right = c; left < b; left++, right++) {
      const oldLength = starts[left + 1] - starts[left];
      const newLength = targets[right + 1] - targets[right];
      if (Math.max(oldLength, newLength) > 1024) {
        yield ['replace', starts[left], starts[left + 1], targets[right], targets[right + 1]];
        continue;
      }
      for (const [op, i, j, x, y] of opcodes([...before[left]], [...after[right]], false)) {
        yield [op, starts[left] + i, starts[left] + j, targets[right] + x, targets[right] + y];
      }
    }
  }
}

export function project(blocks: Block[], start: number, end: number): [number, number, boolean] | null {
  const ranges: [number, number][] = [];
  let unchanged = true;
  for (const [kind, a, b, x, y] of blocks) {
    if (kind === 'insert') {
      if (start < a && a < end) {
        ranges.push([x, y]);
        unchanged = false;
      }
    } else if (start < b && a < end) {
      if (kind === 'equal') ranges.push([x + Math.max(start - a, 0), y - Math.max(b - end, 0)]);
      else {
        unchanged = false;
        if (x < y) ranges.push([x, y]);
      }
    }
  }
  return ranges.length ? [ranges[0][0], ranges.at(-1)![1], unchanged] : null;
}

export function revisionRanges(original: string, text: string, blocks: Block[], before: Layout, after: Layout): Span[] {
  const starts = offsets(lines(text));
  const ranges: Span[] = [];
  const addLines = (start: number, end: number) => {
    const a = Math.min(starts.length - 2, bisect(starts, start, true) - 1);
    const b = end > start ? bisect(starts, end) : a + 1;
    if (a >= 0) ranges.push([starts[a], starts[Math.min(starts.length - 1, Math.max(a + 1, b))]]);
  };
  for (const [kind, , , start, end] of blocks) {
    if (kind !== 'equal') addLines(start, end);
  }

  // A changed heading or label can change the meaning of untouched text.
  // Compare each structural result after moving its old range to the new text.
  function compare<T extends {start: number; end: number}>(old: T[], next: T[], meaning: (value: T) => string) {
    const remaining = new Map(next.map(row => [keyOf(row.start, row.end, meaning(row)), row]));
    for (const row of old) {
      const moved = project(blocks, row.start, row.end);
      if (moved?.[2] && !remaining.delete(keyOf(moved[0], moved[1], meaning(row)))) addLines(moved[0], moved[1]);
    }
    for (const row of remaining.values()) addLines(row.start, row.end);
  }
  compare(before.free, after.free, row => row.context);
  compare(before.hits, after.hits, row => keyOf(row.kind, row.reason, row.priority, row.needs_context));
  // A changed declaration also changes recognition at its other occurrences.
  const published = (value: string) => publishedOrganizationSpans(value).map(([start, end]) => ({start, end}));
  compare(published(original), published(text), () => '');

  const answers = [
    ...after.answers.map(([question, answer]): Span => [question[0], answer[1]]),
    ...before.answers.flatMap(([question, answer]) => {
      const moved = project(blocks, question[0], answer[1]);
      return moved ? [[moved[0], moved[1]] as Span] : [];
    }),
  ];
  for (const [start, end] of answers) {
    if (ranges.some(([a, b]) => a < end && start < b)) addLines(start, end);
  }

  // An untouched repetition can supply the only model evidence for a masked parent.
  const affected = ([start, end]: Span) => ranges.some(([a, b]) => a < end && start < b);
  const branchMentions = (value: string) => [...anonymousBranchMention.finditer(value)]
    .map(match => ({name: match.group('mention')!, span: match.span('mention')}));
  const mentions = branchMentions(text);
  const related = new Set(mentions.filter(mention => affected(mention.span)).map(mention => mention.name));
  for (const mention of branchMentions(original)) {
    const moved = project(blocks, ...mention.span);
    if (!moved?.[2] || affected([moved[0], moved[1]])) related.add(mention.name);
  }
  for (const mention of mentions) {
    if (related.has(mention.name)) ranges.push(mention.span);
  }

  const merged: Span[] = [];
  for (const range of ranges.sort((a, b) => a[0] - b[0])) {
    const last = merged.at(-1);
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push(range);
  }
  return merged;
}

export function projectRelation(blocks: Block[], link: Relation): Relation | null {
  const core = project(blocks, link.start, link.end);
  const subject = project(blocks, link.subject_start, link.subject_start + 1);
  const object = project(blocks, link.object_start, link.object_start + 1);
  if (!core?.[2] || !subject?.[2] || !object?.[2]) return null;
  const moved = {...link, start: core[0], end: core[1], subject_start: subject[0], object_start: object[0]};
  for (const [a, b] of [['statement_start', 'statement_end'], ['question_start', 'question_end']] as const) {
    if (link[a] === undefined || link[b] === undefined) continue;
    const range = project(blocks, link[a], link[b]);
    if (!range?.[2]) return null;
    [moved[a], moved[b]] = range;
  }
  return moved;
}
