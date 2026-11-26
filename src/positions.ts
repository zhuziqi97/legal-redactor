import type { Item, Span } from './model';

export type TextPiece<T> = { text: string; item?: T };

export function indexText(text: string) {
  const offsets = [0];
  const lines = [1];
  let units = 0;
  let line = 1;
  for (const character of text) {
    units += character.length;
    if (character === '\n') line++;
    offsets.push(units);
    lines.push(line);
  }
  return { offsets, lines, slice: (start: number, end: number) => text.slice(offsets[start], offsets[end]) };
}

export function textPieces(text: string, items: Item[], output = false) {
  const { offsets } = indexText(text);
  const pieces: TextPiece<Item>[] = [];
  let cursor = 0;
  for (const item of items) {
    const start = offsets[output ? item.output_start : item.start];
    const end = offsets[output ? item.output_end : item.end];
    if (start > cursor) pieces.push({ text: text.slice(cursor, start) });
    pieces.push({ text: text.slice(start, end), item });
    cursor = end;
  }
  if (cursor < text.length) pieces.push({ text: text.slice(cursor) });
  return pieces;
}

export function copyTextSelection(event: ClipboardEvent) {
  const selection = window.getSelection();
  const root = event.currentTarget as HTMLElement;
  if (!event.clipboardData || !selection || selection.isCollapsed || !selection.rangeCount) return;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return;
  event.clipboardData.setData('text/plain', range.toString());
  event.preventDefault();
}

export function rangePoint(root: HTMLElement, offset: number): [Node, number] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let last: Node | null = null;
  while (walker.nextNode()) {
    last = walker.currentNode;
    const length = last.textContent!.length;
    if (offset <= length) return [last, offset];
    offset -= length;
  }
  return last ? [last, last.textContent!.length] : [root, 0];
}

export function selectedSpan(root: HTMLElement): Span | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer) || !range.toString().trim()) return null;
  const preceding = document.createRange();
  preceding.selectNodeContents(root);
  preceding.setEnd(range.startContainer, range.startOffset);
  const start = Array.from(preceding.toString()).length;
  return { start, end: start + Array.from(range.toString()).length };
}
