<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { categoryColor, labels, type Item, type Material, type Span } from '../model';
import { indexText, rangePoint, selectedSpan, textPieces } from '../positions';

const props = defineProps<{
  material: Material | null; address: string; selected: number | null; canOutput: boolean; showQuick: boolean;
  active: boolean;
}>();
const emit = defineEmits<{ select: [id: number]; selection: [span: Span | null]; dismiss: []; output: [kind: 'copy' | 'file'] }>();
const reader = ref<HTMLElement>();
const source = ref<HTMLElement>();
const sourceScroll = ref<HTMLElement>();
const outputScroll = ref<HTMLElement>();
const findInput = ref<HTMLInputElement>();
const quickAnchor = ref({ left: 0, top: 0 });
const findOpen = ref(false);
const query = ref('');
const matchIndex = ref(0);
const index = computed(() => indexText(props.material?.text || ''));
const sourceParts = computed(() => textPieces(props.material?.text || '', props.material?.items || []));
const previousOutput = computed(() => props.material?.previousOutput);
const outputParts = computed(() => previousOutput.value ? textPieces(previousOutput.value, [], true)
  : textPieces(props.material?.output || '', props.material?.items || [], true));

const matches = computed(() => {
  const text = props.material?.text || '';
  const needle = query.value;
  const result: Span[] = [];
  if (!needle) return result;
  for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + needle.length)) {
    result.push({ start: at, end: at + needle.length });
  }
  return result;
});

function classes(item: Item) {
  return [categoryColor(item.type), {
    selected: props.selected === item.id, keep: item.action === 'keep', 'review-state': item.action === 'review',
  }];
}

function itemLabel(item: Item, text: string) {
  return `${text}，${labels[item.type]}，第 ${index.value.lines[item.start]} 行`;
}

function placeQuick(rect: DOMRect) {
  const bounds = reader.value?.getBoundingClientRect();
  if (!bounds) return;
  quickAnchor.value = {
    left: Math.max(6, Math.min(rect.left - bounds.left, bounds.width - 6)),
    top: Math.max(50, Math.min(rect.bottom - bounds.top + 8, bounds.height - 64)),
  };
}

function track() {
  const span = source.value && props.material ? selectedSpan(source.value) : null;
  if (span) {
    clearHighlight();
    const current = window.getSelection();
    if (current?.rangeCount) placeQuick(current.getRangeAt(0).getBoundingClientRect());
  }
  emit('selection', span);
}

function anchorItem(id: number) {
  const found = [...reader.value?.querySelectorAll<HTMLElement>(`mark[data-item="${id}"]`) || []]
    .find(mark => mark.checkVisibility());
  if (found) placeQuick(found.getBoundingClientRect());
}

function select(item: Item, event: Event) {
  if (event.type === 'click' && !window.getSelection()?.isCollapsed) return;
  const target = event.currentTarget as HTMLElement;
  placeQuick(target.getBoundingClientRect());
  emit('select', item.id);
}

async function reveal(id: number | null) {
  if (id === null) return;
  await nextTick();
  for (const mark of reader.value?.querySelectorAll<HTMLElement>(`mark[data-item="${id}"]`) || []) {
    if (mark.checkVisibility()) mark.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
}

async function revealUnits(span: Span) {
  await nextTick();
  if (!source.value || !sourceScroll.value) return null;
  const range = document.createRange();
  range.setStart(...rangePoint(source.value, span.start));
  range.setEnd(...rangePoint(source.value, span.end));
  const bounds = range.getBoundingClientRect();
  const container = sourceScroll.value.getBoundingClientRect();
  if (bounds.top < container.top + 12 || bounds.bottom > container.bottom - 12) {
    sourceScroll.value.scrollTop += bounds.top - container.top - 36;
  }
  return range;
}

async function selectUnits(span: Span) {
  const range = await revealUnits(span);
  if (!range) return;
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  track();
}

function selectSpan(span: Span) {
  const offsets = index.value.offsets;
  return selectUnits({ start: offsets[span.start], end: offsets[span.end] });
}

async function highlightSpan(span: Span) {
  const offsets = index.value.offsets;
  const range = await revealUnits({ start: offsets[span.start], end: offsets[span.end] });
  if (range) CSS.highlights.set('adjustment-position', new Highlight(range));
}

function clearHighlight() {
  CSS.highlights.delete('adjustment-position');
}

async function openFind() {
  if (!props.material) return;
  findOpen.value = true;
  await nextTick();
  findInput.value?.focus();
}

function closeFind() {
  findOpen.value = false;
  query.value = '';
  CSS.highlights.delete('document-find');
}

function moveMatch(direction: number) {
  if (matches.value.length) matchIndex.value = Math.min(matches.value.length - 1, Math.max(0, matchIndex.value + direction));
}

function keydown(event: KeyboardEvent) {
  if (!props.active) return;
  if (event.key === 'Escape' && props.showQuick) emit('dismiss');
  if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === 'f' && !document.querySelector('dialog[open]')) {
    event.preventDefault();
    void openFind();
  }
}

watch(query, () => { matchIndex.value = 0; });
watch([matches, matchIndex, () => props.active], async ([results, position, active]) => {
  CSS.highlights.delete('document-find');
  const match = results[position];
  if (!active || !findOpen.value || !match) return;
  const range = await revealUnits(match);
  if (range && matches.value[matchIndex.value] === match && props.active) CSS.highlights.set('document-find', new Highlight(range));
});
watch(() => props.address, async () => {
  closeFind();
  await nextTick();
  if (sourceScroll.value) sourceScroll.value.scrollTop = 0;
  if (outputScroll.value) outputScroll.value.scrollTop = 0;
});
onMounted(() => {
  document.addEventListener('selectionchange', track);
  window.addEventListener('keydown', keydown);
});
onUnmounted(() => {
  closeFind();
  clearHighlight();
  document.removeEventListener('selectionchange', track);
  window.removeEventListener('keydown', keydown);
});
defineExpose({ reveal, selectSpan, anchorItem, highlightSpan, clearHighlight });
</script>

<template>
  <section ref="reader" class="reader" aria-label="材料正文">
    <div v-if="showQuick" class="quick-actions" role="group" aria-label="原文快捷操作"
      :style="{ '--quick-left': quickAnchor.left + 'px', '--quick-top': quickAnchor.top + 'px' }">
      <slot name="quick" />
    </div>
    <div class="panes">
      <article id="source-pane" class="pane source-pane">
        <div class="pane-title output-heading">
          <span>原文</span>
          <button class="button small" :disabled="!material" @click="openFind">查找本文</button>
        </div>
        <div v-if="findOpen" class="search-bar">
          <input ref="findInput" v-model="query" type="search" aria-label="查找本文" placeholder="输入要找的原文"
            @keydown.escape.stop="closeFind" @keydown.enter.prevent="moveMatch($event.shiftKey ? -1 : 1)">
          <span aria-live="polite">{{ matches.length ? `${matchIndex + 1} / ${matches.length}` : query ? '没有匹配' : '' }}</span>
          <div class="toolbar pane-output-actions">
            <button type="button" class="button small" aria-label="上一处搜索结果" :disabled="matchIndex <= 0" @click="moveMatch(-1)">↑</button>
            <button type="button" class="button small" aria-label="下一处搜索结果" :disabled="matchIndex + 1 >= matches.length" @click="moveMatch(1)">↓</button>
            <button type="button" class="button small" aria-label="关闭本文查找" @click="closeFind">×</button>
          </div>
        </div>
        <div id="source-scroll" ref="sourceScroll" class="pane-scroll">
          <div
            id="source-text" ref="source" class="document-text" :class="{ placeholder: !material }"
            tabindex="0" aria-label="原文"
          ><template v-if="!material">点击「添加材料」</template><template v-for="(piece, position) in sourceParts" :key="position"><mark
            v-if="piece.item" :data-item="piece.item.id" :class="classes(piece.item)"
            role="button" tabindex="0" :aria-label="itemLabel(piece.item, piece.text)"
            @click="select(piece.item, $event)" @keydown.enter.prevent="select(piece.item, $event)"
            @keydown.space.prevent="select(piece.item, $event)"
          >{{ piece.text }}</mark><template v-else>{{ piece.text }}</template></template></div>
        </div>
      </article>
      <article id="output-pane" class="pane output-pane">
        <div class="pane-title output-heading">
          <span>{{ previousOutput ? '脱敏文本 · 上一版' : '脱敏文本' }}</span>
          <div class="toolbar pane-output-actions" aria-label="输出脱敏文本">
            <button class="button small" :disabled="!canOutput" @click="emit('output', 'copy')">复制文本</button>
            <button class="button small primary" :disabled="!canOutput" @click="emit('output', 'file')">导出 TXT</button>
          </div>
        </div>
        <div id="output-scroll" ref="outputScroll" class="pane-scroll">
          <div id="output-text" class="document-text" tabindex="0" aria-label="脱敏预览"><template v-for="(piece, position) in outputParts" :key="position"><mark
            v-if="piece.item" :data-item="piece.item.id" :class="classes(piece.item)"
            role="button" tabindex="0" :aria-label="itemLabel(piece.item, piece.text)"
            @click="select(piece.item, $event)" @keydown.enter.prevent="select(piece.item, $event)"
            @keydown.space.prevent="select(piece.item, $event)"
          >{{ piece.text }}</mark><template v-else>{{ piece.text }}</template></template></div>
        </div>
      </article>
    </div>
  </section>
</template>
