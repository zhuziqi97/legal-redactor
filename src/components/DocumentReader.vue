<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import TextLines from './TextLines.vue';
import { correspondingSpans, useComparisonScroll } from '../comparison-scroll';
import { categoryColor, labels, type Item, type Material, type Span, type ViewOptions } from '../model';
import { copyTextSelection, indexText, rangePoint, selectedSpan, textPieces } from '../positions';

const props = defineProps<{
  material: Material | null; address: string; selected: number | null; canOutput: boolean; showQuick: boolean;
  active: boolean; editText?: string; editDisabled: boolean; applyDisabled: boolean; revising: boolean; editError: string;
  viewOptions?: ViewOptions;
}>();
const emit = defineEmits<{ select: [id: number]; selection: [span: Span | null]; dismiss: []; output: [kind: 'copy' | 'file'];
  edit: []; 'update:editText': [text: string]; applyEdit: []; cancelEdit: [] }>();
const editing = computed(() => props.editText !== undefined);
const wrap = computed(() => props.viewOptions?.wrap !== false);
const editable = computed({get: () => props.editText ?? '', set: text => emit('update:editText', text)});
const reader = ref<HTMLElement>();
const source = ref<HTMLElement>();
const sourceScroll = ref<HTMLElement>();
const outputScroll = ref<HTMLElement>();
const editor = ref<HTMLTextAreaElement>();
const findInput = ref<HTMLInputElement>();
const quickAnchor = ref({ left: 0, top: 0 });
const findOpen = ref(false);
const query = ref('');
const matchIndex = ref(0);
const index = computed(() => indexText(props.material?.text || ''));
const sourceParts = computed(() => textPieces(props.material?.text || '', props.material?.items || []));
const previousOutput = computed(() => props.material?.previousOutput);
const outputParts = computed(() => previousOutput.value !== null && previousOutput.value !== undefined || editing.value
  ? textPieces(previousOutput.value ?? props.material?.output ?? '', [], true)
  : textPieces(props.material?.output || '', props.material?.items || [], true));
const spans = computed(() => correspondingSpans(sourceParts.value, outputParts.value));
const comparison = useComparisonScroll(sourceScroll, outputScroll, () => props.viewOptions,
  () => props.active && props.material?.status === 'ready' && previousOutput.value == null && !editing.value,
  () => spans.value);
let editStart: { position: number; revision?: number } | undefined;

const matches = computed(() => {
  const text = props.editText ?? props.material?.text ?? '';
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
  for (const pane of [sourceScroll.value, outputScroll.value]) {
    pane?.querySelector(`mark[data-item="${id}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  comparison.rememberScroll();
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
  if (!wrap.value && (bounds.left < container.left + 12 || bounds.right > container.right - 12)) {
    sourceScroll.value.scrollLeft += bounds.left - container.left - 36;
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

function revealEditorMatch(area: HTMLTextAreaElement, match: Span) {
  area.setSelectionRange(match.start, match.end);
  const mirror = document.createElement('div');
  mirror.className = 'document-text source-editor editor-measure';
  mirror.classList.toggle('without-wrap', !wrap.value);
  mirror.style.width = `${area.clientWidth}px`;
  const text = document.createTextNode(area.value);
  mirror.append(text);
  area.parentElement?.append(mirror);
  try {
    const range = document.createRange();
    range.setStart(text, match.start);
    range.setEnd(text, match.end);
    const rect = range.getClientRects()[0];
    if (!rect) return;
    const top = rect.top - mirror.getBoundingClientRect().top;
    if (top < area.scrollTop || top + rect.height > area.scrollTop + area.clientHeight) {
      area.scrollTop = Math.max(0, top - rect.height);
    }
    const left = rect.left - mirror.getBoundingClientRect().left;
    if (!wrap.value && (left < area.scrollLeft || left + rect.width > area.scrollLeft + area.clientWidth)) {
      area.scrollLeft = Math.max(0, left - 16);
    }
  } finally {
    mirror.remove();
  }
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
watch(matches, rows => { matchIndex.value = Math.min(matchIndex.value, Math.max(0, rows.length - 1)); });
watch([matches, matchIndex, () => props.active, editing], async ([results, position, active, isEditing]) => {
  CSS.highlights.delete('document-find');
  const match = results[position];
  if (!active || !findOpen.value || !match) return;
  if (isEditing) {
    await nextTick();
    const area = editor.value;
    if (area && matches.value[matchIndex.value] === match) revealEditorMatch(area, match);
    return;
  }
  const range = await revealUnits(match);
  if (range && matches.value[matchIndex.value] === match && props.active) CSS.highlights.set('document-find', new Highlight(range));
});
watch(editing, async isEditing => {
  const current = isEditing ? sourceScroll.value : editor.value;
  const scroll = current?.scrollTop ?? 0;
  const horizontal = current?.scrollLeft ?? 0;
  if (isEditing) editStart = { position: comparison.position(0) ?? 0, revision: props.material?.revision };
  const position = isEditing || editStart?.revision === props.material?.revision
    ? editStart?.position : editor.value?.selectionStart;
  await nextTick();
  if (isEditing && editor.value) {
    editor.value.focus({preventScroll: true});
    if (position !== undefined) editor.value.setSelectionRange(position, position);
    editor.value.scrollTop = scroll;
    editor.value.scrollLeft = horizontal;
  } else if (sourceScroll.value) {
    sourceScroll.value.scrollLeft = horizontal;
    if (position !== undefined) comparison.goTo(0, position);
    comparison.follow(0);
    editStart = undefined;
  }
});
watch(() => props.address, async () => {
  closeFind();
  await nextTick();
  for (const pane of [sourceScroll.value, outputScroll.value]) if (pane) pane.scrollTo(0, 0);
  comparison.rememberScroll();
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
          <div class="toolbar pane-output-actions">
            <button class="button small" :disabled="!material" @click="openFind">查找本文</button>
            <template v-if="editing">
              <button class="button small" :disabled="revising" @click="emit('cancelEdit')">取消编辑</button>
              <button class="button small primary" :disabled="applyDisabled" @click="emit('applyEdit')">应用并识别</button>
            </template>
            <button v-else class="button small" :disabled="editDisabled" @click="emit('edit')">编辑原文</button>
          </div>
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
        <p v-if="editError" class="source-edit-error form-error" role="alert">{{ editError }}</p>
        <textarea v-if="editing" ref="editor" v-model="editable" class="document-text source-editor" aria-label="编辑材料原文"
          :class="{ 'without-wrap': !wrap }" :wrap="wrap ? 'soft' : 'off'" :readonly="revising"></textarea>
        <div v-else id="source-scroll" ref="sourceScroll" class="pane-scroll" :class="{ 'without-wrap': !wrap }"
          @scroll.passive="comparison.onScroll(0)">
          <div
            id="source-text" ref="source" class="document-text" :class="{ placeholder: !material }"
            tabindex="0" aria-label="原文" @copy="copyTextSelection"
          ><template v-if="!material">点击「添加材料」</template><TextLines v-else :pieces="sourceParts"
            :numbers="!!viewOptions?.lineNumbers" :newlines="viewOptions?.newlines !== false">
            <template #mark="{ item, text, continued }"><mark :data-item="item.id" :class="classes(item)"
              role="button" :tabindex="continued ? -1 : 0" :aria-label="itemLabel(item, text)"
              @click="select(item, $event)" @keydown.enter.prevent="select(item, $event)"
              @keydown.space.prevent="select(item, $event)"
            >{{ text }}</mark></template>
          </TextLines></div>
        </div>
      </article>
      <article id="output-pane" class="pane output-pane">
        <div class="pane-title output-heading">
          <span>{{ editing || previousOutput !== null && previousOutput !== undefined ? '上次识别结果' : '脱敏文本' }}</span>
          <div class="toolbar pane-output-actions" aria-label="输出脱敏文本">
            <button class="button small" :disabled="!canOutput" @click="emit('output', 'copy')">复制文本</button>
            <button class="button small primary" :disabled="!canOutput" @click="emit('output', 'file')">导出 TXT</button>
          </div>
        </div>
        <div id="output-scroll" ref="outputScroll" class="pane-scroll" :class="{ 'without-wrap': !wrap }"
          @scroll.passive="comparison.onScroll(1)">
          <div id="output-text" class="document-text" tabindex="0" aria-label="脱敏预览" @copy="copyTextSelection"><TextLines
            :pieces="outputParts" :numbers="!!viewOptions?.lineNumbers" :newlines="viewOptions?.newlines !== false">
            <template #mark="{ item, text, continued }"><mark :data-item="item.id" :class="classes(item)"
              role="button" :tabindex="continued ? -1 : 0" :aria-label="itemLabel(item, text)"
              @click="select(item, $event)" @keydown.enter.prevent="select(item, $event)"
              @keydown.space.prevent="select(item, $event)"
            >{{ text }}</mark></template>
          </TextLines></div>
        </div>
      </article>
    </div>
  </section>
</template>
