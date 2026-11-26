import { nextTick, onMounted, onUnmounted, watch, type Ref } from 'vue';
import type { Span, ViewOptions } from './model';
import { rangePoint, type TextPiece } from './positions';

type Side = 0 | 1;
type Change = { start: [number, number]; end: [number, number] };
type LineFocus = 'hover' | 'active' | 'selection';

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

function correspondingPosition(position: number, changes: Change[], from: Side, edge?: 'start' | 'end') {
  const to = other(from);
  let displacement = 0;
  for (const change of changes) {
    if (position < change.start[from]) break;
    if (position < change.end[from]) {
      if (edge === 'start') return change.start[to];
      if (edge === 'end') return Math.max(change.start[to], change.end[to] - 1);
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

function lineContaining(lines: HTMLCollection, position: number) {
  const next = lineAt(lines, row => Number(row.dataset.textStart) <= position);
  return next && Number(next.dataset.textStart) > position
    ? next.previousElementSibling as HTMLElement | null ?? next
    : next;
}

function linesForSpan(pane: HTMLElement | undefined, span: Span) {
  const lines = pane?.querySelector('.text-lines')?.children;
  if (!lines?.length) return [];
  const first = lineContaining(lines, span.start);
  const last = lineContaining(lines, Math.max(span.start, span.end - 1));
  const rows: HTMLElement[] = [];
  for (let row = first ?? null; row; row = row.nextElementSibling as HTMLElement | null) {
    rows.push(row);
    if (row === last) break;
  }
  return rows;
}

function lineSpan(row: HTMLElement): Span {
  const start = Number(row.dataset.textStart);
  const next = row.nextElementSibling as HTMLElement | null;
  return { start, end: next ? Number(next.dataset.textStart) : start + (row.textContent?.length ?? 0) };
}

function closestLine(node: Node | null) {
  return (node instanceof Element ? node : node?.parentElement)?.closest<HTMLElement>('.text-line');
}

function selectionOffset(root: HTMLElement, node: Node, offset: number) {
  const row = closestLine(node);
  const prefix = document.createRange();
  prefix.selectNodeContents(row ?? root);
  prefix.setEnd(node, offset);
  return Number(row?.dataset.textStart ?? 0) + prefix.toString().length;
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
  const containing = lineContaining(lines, position)!;
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

export function useComparison(
  source: Ref<HTMLElement | undefined>, result: Ref<HTMLElement | undefined>,
  options: () => ViewOptions | undefined, canCompare: () => boolean, changes: () => Change[],
) {
  const panes = [source, result] as const;
  const lastTop = new WeakMap<HTMLElement, number>();
  let lastSide: Side = 0;
  let focusedRows = new Set<HTMLElement>();
  let focus: LineFocus | undefined;
  let hovered: HTMLElement | undefined;

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

  function clearLines() {
    for (const row of focusedRows) delete row.dataset.lineFocus;
    focusedRows.clear();
    focus = undefined;
    hovered = undefined;
  }
  function focusLines(side: Side, span: Span, kind: LineFocus) {
    if (!canCompare()) return [];
    const edits = changes();
    const start = correspondingPosition(span.start, edits, side, 'start');
    // Include the whole replacement at either edge, using the last selected
    // character so a selection ending before a new line does not include it.
    const end = span.start === span.end ? start : correspondingPosition(span.end - 1, edits, side, 'end') + 1;
    const counterpart = linesForSpan(panes[other(side)].value, { start, end });
    const rows = new Set([...linesForSpan(panes[side].value, span), ...counterpart]);
    const style = kind === 'hover' ? 'hover' : 'active';
    for (const row of focusedRows) if (!rows.has(row)) delete row.dataset.lineFocus;
    for (const row of rows) if (row.dataset.lineFocus !== style) row.dataset.lineFocus = style;
    focusedRows = rows;
    focus = kind;
    return counterpart;
  }
  function leaveLine() {
    if (focus === 'hover') clearLines();
  }
  function hoverLine(side: Side, event: PointerEvent) {
    if (!canCompare() || event.pointerType === 'touch' || focus === 'active' || focus === 'selection') return;
    const row = closestLine(event.target as Node);
    if (!row) { leaveLine(); return; }
    if (row === hovered) return;
    hovered = row;
    focusLines(side, lineSpan(row), 'hover');
  }
  function clickLine(side: Side, event: MouseEvent) {
    if (!canCompare() || window.getSelection()?.isCollapsed === false) return;
    // A marked token uses the same path as navigation from the mapping list.
    if (event.target instanceof Element && event.target.closest('mark')) return;
    const row = closestLine(event.target as Node);
    if (!row) return;
    const counterparts = focusLines(side, lineSpan(row), 'active');
    const pane = panes[other(side)].value;
    if (!options()?.sync || !pane || !counterparts.length) return;
    const viewportTop = pane.getBoundingClientRect().top + pane.clientTop;
    const viewportBottom = viewportTop + pane.clientHeight;
    const top = counterparts[0].getBoundingClientRect().top;
    const bottom = counterparts[counterparts.length - 1].getBoundingClientRect().bottom;
    if (top >= viewportBottom) pane.scrollTop += Math.min(top - viewportTop, bottom - viewportBottom);
    else if (bottom <= viewportTop) pane.scrollTop += Math.max(top - viewportTop, bottom - viewportBottom);
    lastTop.set(pane, pane.scrollTop);
  }
  function trackSelection() {
    if (!canCompare()) return;
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && selection.rangeCount) {
      const range = selection.getRangeAt(0);
      for (const side of [0, 1] as const) {
        const root = panes[side].value?.querySelector<HTMLElement>('.text-lines');
        if (!root?.contains(range.startContainer) || !root.contains(range.endContainer)) continue;
        const start = selectionOffset(root, range.startContainer, range.startOffset);
        const end = selectionOffset(root, range.endContainer, range.endOffset);
        if (start < end) focusLines(side, { start, end }, 'selection');
        return;
      }
    }
    if (focus === 'selection') clearLines();
  }
  function escape(event: KeyboardEvent) {
    if (event.key === 'Escape' && focus && !event.defaultPrevented && !document.querySelector('dialog[open]')) clearLines();
  }
  watch([canCompare, changes], clearLines);
  onMounted(() => {
    document.addEventListener('selectionchange', trackSelection);
    window.addEventListener('keydown', escape);
  });
  onUnmounted(() => {
    document.removeEventListener('selectionchange', trackSelection);
    window.removeEventListener('keydown', escape);
  });

  watch(options, async (next, before) => {
    if (!next) return;
    const reflow = next.wrap !== before?.wrap || next.lineNumbers !== before?.lineNumbers
      || next.font !== before?.font || next.fontSize !== before?.fontSize;
    if (reflow) {
      const left = position(0);
      const right = position(1);
      await nextTick();
      if (left !== undefined) goTo(0, left);
      if (right !== undefined) goTo(1, right);
    }
    if (next.sync && (!before?.sync || reflow)) follow(lastSide);
  });
  return {
    onScroll, rememberScroll, position, goTo, follow, hoverLine, leaveLine, clickLine,
    pinLines: (side: Side, span: Span) => focusLines(side, span, 'active'),
  };
}
