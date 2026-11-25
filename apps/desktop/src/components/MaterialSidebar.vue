<script setup lang="ts">
import { computed, ref } from 'vue';
import { type MaterialSummary } from '../model';
import MappingMenu from './MappingMenu.vue';

const props = defineProps<{
  documents: MaterialSummary[]; current: string | undefined; collapsed: boolean;
  locked: boolean; scanning: string | null;
  queued: string[]; phases: Record<string, string>; errors: Record<string, string>;
}>();
const emit = defineEmits<{ toggle: []; add: []; open: [id: string]; settings: []; manage: [action: 'rename' | 'edit' | 'delete', id: string] }>();
const query = ref('');
const visible = computed(() => props.documents.filter(doc => doc.title.toLowerCase().includes(query.value.trim().toLowerCase())));
const status = (id: string) => props.phases[id]?.split(' · ')[0] || '正在分析';
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
      <button class="button quiet icon-button add-material" :disabled="locked" aria-label="添加材料" title="添加材料" @click="emit('add')">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
      </button>
    </div>
    <div v-if="!collapsed" class="material-list">
      <input v-if="documents.length" class="material-filter" v-model="query" type="search" aria-label="查找材料" placeholder="查找材料">
      <p v-if="query && !visible.length" class="muted-empty">没有匹配的材料</p>
      <div v-for="doc in visible" :key="doc.id" class="material-entry">
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
