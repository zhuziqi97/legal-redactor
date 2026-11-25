<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { categoryColor, labels, positionKey, prettyError, type Item, type Material, type Occurrence, type Span } from '../model';
import { indexText, rangePoint, selectedSpan, textPieces } from '../positions';

const props = defineProps<{
  material: Material | null; address: string; selected: number | null; canOutput: boolean; showQuick: boolean;
  findCase: (text: string) => Promise<Occurrence[]>; locked: boolean; revision: number;
}>();
const emit = defineEmits<{ select: [id: number]; selection: [span: Span | null]; dismiss: []; output: [kind: 'copy' | 'file']; locate: [row: Occurrence] }>();
const view = ref<'source' | 'output' | 'both'>(window.innerWidth >= 1050 ? 'both' : 'source');
const reader = ref<HTMLElement>();
const source = ref<HTMLElement>();
const sourceScroll = ref<HTMLElement>();
const outputScroll = ref<HTMLElement>();
const findInput = ref<HTMLInputElement>();
const quickAnchor = ref({ left: 0, top: 0 });
const findOpen = ref(false);
const query = ref('');
const findScope = ref<'current' | 'case'>('current');
const caseMatches = ref<Occurrence[]>([]);
const searched = ref(false);
const findError = ref('');
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

async function showSource() {
  if (view.value === 'output') view.value = 'source';
  await nextTick();
}

async function revealUnits(span: Span) {
  await showSource();
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
  window.getSelection()?.removeAllRanges();
}

async function searchCase() {
  if (!query.value.trim() || props.locked) return;
  const word = query.value;
  const revision = props.revision;
  findError.value = '';
  try {
    const rows = await props.findCase(word);
    if (word === query.value && revision === props.revision && findScope.value === 'case') {
      caseMatches.value = rows;
      searched.value = true;
    }
  } catch (error) {
    findError.value = prettyError(error);
  }
}

function keydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && props.showQuick) emit('dismiss');
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f' && !document.querySelector('dialog[open]')) {
    event.preventDefault();
    void openFind();
  }
}

watch([query, findScope, () => props.revision], () => {
  matchIndex.value = 0;
  caseMatches.value = [];
  searched.value = false;
  findError.value = '';
});
watch([matches, matchIndex, findScope], ([results, position, scope]) => {
  if (scope === 'current' && results[position]) void selectUnits(results[position]);
});
watch(() => props.address, async () => {
  if (findScope.value === 'current') closeFind();
  await nextTick();
  if (sourceScroll.value) sourceScroll.value.scrollTop = 0;
  if (outputScroll.value) outputScroll.value.scrollTop = 0;
});
watch(view, () => void reveal(props.selected));
onMounted(() => {
  document.addEventListener('selectionchange', track);
  window.addEventListener('keydown', keydown);
});
onUnmounted(() => {
  clearHighlight();
  document.removeEventListener('selectionchange', track);
  window.removeEventListener('keydown', keydown);
});
defineExpose({ reveal, selectSpan, showSource, anchorItem, highlightSpan, clearHighlight });
</script>

<template>
  <section ref="reader" class="reader" aria-label="材料正文">
    <div class="reader-toolbar">
      <div class="segments" aria-label="阅读方式">
        <button :aria-pressed="view === 'source'" @click="view = 'source'">原文</button>
        <button :aria-pressed="view === 'output'" @click="view = 'output'">脱敏预览</button>
        <button :aria-pressed="view === 'both'" @click="view = 'both'">并排对照</button>
      </div>
      <div class="toolbar">
        <button class="button small quiet" :disabled="!material" @click="openFind">查找原文</button>
      </div>
    </div>
    <form v-if="findOpen" class="search-bar" @submit.prevent="findScope === 'case' && searchCase()">
      <input id="search-input" ref="findInput" v-model="query" type="search" placeholder="输入要找的原文" aria-label="查找原文" @keydown.escape.stop="closeFind">
      <select v-model="findScope" aria-label="原文查找范围"><option value="current">本份材料</option><option value="case">全案</option></select>
      <template v-if="findScope === 'current'">
        <span aria-live="polite">{{ matches.length ? `${matchIndex + 1} / ${matches.length}` : query ? '没有匹配' : '' }}</span>
        <button type="button" class="button small" aria-label="上一条搜索结果" :disabled="matchIndex <= 0" @click="matchIndex--">↑</button>
        <button type="button" class="button small" aria-label="下一条搜索结果" :disabled="matchIndex + 1 >= matches.length" @click="matchIndex++">↓</button>
      </template>
      <button v-else class="button small" :disabled="locked || !query.trim()">查找</button>
      <button type="button" class="button small" @click="closeFind">关闭</button>
    </form>
    <div v-if="findOpen && findScope === 'case' && (searched || findError)" class="card case-find" aria-label="全案查找结果">
      <p v-if="findError" class="form-error">{{ findError }}</p>
      <p v-else-if="!caseMatches.length" class="muted-empty">全案没有匹配</p>
      <button v-for="row in caseMatches" :key="positionKey(row)" class="occurrence" :disabled="locked" @click="emit('locate', row)">
        <span class="occurrence-meta">{{ row.title }} · 第 {{ row.line }} 行</span>
        <span class="snippet">{{ row.before }}<b>{{ row.original }}</b>{{ row.after }}</span>
      </button>
    </div>
    <div v-if="showQuick" class="quick-actions" role="group" aria-label="原文快捷操作"
      :style="{ '--quick-left': quickAnchor.left + 'px', '--quick-top': quickAnchor.top + 'px' }">
      <slot name="quick" />
    </div>
    <div class="panes" :data-view="view">
      <article id="source-pane" class="pane source-pane">
        <div class="pane-title">原文</div>
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
