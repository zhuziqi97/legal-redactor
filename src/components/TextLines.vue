<script setup lang="ts" generic="T">
import { computed } from 'vue';
import type { TextPiece } from '../positions';

type Line = { start: number; parts: (TextPiece<T> & { continued: boolean })[]; newline: string };
const props = defineProps<{ pieces: TextPiece<T>[]; numbers: boolean; newlines: boolean }>();
const lines = computed(() => {
  const text = props.pieces.map(piece => piece.text).join('');
  const lines: Line[] = [];
  const seen = new Set<T>();
  let pieceIndex = 0;
  let offset = 0;
  let pieceOffset = 0;

  function advance(end: number, line?: Line) {
    while (offset < end) {
      const piece = props.pieces[pieceIndex];
      const take = Math.min(end - offset, piece.text.length - pieceOffset);
      if (take && line) {
        const continued = piece.item !== undefined && seen.has(piece.item);
        line.parts.push({ text: piece.text.slice(pieceOffset, pieceOffset + take), item: piece.item, continued });
        if (piece.item !== undefined) seen.add(piece.item);
      }
      offset += take;
      pieceOffset += take;
      if (pieceOffset === piece.text.length) {
        pieceIndex++;
        pieceOffset = 0;
      }
    }
  }

  for (const ending of text.matchAll(/\r\n|[\r\n]/gu)) {
    const line = { start: offset, parts: [], newline: ending[0] };
    advance(ending.index, line);
    advance(ending.index + ending[0].length);
    lines.push(line);
  }
  const last = { start: offset, parts: [], newline: '' };
  advance(text.length, last);
  lines.push(last);
  return lines;
});
</script>

<template>
  <div class="text-lines" :class="{ 'with-line-numbers': numbers, 'with-line-breaks': newlines }"
    :style="{ '--line-number-digits': String(lines.length).length }">
    <div v-for="(line, index) in lines" :key="index" class="text-line" :data-text-start="line.start" :data-line-number="index + 1">
      <div class="text-line-body"><template v-for="(piece, part) in line.parts" :key="part"><slot
        v-if="piece.item !== undefined" name="mark" :item="piece.item" :text="piece.text" :continued="piece.continued"
      >{{ piece.text }}</slot><template v-else>{{ piece.text }}</template></template><span v-if="line.newline" class="line-break">{{ line.newline }}</span></div>
    </div>
  </div>
</template>
