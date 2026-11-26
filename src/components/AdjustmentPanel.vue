<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import MappingTargetPicker from './MappingTargetPicker.vue';
import { kindLabel, labels, positionKey, type Adjustment, type AdjustmentPreview, type AdjustmentPreviewResult, type Group, type Issue, type Occurrence,
  type RangeCandidate, type RangeSuggestion, type SourceChange } from '../model';

const props = defineProps<{
  draft: Adjustment; groups: Group[]; materialId?: string; selected: number | null; locked: boolean;
  previewing: boolean; impact: AdjustmentPreviewResult | null; previewSources: AdjustmentPreview['sources']; sourceChanges: SourceChange[];
  mergePrompt: Issue | null; rangeFor: { materialId: string; id: number } | null;
  suggestions: { rows: RangeSuggestion[]; error?: string } | null;
}>();
const emit = defineEmits<{
  cancel: []; search: []; apply: []; chooseTarget: [];
  jump: [row: Pick<Occurrence, 'materialId' | 'itemId' | 'start' | 'end'>]; issue: [issue: Issue]; add: []; remove: [];
  reselect: [row: Occurrence]; original: [value: string];
}>();
const target = computed(() => props.groups.find(group => group.id === props.draft.groupId));
const preview = computed(() => props.impact && 'preview' in props.impact ? props.impact.preview : null);
const previewIssue = computed(() => props.impact && 'issue' in props.impact ? props.impact.issue : null);
const error = computed(() => (props.impact && 'error' in props.impact ? props.impact.error
  : previewIssue.value?.merge ? '' : previewIssue.value?.message) || props.draft.error);
const editingLocked = computed(() => props.locked && !props.previewing);
const selectedRows = computed(() => props.draft.rows.filter(row => props.draft.chosen.has(positionKey(row))));
const selecting = computed(() => ['create', 'bind'].includes(props.draft.mode));
const visibleRows = computed(() => !selecting.value || !props.draft.searched ? props.draft.rows
  : props.draft.rows.filter(row => props.draft.searchKeys.has(positionKey(row)) || props.draft.chosen.has(positionKey(row))));
const candidateInput = ref<HTMLInputElement>();
const originalInput = ref<HTMLTextAreaElement>();
const codeInput = ref<HTMLInputElement>();
onMounted(() => (originalInput.value || (props.draft.mode !== 'bind' || props.draft.fixedTarget ? candidateInput.value : undefined))?.focus());
const located = ref('');
function locate(row: Occurrence) {
  located.value = positionKey(row);
  emit('jump', row);
}
const editing = computed(() => props.draft.mode === 'edit');
const merging = computed(() => props.draft.mode === 'merge');
const pickingSource = ref(false);
const originalWord = computed({
  get: () => props.draft.originalEdit?.value || '',
  set: value => { pickingSource.value = false; emit('original', value); },
});
const wordChanged = computed(() => originalWord.value !== props.draft.originalEdit?.base);
const codeChanged = computed(() => {
  const text = props.draft.code.trim();
  return !!target.value && text !== target.value.code && `【${text}】` !== target.value.code;
});
const editedTerms = computed(() => [...new Set(props.draft.rows.map(row => props.draft.edits[positionKey(row)]?.original || row.original))]);
const editCount = computed(() => Object.keys(props.draft.edits).length);
const conflict = computed(() => props.mergePrompt?.merge);
const conflictGroups = computed(() => props.groups.filter(group => conflict.value?.groups.includes(group.id)));
const mergeTarget = computed(() => props.groups.find(group => group.id === props.draft.resolution?.targetId));
function occupiedCodes(group: Group) {
  return conflict.value?.occupants?.filter(item => item.groupId === group.id) ?? [];
}
function locateCode(group: Group, code?: string) {
  const row = code ? group.occurrences.find(row => row.replacement === code) : group.occurrences[0];
  if (row) locate(row);
}
function returnToCode() {
  props.draft.resolution = null;
  codeInput.value?.focus();
}
const mergeOptions = computed(() => new Map(conflict.value?.options.map(option => [option.groupId, option])));
const codeRebind = computed(() => conflict.value?.reason === 'code' && !wordChanged.value && !editCount.value
  && conflict.value.codeChoices);
const editRows = computed(() => {
  const edit = props.draft.originalEdit;
  if (!edit) return [];
  const suggestions = new Map(props.suggestions?.rows.map(row => [positionKey(row.original), row.candidates]));
  const rows = edit.origin ? [edit.origin] : props.draft.rows.filter(row => codeRebind.value || row.original === edit.base);
  return rows.map(row => {
    const key = positionKey(row);
    const manual = edit.manual[key];
    const candidates = suggestions.get(key) || [];
    const options = manual && !candidates.some(option => positionKey(option.position) === positionKey(manual))
      ? [{ position: manual, clear: false, overlap: false }, ...candidates] : candidates;
    return { key, row, options, selected: props.draft.edits[key] };
  });
});
const clearMatches = computed(() => editRows.value.filter(entry => entry.options.length === 1 && entry.options[0].clear));
const allClearSelected = computed(() => clearMatches.value.every(entry => entry.selected));
const needsPreview = computed(() => selecting.value || editing.value || merging.value);
const resultCount = computed(() => props.draft.searchKeys.size);
const checkedResults = computed(() => [...props.draft.searchKeys].filter(key => props.draft.chosen.has(key)).length);
const allSelected = computed(() => resultCount.value > 0 && checkedResults.value === resultCount.value);
const affected = computed(() => preview.value?.materials || []);
const sourceImpacts = computed(() => needsPreview.value ? props.previewSources
  : props.sourceChanges.map(change => ({
    id: change.group.id, primary: change.group.primary, code: change.group.code,
    moved: change.moved.length, remaining: change.rest.length,
    nextPrimary: change.terms[0]?.original, terms: change.terms.map(row => row.original),
  })));
const removedCount = computed(() => affected.value.reduce((total, doc) => total + doc.removedCount, 0));
const restoredCount = computed(() => affected.value.reduce((total, doc) => total + doc.restoredCount, 0));
const destination = computed(() => {
  if (props.draft.mode === 'remove') return props.draft.keep ? '保留原文' : '转待核';
  if (merging.value && preview.value) {
    const count = preview.value.sources.find(source => source.id === props.draft.groupId)?.moved ?? 0;
    return `迁入 ${count} 处 → ${preview.value.code}`;
  }
  if (editing.value && preview.value) return `${preview.value.primary} → ${preview.value.code}`;
  return preview.value?.code || target.value?.code || '';
});
const canApply = computed(() => !props.locked && !props.rangeFor && (needsPreview.value ? preview.value !== null : selectedRows.value.length > 0));
const applyLabel = computed(() => {
  if (props.draft.resolution?.mode === 'whole') return '确认合并';
  if (props.draft.resolution?.mode === 'selected') return '确认改绑';
  if (!editing.value) return `应用到所选 ${selectedRows.value.length} 处`;
  return '应用修改';
});
const editSummary = computed(() => {
  if (!editing.value || (!editCount.value && !codeChanged.value)) return '';
  if (props.draft.resolution?.mode === 'selected') return `改绑 ${editCount.value || selectedRows.value.length} 处`;
  if (props.draft.resolution?.mode === 'whole') return `合并本组 ${props.draft.rows.length} 处${preview.value ? `至「${preview.value.primary}」` : ''}`;
  return [editCount.value ? `调整 ${editCount.value} 处原文范围` : '',
    codeChanged.value ? `更新整组 ${props.draft.rows.length} 处代号` : ''].filter(Boolean).join('，');
});

function changeSelection(key: string, checked: boolean) {
  if (checked) props.draft.chosen.add(key);
  else props.draft.chosen.delete(key);
}
function toggle(row: Occurrence, event: Event) {
  changeSelection(positionKey(row), (event.target as HTMLInputElement).checked);
}
function toggleResults(event: Event) {
  const checked = (event.target as HTMLInputElement).checked;
  for (const key of props.draft.searchKeys) changeSelection(key, checked);
}

function toggleEdit(key: string, candidate: RangeCandidate, checked: boolean) {
  if (checked) props.draft.edits[key] = candidate.position;
  else delete props.draft.edits[key];
  props.draft.primary = '';
}

function toggleClearMatches() {
  const checked = !allClearSelected.value;
  for (const entry of clearMatches.value) toggleEdit(entry.key, entry.options[0], checked);
}

function takeFrom(row?: Occurrence) {
  const target = row || (editRows.value.length === 1 ? editRows.value[0].row : undefined);
  pickingSource.value = !target;
  if (target) emit('reselect', target);
}

function resolve(mode: 'whole' | 'selected' | 'retain', targetId?: string) {
  const previous = props.draft.resolution;
  props.draft.resolution = previous?.mode === mode && previous.targetId === targetId ? null : { mode, targetId };
}
</script>

<template>
  <section class="card review adjustment" :class="{ 'merge-preview': merging }" aria-label="调整清单">
    <div class="review-heading">
      <h2>{{ editing || merging ? draft.title : '调整清单' }}</h2>
      <div class="toolbar">
        <button v-if="merging" class="button small quiet" :disabled="locked" @click="emit('chooseTarget')">更换目标</button>
        <button class="button small quiet" :disabled="locked" @click="emit('cancel')">取消</button>
      </div>
    </div>
    <div v-if="!merging" class="adjust-controls">
      <h3 v-if="!editing">{{ draft.title }}</h3>
      <template v-if="editing && target">
        <div class="edit-original-field">
          <label for="mapping-original">原词</label>
          <button type="button" class="button small quiet" :disabled="locked" @click="takeFrom()">从原文取词</button>
          <textarea id="mapping-original" ref="originalInput" v-model="originalWord" rows="1" :disabled="editingLocked"></textarea>
        </div>
        <label class="edit-field">代号<input ref="codeInput" v-model="draft.code" :disabled="editingLocked" maxlength="42"></label>
        <label v-if="editCount && editedTerms.length > 1" class="edit-field">映射主名
          <select v-model="draft.primary" aria-label="映射主名" :disabled="editingLocked || !!draft.resolution?.targetId">
            <option value="">{{ preview?.primary || '沿用或随原位置修正' }}</option>
            <option v-for="term in editedTerms" :key="term" :value="term">{{ term }}</option>
          </select>
        </label>
        <div class="edit-position-heading">出现位置 <span>{{ codeRebind ? `已选 ${selectedRows.length} / ` : wordChanged ? `已选 ${editCount} / ` : '' }}{{ editRows.length }} 处</span></div>
      </template>
      <div v-if="draft.mode === 'create'" class="adjust-fields">
        <label>类别<select v-model="draft.type" aria-label="类别" :disabled="editingLocked"><option v-for="(label, key) in labels" :key="key" :value="key">{{ label }}</option></select></label>
        <label>代号<input ref="codeInput" v-model="draft.code" :disabled="editingLocked" :placeholder="preview?.code || '自动分配'"></label>
      </div>
      <MappingTargetPicker v-if="draft.mode === 'bind' && !draft.fixedTarget" v-model="draft.groupId"
        :groups="groups" :disabled="editingLocked" autofocus />
      <div v-if="draft.mode === 'alias'" class="toolbar">
        <button class="button small" :disabled="locked" @click="emit('add')">添加位置</button>
        <button class="button small" :disabled="locked || !selectedRows.length" @click="emit('remove')">移出所选位置</button>
      </div>
      <form v-if="selecting" class="candidate-search" @submit.prevent="emit('search')">
        <input ref="candidateInput" v-model="draft.query" type="search" aria-label="查找同文位置" placeholder="输入原词找位置">
        <select v-model="draft.scope" aria-label="候选材料范围">
          <option value="all">全部材料</option><option value="current">本份材料</option>
        </select>
        <button class="button small" :disabled="locked || !draft.query.trim()">查找</button>
      </form>
      <div v-if="draft.mode === 'remove'" class="disposition" aria-label="移出后处理">
        <label><input v-model="draft.keep" type="radio" :value="false">转待核</label>
        <label><input v-model="draft.keep" type="radio" :value="true">保留原文</label>
      </div>
    </div>
    <div v-if="selecting && resultCount" class="candidate-batch">
      <label>
        <input type="checkbox" :checked="allSelected" :disabled="editingLocked"
          :indeterminate="checkedResults > 0 && !allSelected" aria-label="全选本次结果" @change="toggleResults">
        <span>{{ allSelected ? '取消全选' : '全选本次结果' }}</span>
      </label>
      <span>{{ checkedResults }} / {{ resultCount }} 处</span>
    </div>
    <div v-if="editing" class="adjust-results">
      <p v-if="pickingSource" class="edit-position-status" role="status">选择要取词的那一处。</p>
      <p v-if="wordChanged && !originalWord.trim()" class="edit-position-status">请输入原词。</p>
      <p v-else-if="wordChanged && !suggestions" class="edit-position-status" role="status">正在匹配原文位置…</p>
      <p v-else-if="suggestions?.error" class="form-error" role="alert">{{ suggestions.error }}</p>
      <div v-if="clearMatches.length > 1" class="edit-batch">
        <button type="button" class="button small" :disabled="editingLocked" @click="toggleClearMatches">{{ allClearSelected ? '取消明确匹配' : '全选明确匹配' }}</button>
      </div>
      <div v-for="{ key, row, options, selected: replacement } in editRows" :key="key" class="mapping-edit-row"
        :class="{ current: rangeFor?.materialId === row.materialId && rangeFor.id === row.itemId, checked: !!replacement }">
        <div class="mapping-edit-actions">
          <span class="occurrence-meta">{{ row.title }} · 第 {{ row.line }} 行</span>
          <button class="button small quiet candidate-locate" :disabled="locked"
            @click="replacement ? emit('jump', { ...replacement, itemId: null }) : locate(row)">定位原文</button>
        </div>
        <label v-if="codeRebind" class="candidate-select edit-choice">
          <input type="checkbox" :disabled="editingLocked" :checked="draft.chosen.has(key)" @change="toggle(row, $event)">
          <span class="snippet">{{ row.before }}<b>{{ row.original }}</b>{{ row.after }}</span>
        </label>
        <p v-else class="snippet">{{ row.before }}<b>{{ row.original }}</b>{{ row.after }}</p>
        <div v-for="option in options" :key="positionKey(option.position)" class="edited-range">
          <label class="candidate-select edit-choice">
            <input type="checkbox" :disabled="editingLocked"
              :checked="!!replacement && positionKey(replacement) === positionKey(option.position)"
              @change="toggleEdit(key, option, ($event.target as HTMLInputElement).checked)">
            <span class="candidate-info">
              <span class="occurrence-meta">{{ row.original }} → {{ option.position.original }}<span v-if="option.overlap" class="warning"> · 覆盖其他标注</span></span>
              <span v-if="options.length > 1" class="snippet">{{ option.position.before }}<b>{{ option.position.original }}</b>{{ option.position.after }}</span>
            </span>
          </label>
          <button v-if="options.length > 1" class="button small quiet candidate-locate" :disabled="locked"
            @click="emit('jump', { ...option.position, itemId: null })">定位候选</button>
        </div>
        <div v-if="pickingSource || (wordChanged && suggestions && !options.length && !suggestions.error)" class="edited-range">
          <span v-if="wordChanged && suggestions && !options.length && !suggestions.error">本处未找到匹配</span>
          <button class="button small quiet" :disabled="locked" @click="takeFrom(row)">从这处取词</button>
        </div>
      </div>
    </div>
    <div v-else-if="!merging" class="adjust-results">
      <p v-if="!visibleRows.length" class="muted-empty">{{ draft.searched ? '没有找到同文位置' : '在原文选词，或查找同文位置' }}</p>
      <div v-for="row in visibleRows" :key="positionKey(row)" class="candidate-row"
        :class="{ checked: draft.chosen.has(positionKey(row)), current: row.materialId === materialId && (located === positionKey(row) || (row.itemId !== null && row.itemId === selected)) }">
        <label class="candidate-select">
          <input type="checkbox" :aria-label="`选择${row.title}第 ${row.line} 行的${row.original}`"
            :disabled="editingLocked" :checked="draft.chosen.has(positionKey(row))" @change="toggle(row, $event)">
          <span class="candidate-info">
            <span class="occurrence-meta">{{ row.title }} · 第 {{ row.line }} 行
              <span v-if="selecting && draft.searched && !draft.searchKeys.has(positionKey(row))" class="candidate-origin"> · 已保留的选择</span>
              <span v-if="row.conflict" class="candidate-origin warning"> · {{ row.conflict }}</span>
              <span v-else-if="row.group" class="candidate-origin"> · {{ row.replacement }}</span>
              <span v-else-if="row.action === 'review'" class="candidate-origin warning"> · 待核</span>
            </span>
            <span class="snippet">{{ row.before }}<b>{{ row.original }}</b>{{ row.after }}</span>
          </span>
        </label>
        <button type="button" class="button small quiet candidate-locate"
          :disabled="locked" @click="locate(row)">定位原文 <span aria-hidden="true">↗</span></button>
      </div>
    </div>
    <div class="adjust-footer">
      <div class="adjust-impact-scroll">
        <div v-for="change in sourceImpacts" :key="change.id" class="adjust-impact">
          <span>{{ change.primary }} {{ change.code }} · 移出 {{ change.moved }} 处{{ change.remaining ? '' : '，原组将移除' }}</span>
          <span v-if="change.terms.length === 1">恢复原词改为「{{ change.nextPrimary }}」</span>
          <label v-else-if="change.terms.length > 1">恢复原词
            <select :value="draft.primaries[change.id] || change.nextPrimary" :aria-label="`为${change.primary}选择恢复原词`" :disabled="editingLocked"
              @change="draft.primaries[change.id] = ($event.target as HTMLSelectElement).value">
              <option v-for="term in change.terms" :key="term" :value="term">{{ term }}</option>
            </select>
          </label>
        </div>
        <p v-if="error" class="form-error" role="alert">{{ error }}</p>
        <section v-if="conflict" class="edit-conflicts" aria-label="映射冲突">
          <h3>映射冲突</h3>
          <p>{{ mergePrompt?.message }}</p>
          <p v-if="codeRebind && !selectedRows.length">勾选位置后，可仅改绑这些位置。</p>
          <div v-for="group in conflictGroups" :key="group.id" class="edit-conflict-target">
            <span><strong>{{ group.primary }} → {{ group.code }}</strong> · {{ kindLabel(group.type) }} · {{ group.occurrences.length }} 处</span>
            <div v-if="occupiedCodes(group).length" class="conflict-locations">
              <button v-for="item in occupiedCodes(group)" :key="item.code" class="button small quiet" :disabled="locked"
                @click="locateCode(group, item.code)">{{ item.kind === 'alias' ? '派生代号' : '主代号' }} {{ item.code }} · 定位原文</button>
            </div>
            <button v-else class="button small quiet" :disabled="locked" @click="locateCode(group)">定位冲突映射</button>
            <div class="toolbar">
              <button v-if="mergeOptions.get(group.id)?.whole" class="button small" :disabled="editingLocked"
                :aria-pressed="draft.resolution?.mode === 'whole' && draft.resolution.targetId === group.id"
                @click="resolve('whole', group.id)">合并整组</button>
              <button v-if="mergeOptions.get(group.id)?.selected && (editCount || selectedRows.length)" class="button small" :disabled="editingLocked"
                :aria-pressed="draft.resolution?.mode === 'selected' && draft.resolution.targetId === group.id"
                @click="resolve('selected', group.id)">{{ draft.mode === 'create' ? '绑定到已有映射' : '仅改绑所选位置' }}</button>
            </div>
          </div>
          <button v-if="conflict.canRetain" class="button small" :disabled="editingLocked"
            :aria-pressed="draft.resolution?.mode === 'retain'" @click="resolve('retain')">保留本组，应用范围调整</button>
          <button v-if="conflict.reason === 'code'" class="button small quiet" :disabled="editingLocked" @click="returnToCode">返回改代号</button>
        </section>
        <div v-if="previewIssue?.positions" class="conflict-locations">
          <button v-for="row in previewIssue.positions" :key="positionKey(row)" class="button small quiet"
            :disabled="locked" @click="locate(row)">{{ row.title }} · 第 {{ row.line }} 行 · {{ row.original }}</button>
        </div>
        <button v-else-if="draft.issue && !draft.issue.stalePreview" class="button small quiet" @click="emit('issue', draft.issue)">定位冲突</button>
        <template v-if="preview && affected.length">
          <h3 class="impact-title">影响预览 <span>{{ affected.length }} 份材料 <template v-if="removedCount">· {{ removedCount }} 处旧标注将移除</template></span></h3>
          <p v-if="mergeTarget" class="count">{{ target ? `${target.primary} ${target.code} → ` : '' }}{{ mergeTarget.primary }} {{ mergeTarget.code }}</p>
          <div v-if="mergeTarget && !merging" class="toolbar">
            <button v-if="draft.resolution?.mode === 'whole' && !wordChanged" class="button small quiet" :disabled="locked"
              @click="draft.resolution = null">选择要改绑的位置</button>
            <button class="button small quiet" :disabled="locked" @click="returnToCode">返回改代号</button>
          </div>
          <p v-if="restoredCount" class="impact-restored-count">{{ restoredCount }} 段原文将恢复显示</p>
          <section v-for="doc in affected" :key="doc.materialId" class="impact-material">
            <h4>{{ doc.title }}</h4>
            <article v-for="change in doc.changes" :key="change.start" class="impact-entry">
              <button type="button" class="button small quiet impact-locate" :disabled="locked"
                @click="emit('jump', { materialId: doc.materialId, itemId: null, start: change.start, end: change.end })">第 {{ change.line }} 行 · 定位原文</button>
              <dl>
                <dt>改前</dt><dd>{{ change.before }}</dd>
                <dt>改后</dt><dd><template v-for="(part, index) in change.after" :key="index"><mark v-if="part.restored" title="恢复显示的原文">{{ part.text }}</mark><template v-else>{{ part.text }}</template></template></dd>
              </dl>
            </article>
          </section>
        </template>
        <p v-else-if="!preview && !error && (editing || merging ? previewing : needsPreview && selectedRows.length && (draft.mode !== 'bind' || draft.groupId))"
          class="impact-wait" role="status">正在更新影响预览…</p>
      </div>
      <div v-if="draft.mode !== 'alias'" class="apply-bar" :class="{ 'edit-apply': editing }">
        <span class="destination" :title="editing ? editSummary : destination">{{ editing ? editSummary : (destination || (merging ? '' : `已选 ${selectedRows.length} 处`)) }}</span>
        <button class="button primary" :disabled="!canApply" @click="emit('apply')">{{ applyLabel }}</button>
      </div>
    </div>
  </section>
</template>
