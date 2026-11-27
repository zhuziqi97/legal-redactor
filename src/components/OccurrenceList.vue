<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { bisect } from '../../engine/text';
import { positionKey, type Occurrence } from '../model';
import OccurrenceRow from './OccurrenceRow.vue';

const props = defineProps<{
  rows: Occurrence[]; currentIndex?: number; grouped?: boolean; disabled: boolean;
}>();
const emit = defineEmits<{ locate: [row: Occurrence] }>();

const rowHeight = 62;
const headingHeight = 34;
const scroller = ref<HTMLElement>();
const scrollTop = ref(0);
const viewport = ref(0);
type Entry = {key: string; row: Occurrence; index: number} | {key: string; title: string; count: number};

const entries = computed<Entry[]>(() => {
  const rows = props.rows.map((row, index) => ({key: positionKey(row), row, index}));
  if (!props.grouped) return rows;
  const materials = new Map<string, typeof rows>();
  for (const entry of rows) {
    const id = entry.row.materialId;
    const material = materials.get(id);
    if (material) material.push(entry);
    else materials.set(id, [entry]);
  }
  return [...materials].flatMap(([id, material]) =>
    [{key: `heading-${id}`, title: material[0].row.title, count: material.length}, ...material]);
});

const offsets = computed(() => {
  if (entries.value.length <= 80) return null;
  const result = [0];
  for (const entry of entries.value) result.push(result[result.length - 1] + ('row' in entry ? rowHeight : headingHeight));
  return result;
});

const visible = computed(() => {
  const list = entries.value;
  const edges = offsets.value;
  if (!edges) return {rows: list, before: 0, after: 0};
  const height = edges[edges.length - 1];
  const top = Math.min(scrollTop.value, Math.max(0, height - viewport.value));
  const overscan = rowHeight * 6;
  const first = Math.max(0, bisect(edges, top - overscan, true) - 1);
  const last = Math.min(list.length, bisect(edges, top + viewport.value + overscan));
  return {rows: list.slice(first, last), before: edges[first], after: height - edges[last]};
});

function readScroll() {
  scrollTop.value = scroller.value?.scrollTop ?? 0;
}

watch(scroller, (pane, _, onCleanup) => {
  if (!pane) return;
  const measure = () => { viewport.value = pane.clientHeight; };
  const observer = new ResizeObserver(measure);
  observer.observe(pane);
  onCleanup(() => observer.disconnect());
  measure();
}, {flush: 'post'});

function resetScroll() {
  if (scroller.value) scroller.value.scrollTop = 0;
  readScroll();
}

async function revealCurrent() {
  await nextTick();
  const pane = scroller.value;
  const index = props.currentIndex ?? -1;
  if (!pane || index < 0) return;
  const edges = offsets.value;
  if (!edges) {
    pane.querySelector('.occurrence.current')?.scrollIntoView({block: 'nearest'});
    return;
  }
  const top = edges[index];
  const bottom = edges[index + 1];
  if (top < pane.scrollTop) pane.scrollTop = top;
  else if (bottom > pane.scrollTop + pane.clientHeight) pane.scrollTop = bottom - pane.clientHeight + 8;
  readScroll();
  await nextTick();
}

defineExpose({resetScroll, revealCurrent});
</script>

<template>
  <div ref="scroller" :class="[grouped ? 'material-list project-results' : 'position-list', {'windowed-occurrences': offsets}]"
    :style="offsets ? {'--result-row-height': rowHeight + 'px', '--result-heading-height': headingHeight + 'px'} : undefined"
    @scroll.passive="readScroll">
    <slot v-if="!rows.length" />
    <div v-if="visible.before" aria-hidden="true" :style="{height: visible.before + 'px'}"></div>
    <template v-for="entry in visible.rows" :key="entry.key">
      <OccurrenceRow v-if="'row' in entry" :row="entry.row" :show-title="!grouped" :current="entry.index === currentIndex"
        :disabled="disabled" @locate="emit('locate', $event)">
        <slot name="detail" :row="entry.row" />
      </OccurrenceRow>
      <h3 v-else class="project-result-heading">
        <span :title="entry.title">{{ entry.title }}</span><span class="count">{{ entry.count }} 处</span>
      </h3>
    </template>
    <div v-if="visible.after" aria-hidden="true" :style="{height: visible.after + 'px'}"></div>
  </div>
</template>
