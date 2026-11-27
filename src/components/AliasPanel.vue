<script setup lang="ts">
import { computed, ref } from 'vue';
import type { AliasTarget } from '../../engine/workspace-types';
import { mappingTerms } from '../mapping-search';
import type { Group, Occurrence } from '../model';
import MappingMenu from './MappingMenu.vue';
import OccurrenceList from './OccurrenceList.vue';

const props = defineProps<{ group: Group; materialId?: string; selected: number | null; locked: boolean; canAdd: boolean }>();
const emit = defineEmits<{
  back: []; add: []; addPositions: [alias: AliasTarget]; jump: [row: Occurrence];
  term: [action: 'rebind' | 'removePositions' | 'primary' | 'edit', rows: Occurrence[]];
}>();

const selectedOriginal = ref('');
const terms = computed(() => {
  const occurrences = mappingTerms(props.group);
  const {primary, code} = props.group;
  if (!occurrences.has(primary)) occurrences.set(primary, []);
  return [...occurrences].map(([original, rows]) => ({
    original, rows, primary: original === primary, codes: rows.length ? [...new Set(rows.map(row => row.replacement))] : [code],
  })).sort((left, right) => Number(right.primary) - Number(left.primary));
});
const selectedTerm = computed(() => terms.value.find(term => term.original === selectedOriginal.value));
const activeIndex = computed(() => selectedTerm.value?.rows.findIndex(row =>
  row.materialId === props.materialId && row.itemId === props.selected) ?? -1);

function termAction(action: 'rebind' | 'removePositions' | 'primary' | 'edit', rows: Occurrence[]) {
  selectedOriginal.value = rows[0].original;
  emit('term', action, rows);
}
</script>

<template>
  <section class="card review alias-panel" aria-label="管理原词与别称">
    <div class="review-heading">
      <h2>管理原词与别称</h2>
      <button class="button small quiet" :disabled="locked" @click="emit('back')">返回映射清单</button>
    </div>
    <div class="alias-panel-context">
      <button class="button small" :disabled="locked || !canAdd" @click="emit('add')">＋ 添加别称</button>
    </div>
    <div class="alias-list" role="group" aria-label="原词与别称列表">
      <div v-for="term in terms" :key="term.original" class="alias-entry" :class="{ 'alias-selected': selectedTerm === term }">
        <button class="alias-toggle" :aria-pressed="selectedTerm === term" :disabled="locked"
          @click="selectedOriginal = selectedTerm === term ? '' : term.original">
          <span class="alias-name"><strong>{{ term.original }}</strong><span>{{ term.codes.join(' · ') }}<template v-if="term.primary"> · 恢复原词</template></span></span>
          <small>{{ term.rows.length }} 处</small>
        </button>
        <MappingMenu v-if="canAdd" :label="`${term.original}的位置操作`" :disabled="locked">
          <button v-for="code in term.codes" :key="code" @click="selectedOriginal = term.original; emit('addPositions', {original: term.original, code})">
            {{ term.codes.length === 1 ? '添加位置' : `添加位置 · ${code}` }}
          </button>
          <template v-if="term.rows.length">
            <button @click="termAction('rebind', term.rows)">改绑位置</button>
            <button @click="termAction('edit', term.rows)">修正标注范围</button>
            <button v-if="!term.primary" @click="termAction('primary', term.rows)">设为恢复原词</button>
            <button class="danger" @click="termAction('removePositions', term.rows)">移出位置</button>
          </template>
        </MappingMenu>
      </div>
    </div>
    <section v-if="selectedTerm?.rows.length" :key="selectedTerm.original" class="mapping-positions" aria-label="原词位置">
      <div class="position-heading"><h3>{{ selectedTerm.original }}的出现位置</h3></div>
      <OccurrenceList :rows="selectedTerm.rows" :current-index="activeIndex" :disabled="locked" @locate="emit('jump', $event)">
        <template v-if="selectedTerm.codes.length > 1" #detail="{row}"> · {{ row.replacement }}</template>
      </OccurrenceList>
    </section>
  </section>
</template>

<style scoped>
.alias-panel-context {
  display: flex; align-items: center; justify-content: flex-end; gap: 8px;
  padding: 8px 11px; border-bottom: 1px solid var(--line); font-size: 13px;
}
.alias-panel-context .button { flex: none; }
.alias-list { flex: 1; min-height: 56px; overflow: auto; padding: 4px 8px; }
.alias-panel:has(.mapping-positions) .alias-list { flex: 0 1 auto; max-height: 48%; }
.alias-entry { display: flex; align-items: flex-start; gap: 4px; padding: 4px; border: 1px solid transparent; border-bottom-color: var(--line); border-radius: 6px; }
.alias-entry:has(> .alias-toggle:hover) { background: var(--surface); }
.alias-entry.alias-selected { background: var(--accent-soft); border-color: var(--accent-edge); }
.alias-entry:has(> .alias-toggle:focus-visible) { border-color: var(--focus); box-shadow: inset 0 0 0 1px var(--focus); }
.alias-toggle {
  display: flex; flex: 1; align-items: center; justify-content: space-between;
  gap: 8px; min-width: 0; padding: 4px; border: 0; border-radius: 5px; text-align: left;
}
.alias-toggle:focus-visible { outline: none; }
.alias-name { display: grid; gap: 3px; min-width: 0; overflow-wrap: anywhere; font-size: 13px; }
.alias-name span, .alias-toggle small { color: var(--muted); font-size: 11px; }
.alias-toggle small { flex: none; }
</style>
