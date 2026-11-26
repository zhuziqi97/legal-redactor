<script setup lang="ts">
import type { AdjustmentPreview } from '../model';

defineProps<{
  source: AdjustmentPreview['sources'][number]; value?: string; locked?: boolean; showCode?: boolean;
}>();
defineEmits<{ choose: [original: string] }>();
</script>

<template>
  <div v-if="source.nextPrimary" class="recovery-choice">
    <span v-if="showCode">{{ source.code }}</span>
    <label v-if="source.terms.length > 1">
      <span>恢复原词 {{ source.primary }} →</span>
      <select :value="value || ''" :aria-label="`为${source.primary}选择恢复原词`" :disabled="locked"
        @change="$emit('choose', ($event.target as HTMLSelectElement).value)">
        <option value="" disabled>选择原词</option>
        <option v-for="term in source.terms" :key="term" :value="term">{{ term }}</option>
      </select>
    </label>
    <span v-else>恢复原词 {{ source.primary }} → {{ source.nextPrimary }}</span>
  </div>
</template>

<style scoped>
.recovery-choice, .recovery-choice label {
  display: flex; align-items: baseline; flex-wrap: wrap; gap: 5px 8px; min-width: 0; overflow-wrap: anywhere;
}
.recovery-choice select { min-height: 28px; max-width: 100%; }
</style>
