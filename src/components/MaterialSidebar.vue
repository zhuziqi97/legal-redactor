<script setup lang="ts">
import { computed, nextTick, ref, shallowRef, watch } from 'vue';
import { positionKey, prettyError, type MaterialSummary, type Occurrence } from '../model';
import MappingMenu from './MappingMenu.vue';

const props = defineProps<{
  documents: MaterialSummary[]; current: string | undefined; collapsed: boolean;
  locked: boolean; scanning: string | null;
  queued: string[]; phases: Record<string, string>; errors: Record<string, string>;
  revision: number; findProject: (text: string) => Promise<Occurrence[]>;
}>();
const emit = defineEmits<{ toggle: []; add: []; open: [id: string]; settings: []; locate: [row: Occurrence];
  manage: [action: 'rename' | 'edit' | 'delete', id: string] }>();
const searching = ref(false);
const searchInput = ref<HTMLInputElement>();
const query = ref('');
const submitted = ref('');
const matches = shallowRef<Occurrence[] | null>(null);
const error = ref('');
let requestId = 0;
const groups = computed(() => {
  const materials = new Map<string, Occurrence[]>();
  for (const row of matches.value ?? []) {
    const rows = materials.get(row.materialId);
    if (rows) rows.push(row);
    else materials.set(row.materialId, [row]);
  }
  return [...materials.values()];
});
const status = (id: string) => props.phases[id]?.split(' · ')[0] || '正在分析';

async function toggleSearch() {
  searching.value = !searching.value;
  if (searching.value) {
    await nextTick();
    searchInput.value?.focus();
  }
}

async function search() {
  const text = query.value.trim();
  if (!text) return;
  const id = ++requestId;
  submitted.value = text;
  matches.value = null;
  error.value = '';
  try {
    const rows = await props.findProject(text);
    if (id === requestId) matches.value = rows;
  } catch (failure) {
    if (id === requestId) error.value = prettyError(failure);
  }
}

watch(query, () => {
  requestId++;
  submitted.value = '';
  matches.value = null;
  error.value = '';
});
watch(() => props.revision, () => { if (submitted.value) void search(); });
</script>

<template>
  <nav class="materials" :class="{ collapsed }" aria-label="材料导航">
    <div class="materials-heading">
      <button class="button quiet icon-button" :aria-label="collapsed ? '展开材料栏' : '收起材料栏'"
        :title="collapsed ? '展开材料栏' : '收起材料栏'" :aria-expanded="!collapsed" @click="emit('toggle')">
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true">
          <rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>
        </svg>
      </button>
      <h2 v-if="!collapsed">材料</h2>
      <button v-if="!collapsed" class="button quiet icon-button" aria-label="搜索项目" title="搜索项目"
        :aria-pressed="searching" :disabled="!documents.length && !searching" @click="toggleSearch">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
          <circle cx="10.5" cy="10.5" r="5.5"/><path d="m15 15 5 5"/>
        </svg>
      </button>
      <button class="button quiet icon-button add-material" :disabled="locked" aria-label="添加材料" title="添加材料" @click="emit('add')">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
      </button>
    </div>
    <template v-if="!collapsed && searching">
      <form class="project-search" aria-label="项目搜索" @submit.prevent="search">
        <input ref="searchInput" v-model="query" type="search" aria-label="搜索项目" placeholder="搜索项目原文"
          @keydown.escape.stop="toggleSearch">
        <button class="button small" :disabled="!query.trim()">查找</button>
      </form>
      <div class="material-list project-results" aria-label="项目搜索结果">
        <p v-if="error" class="form-error" role="alert">{{ error }}</p>
        <p v-else-if="submitted && !matches" class="muted-empty" role="status">正在查找</p>
        <p v-else-if="matches && !matches.length" class="muted-empty">项目中没有匹配</p>
        <section v-for="rows in groups" :key="rows[0].materialId" class="project-result-group">
          <h3>{{ rows[0].title }} <span class="count">{{ rows.length }} 处</span></h3>
          <button v-for="row in rows" :key="positionKey(row)" class="occurrence" :disabled="locked" @click="emit('locate', row)">
            <span class="occurrence-meta">第 {{ row.line }} 行</span>
            <span class="snippet">{{ row.before }}<b>{{ row.original }}</b>{{ row.after }}</span>
          </button>
        </section>
      </div>
    </template>
    <div v-else-if="!collapsed" class="material-list">
      <div v-for="doc in documents" :key="doc.id" class="material-entry">
      <button class="material-row"
        :aria-current="current === doc.id ? 'page' : undefined" :title="doc.title" :disabled="locked"
        @click="emit('open', doc.id)">
        <svg width="16" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.55" aria-hidden="true">
          <path d="M13 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10z"/><path d="M13 3v7h7M8 14h8M8 17h6"/>
        </svg>
        <span class="material-name">{{ doc.title }}</span>
        <small v-if="scanning === doc.id" :title="phases[doc.id]">{{ status(doc.id) }}</small>
        <small v-else-if="queued.includes(doc.id)">排队中</small>
        <small v-else-if="errors[doc.id]" class="material-attention" :title="errors[doc.id]">分析失败</small>
        <small v-else-if="doc.status === 'unrecognized'">未识别</small>
        <small v-else-if="doc.pending" class="material-attention">待核 {{ doc.pending }}</small>
        <small v-else-if="doc.exportState === 'changed'" class="material-attention">需重导</small>
      </button>
      <MappingMenu :label="`${doc.title}的材料操作`" :disabled="locked">
        <button @click="emit('manage', 'rename', doc.id)">重命名</button>
        <button @click="emit('manage', 'edit', doc.id)">编辑原文</button>
        <button class="danger" @click="emit('manage', 'delete', doc.id)">删除材料</button>
      </MappingMenu>
      </div>
    </div>
    <button class="button small quiet inference-settings" aria-label="推理设置" title="推理设置" @click="emit('settings')">
      <svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" aria-hidden="true"><path d="M3 5h14M3 10h14M3 15h14M7 2v6m6-1v6m-5-1v6"/></svg>
      <span v-if="!collapsed">推理设置</span>
    </button>
  </nav>
</template>
