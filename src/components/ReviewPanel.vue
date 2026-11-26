<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import { mappingCategories, mappingCategory, mappingTerms, matchMapping, type MappingCategory } from '../mapping-search';
import type { MappingScope } from '../../engine/preferences';
import { categoryColor, type Group, type Issue, type Material, type Occurrence } from '../model';
import MappingMenu from './MappingMenu.vue';
import OccurrenceRow from './OccurrenceRow.vue';

const props = defineProps<{
  material: Material | null; groups: Group[]; pending: Occurrence[]; issues: Issue[];
  selected: number | null; locked: boolean; canUndo: boolean; scope: MappingScope;
}>();
const category = defineModel<MappingCategory>('category', {required: true});
const emit = defineEmits<{
  jump: [row: Occurrence]; issue: [issue: Issue]; undo: []; create: [];
  group: [action: 'edit' | 'aliases' | 'merge' | 'delete', group: Group];
  scope: [scope: MappingScope, remember: boolean];
}>();

const query = ref('');
const showPending = ref(false);
const groupId = ref<string | null>(null);
const termFilter = ref('');
const list = ref<HTMLElement>();
const positionList = ref<HTMLElement>();
const search = computed(() => query.value.trim().toLocaleLowerCase());
const belongs = (row: Occurrence) => props.scope === 'all' || row.materialId === props.material?.id;
const isCurrent = (row: Occurrence) => row.materialId === props.material?.id && row.itemId === props.selected;

const filtered = computed(() => props.groups.flatMap(group => {
  if (category.value !== 'all' && mappingCategory(group.type) !== category.value) return [];
  const scoped = group.occurrences.filter(belongs);
  if (!scoped.length) return [];
  const {found, terms} = matchMapping(group, search.value, scoped);
  return found ? [{ group, matched: terms, count: scoped.length }] : [];
}));
const pending = computed(() => props.pending.filter(belongs));
const mapping = computed(() => showPending.value ? null : props.groups.find(group => group.id === groupId.value));
const terms = computed(() => mapping.value ? mappingTerms(mapping.value) : new Map<string, Occurrence[]>());
const options = computed(() => [...terms.value.keys()].sort((a, b) => Number(b === mapping.value?.primary) - Number(a === mapping.value?.primary)));
const positions = computed(() => {
  const rows = showPending.value ? pending.value : (terms.value.get(termFilter.value) || mapping.value?.occurrences || []).filter(belongs);
  return [...rows].sort((a, b) => Number(a.materialId) - Number(b.materialId) || a.start - b.start);
});
const activeIndex = computed(() => positions.value.findIndex(isCurrent));
const hidden = computed(() => !!mapping.value && !filtered.value.some(entry => entry.group.id === mapping.value?.id));

function selectGroup(id: string) {
  showPending.value = false;
  groupId.value = id;
  termFilter.value = '';
  resetPositionScroll();
}

function resetPositionScroll() {
  if (positionList.value) positionList.value.scrollTop = 0;
}

async function reveal() {
  await nextTick();
  list.value?.querySelector('.mapping-selected')?.scrollIntoView({ block: 'nearest' });
  positionList.value?.querySelector('.occurrence.current')?.scrollIntoView({ block: 'nearest' });
}
async function showGroup(id: string) {
  await nextTick();
  const group = props.groups.find(item => item.id === id);
  if (!group) return;
  selectGroup(id);
  if (category.value !== 'all') category.value = mappingCategory(group.type);
  const scoped = group.occurrences.filter(belongs);
  if (!scoped.length && props.scope === 'current') emit('scope', 'all', false);
  if (!matchMapping(group, search.value, scoped.length ? scoped : group.occurrences).found) query.value = '';
  await reveal();
}
function showCurrent() {
  if (groupId.value) void showGroup(groupId.value);
}
function chooseCategory(event: Event) {
  category.value = (event.currentTarget as HTMLSelectElement).value as MappingCategory;
  const group = props.groups.find(item => item.id === groupId.value);
  if (group && category.value !== 'all' && mappingCategory(group.type) !== category.value) {
    groupId.value = null;
    termFilter.value = '';
    resetPositionScroll();
  }
}
function chooseScope(event: Event) {
  const input = event.currentTarget as HTMLSelectElement;
  const scope = input.value as MappingScope;
  input.value = props.scope;
  emit('scope', scope, true);
}
defineExpose({ selectGroup, reveal, showGroup });
</script>

<template>
  <section class="card review" aria-label="映射清单">
    <div class="review-heading">
      <h2>映射清单</h2>
      <button class="button small" :disabled="locked || material?.status !== 'ready'" @click="emit('create')">＋ 新建映射</button>
    </div>
    <div class="mapping-filters">
      <input v-model="query" type="search" aria-label="搜索映射" placeholder="搜索原词、别称或代号">
      <select :value="scope" aria-label="映射材料范围" @change="chooseScope">
        <option value="all">全部材料</option><option value="current">本份材料</option>
      </select>
      <select :value="category" aria-label="映射类别" @change="chooseCategory">
        <option v-for="(label, value) in mappingCategories" :key="value" :value="value">{{ label }}</option>
      </select>
    </div>
    <div class="review-filters">
      <button class="button small quiet" :aria-pressed="showPending" @click="showPending = !showPending">待核 {{ pending.length }}</button>
      <button v-if="canUndo" class="button small quiet" :disabled="locked" @click="emit('undo')">撤销上次订正</button>
    </div>
    <div v-if="issues.length" class="issue-list">
      <h3>输出检查</h3>
      <button v-for="(issue, i) in issues" :key="i" @click="emit('issue', issue)">{{ issue.message }}</button>
    </div>
    <div v-if="hidden" class="hidden-mapping"><button class="button small quiet" @click="showCurrent">查看所属映射</button></div>
    <div ref="list" class="review-list">
      <p v-if="!filtered.length" class="muted-empty">{{ search || category !== 'all' || groups.length ? '没有匹配的映射' : '没有映射' }}</p>
      <div v-for="{group, matched, count} in filtered" :key="group.id" class="mapping"
        :class="{ 'mapping-selected': mapping?.id === group.id }">
        <div class="mapping-row">
          <button class="mapping-toggle" :aria-pressed="mapping?.id === group.id" @click="selectGroup(group.id)">
            <span class="mapping-title"><strong>{{ group.primary }}</strong><span class="mapping-arrow"> → </span><span class="chip" :class="categoryColor(group.type)">{{ group.code }}</span></span>
          </button>
          <div class="mapping-actions">
            <span v-if="count === group.occurrences.length" class="mapping-count">{{ count }} 处</span>
            <button class="button small quiet rename-button" :disabled="locked" @click="emit('group', 'edit', group)">修改代号</button>
            <MappingMenu :label="`${group.primary}的映射操作`" :disabled="locked">
              <button @click="emit('group', 'aliases', group)">管理原词与别称</button>
              <button v-if="groups.length > 1" @click="emit('group', 'merge', group)">合并到其他映射</button>
              <button class="danger" @click="emit('group', 'delete', group)">删除映射</button>
            </MappingMenu>
          </div>
        </div>
        <div v-if="matched.length || count !== group.occurrences.length" class="mapping-meta">
          <span v-if="matched.length">命中 {{ matched.join('、') }}</span>
          <span v-if="count !== group.occurrences.length" class="scope-count">本份 {{ count }} 处 / 共 {{ group.occurrences.length }} 处</span>
        </div>
      </div>
    </div>
    <section v-if="showPending || (mapping && !hidden)" class="mapping-positions" :aria-label="showPending ? '待核位置' : '出现位置'">
      <div class="position-heading">
        <h3>{{ showPending ? '待核位置' : '出现位置' }}</h3>
        <div v-if="mapping && options.length > 1" class="position-filter">
          <select v-model="termFilter" aria-label="按原词或别称筛选位置" @change="resetPositionScroll">
            <option value="">全部原词</option>
            <option v-for="term in options" :key="term" :value="term">{{ term }}</option>
          </select>
        </div>
      </div>
      <div ref="positionList" class="position-list">
        <p v-if="!positions.length" class="muted-empty">{{ showPending ? '当前范围没有待核位置' : '当前范围没有出现位置' }}</p>
        <OccurrenceRow v-for="row in positions" :key="`${row.materialId}/${row.itemId}`" :row="row" :current="isCurrent(row)" :disabled="locked" @locate="emit('jump', $event)" />
      </div>
      <div v-if="mapping && positions.length" class="item-nav">
        <button class="button small quiet" :disabled="locked || activeIndex <= 0" @click="emit('jump', positions[activeIndex - 1]!)">↑ 上一处</button>
        <button class="button small quiet" :disabled="locked || activeIndex >= positions.length - 1" @click="emit('jump', positions[activeIndex + 1]!)">↓ 下一处</button>
        <span>{{ activeIndex < 0 ? '–' : activeIndex + 1 }} / {{ positions.length }}</span>
      </div>
    </section>
  </section>
</template>
