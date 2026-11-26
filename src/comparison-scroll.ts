import { nextTick, watch, type Ref } from 'vue';
import type { ViewOptions } from './model';
import { rangePoint, type TextPiece } from './positions';

type Side = 0 | 1;
type Change = { start: [number, number]; end: [number, number] };

export function correspondingSpans<T>(source: TextPiece<T>[], result: TextPiece<T>[]) {
  const originals = new Map<T, [number, number]>();
  let offset = 0;
  for (const piece of source) {
    const end = offset + piece.text.length;
    if (piece.item !== undefined) originals.set(piece.item, [offset, end]);
    offset = end;
  }
  const changes: Change[] = [];
  offset = 0;
  for (const piece of result) {
    const end = offset + piece.text.length;
    const span = piece.item === undefined ? undefined : originals.get(piece.item);
    if (span) changes.push({ start: [span[0], offset], end: [span[1], end] });
    offset = end;
  }
  return changes;
}

function other(side: Side): Side { return side === 0 ? 1 : 0; }

function correspondingPosition(position: number, changes: Change[], from: Side) {
  const to = other(from);
  let displacement = 0;
  for (const change of changes) {
    if (position < change.start[from]) break;
    if (position < change.end[from]) {
      return change.start[to] + Math.min(position - change.start[from], Math.max(0, change.end[to] - change.start[to] - 1));
    }
    displacement = change.end[to] - change.end[from];
  }
  return position + displacement;
}

function lineAt(lines: HTMLCollection, comesBefore: (line: HTMLElement) => boolean) {
  let lo = 0;
  let hi = lines.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (comesBefore(lines[mid] as HTMLElement)) lo = mid + 1;
    else hi = mid;
  }
  return lines[Math.min(lo, lines.length - 1)] as HTMLElement | undefined;
}

function contentTop(pane: HTMLElement) {
  return pane.getBoundingClientRect().top + parseFloat(getComputedStyle(pane).paddingTop);
}

function positionAtTop(pane: HTMLElement) {
  const lines = pane.querySelector('.text-lines')?.children;
  if (!lines?.length || !pane.clientHeight) return undefined;
  const top = contentTop(pane);
  const line = lineAt(lines, row => row.getBoundingClientRect().bottom <= top + .5);
  if (!line) return undefined;
  const start = Number(line.dataset.textStart);
  const bounds = line.getBoundingClientRect();
  const lineHeight = parseFloat(getComputedStyle(line).lineHeight);
  if (top - bounds.top < lineHeight || bounds.height < 2 * lineHeight - .5) return start;

  // A long logical line can have many visual lines. Locate the text now
  // at the top of the pane so its counterpart can follow within that line.
  const body = line.firstElementChild;
  if (!body) return start;
  const x = Math.max(body.getBoundingClientRect().left, pane.getBoundingClientRect().left) + 1;
  const caret = document.caretRangeFromPoint(x, Math.min(bounds.bottom - 1, top + lineHeight / 2));
  if (!caret || !body.contains(caret.startContainer)) return start;
  const preceding = document.createRange();
  preceding.selectNodeContents(body);
  preceding.setEnd(caret.startContainer, caret.startOffset);
  return start + preceding.toString().length;
}

function topForPosition(pane: HTMLElement, position: number) {
  const lines = pane.querySelector('.text-lines')?.children;
  if (!lines?.length || !pane.clientHeight) return undefined;
  const next = lineAt(lines, row => Number(row.dataset.textStart) <= position)!;
  const containing = Number(next.dataset.textStart) > position
    ? next.previousElementSibling as HTMLElement | null ?? next
    : next;
  const top = containing.getBoundingClientRect().top;
  const offset = position - Number(containing.dataset.textStart);
  let visualTop = top;
  if (offset > 0) {
    const range = document.createRange();
    range.setStart(...rangePoint(containing, offset));
    range.collapse(true);
    const caret = range.getClientRects()[0];
    const lineHeight = parseFloat(getComputedStyle(containing).lineHeight);
    if (caret && lineHeight) visualTop += Math.max(0, Math.round((caret.top - top) / lineHeight)) * lineHeight;
  }
  return pane.scrollTop + visualTop - contentTop(pane);
}

export function useComparisonScroll(
  source: Ref<HTMLElement | undefined>, result: Ref<HTMLElement | undefined>,
  options: () => ViewOptions | undefined, canCompare: () => boolean, changes: () => Change[],
) {
  const panes = [source, result] as const;
  const lastTop = new WeakMap<HTMLElement, number>();
  let lastSide: Side = 0;

  const position = (side: Side) => {
    const pane = panes[side].value;
    return pane && positionAtTop(pane);
  };
  function rememberScroll() {
    for (const ref of panes) {
      const pane = ref.value;
      if (pane) lastTop.set(pane, pane.scrollTop);
    }
  }
  function goTo(side: Side, position: number) {
    const pane = panes[side].value;
    if (!pane) return;
    const top = topForPosition(pane, position);
    if (top !== undefined) {
      pane.scrollTop = top;
      lastTop.set(pane, pane.scrollTop);
    }
  }
  function follow(from: Side) {
    if (!options()?.sync || !canCompare()) return;
    const current = position(from);
    if (current !== undefined) goTo(other(from), correspondingPosition(current, changes(), from));
  }
  function onScroll(side: Side) {
    const pane = panes[side].value;
    if (!pane || lastTop.get(pane) === pane.scrollTop) return;
    lastTop.set(pane, pane.scrollTop);
    lastSide = side;
    follow(side);
  }
  watch(options, async (next, before) => {
    if (!next) return;
    const reflow = next.wrap !== before?.wrap || next.lineNumbers !== before?.lineNumbers;
    if (reflow) {
      const left = position(0);
      const right = position(1);
      await nextTick();
      if (left !== undefined) goTo(0, left);
      if (right !== undefined) goTo(1, right);
    }
    if (next.sync && (!before?.sync || reflow)) follow(lastSide);
  });
  return { onScroll, rememberScroll, position, goTo, follow };
}
