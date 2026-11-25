<script setup lang="ts">
import { ref, useId } from 'vue';

defineProps<{ label: string; disabled: boolean }>();
const id = useId();
const popup = ref<HTMLElement>();

function close() {
  popup.value?.hidePopover();
}
</script>

<template>
  <button class="mapping-more" :aria-label="label" title="更多操作" :disabled="disabled" :popovertarget="id">
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <circle cx="3" cy="8" r="1.15" />
      <circle cx="8" cy="8" r="1.15" />
      <circle cx="13" cy="8" r="1.15" />
    </svg>
  </button>
  <div :id="id" ref="popup" popover="auto" class="mapping-menu" @click="close">
    <slot />
  </div>
</template>
