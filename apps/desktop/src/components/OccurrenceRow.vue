<script setup lang="ts">
import type { Occurrence } from '../model';

defineProps<{ row: Occurrence; current?: boolean; disabled?: boolean }>();
defineEmits<{ locate: [row: Occurrence] }>();
</script>

<template>
  <button class="occurrence" :class="{ current }" :disabled="disabled" @click="$emit('locate', row)">
    <span class="occurrence-head">
      <span class="occurrence-meta">{{ row.title }} · 第 {{ row.line }} 行<slot /></span>
    </span>
    <span class="snippet">{{ row.before }}<b>{{ row.original }}</b>{{ row.after }}</span>
  </button>
</template>
