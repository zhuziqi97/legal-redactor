<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { matchMapping } from '../mapping-search';
import type { Group } from '../model';

const props = defineProps<{groups: Group[]; disabled?: boolean; autofocus?: boolean}>();
const selectedId = defineModel<string>({required: true});
const query = ref('');
const input = ref<HTMLInputElement>();
const list = ref<HTMLDivElement>();
const results = computed(() => {
  if (!query.value.trim()) return props.groups;
  const matches = props.groups.map(group => ({group, ...matchMapping(group, query.value)})).filter(match => match.found);
  return matches.sort((left, right) => Number(right.exact) - Number(left.exact)).map(match => match.group);
});
const selected = computed(() => props.groups.find(group => group.id === selectedId.value));
const hiddenSelection = computed(() => selected.value && !results.value.some(group => group.id === selectedId.value));

function focusResult(event: KeyboardEvent, offset: number) {
  if (event.isComposing || props.disabled) return;
  const buttons = [...(list.value?.querySelectorAll('button') ?? [])];
  if (!buttons.length) return;
  const current = buttons.findIndex(button => button === event.target);
  if (current === 0 && offset === -1) {
    input.value?.focus();
  } else {
    const index = Math.max(0, Math.min(buttons.length - 1, current + offset));
    buttons[index].focus();
  }
  event.preventDefault();
}

onMounted(() => { if (props.autofocus) input.value?.focus(); });
</script>

<template>
  <div class="mapping-target-picker">
    <label>搜索目标映射
      <input ref="input" v-model="query" type="search" :autofocus="autofocus" placeholder="原词、别称或代号" :disabled="disabled"
        @keydown.down="focusResult($event, 1)" @keydown.enter="!$event.isComposing && $event.preventDefault()">
    </label>
    <p v-if="hiddenSelection && selected" class="mapping-target-current">已选 {{ selected.primary }} → {{ selected.code }}</p>
    <div ref="list" class="mapping-target-results" role="group" aria-label="目标映射"
      @keydown.down="focusResult($event, 1)" @keydown.up="focusResult($event, -1)">
      <button v-for="group in results" :key="group.id" type="button" class="mapping-target-option" :disabled="disabled"
        :aria-pressed="group.id === selectedId" @click="selectedId = group.id">
        <span>{{ group.primary }} → {{ group.code }}</span><small>{{ group.occurrences.length }} 处</small>
      </button>
      <p v-if="!results.length" class="muted-empty">{{ groups.length ? '没有匹配的映射' : '暂无可选映射' }}</p>
    </div>
  </div>
</template>

<style scoped>
.mapping-target-picker { display: grid; gap: 6px; min-width: 0; }
.mapping-target-picker input { width: 100%; }
.mapping-target-results { max-height: min(170px, 28vh); overflow: auto; padding: 3px; border: 1px solid var(--edge); border-radius: 7px; }
.mapping-target-option {
  display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; width: 100%;
  border: 1px solid transparent; border-radius: 5px; padding: 5px 7px; text-align: left; overflow-wrap: anywhere;
}
.mapping-target-option:hover { background: var(--surface); }
.mapping-target-option:focus-visible { outline-offset: -2px; }
.mapping-target-option[aria-pressed="true"] { border-color: var(--accent-edge); background: var(--accent-soft); }
.mapping-target-option small { flex: none; color: var(--muted); }
.mapping-target-current { margin: 0; font-size: 12px; color: var(--accent); overflow-wrap: anywhere; }
</style>
