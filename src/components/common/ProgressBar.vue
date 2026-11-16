<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  /** 0–1, or null for an indeterminate bar. */
  value: number | null
  label: string
}>()

const percent = computed(() => (props.value === null ? null : Math.round(Math.min(1, Math.max(0, props.value)) * 100)))
</script>

<template>
  <div
    role="progressbar"
    :aria-label="label"
    aria-valuemin="0"
    aria-valuemax="100"
    :aria-valuenow="percent ?? undefined"
    class="relative h-1.5 w-full overflow-hidden rounded-full bg-surface-3"
  >
    <div
      v-if="percent !== null"
      class="h-full rounded-full bg-accent transition-[width] duration-200 ease-out"
      :style="{ width: `${percent}%` }"
    />
    <div v-else class="indeterminate absolute inset-y-0 w-1/3 rounded-full bg-accent" />
  </div>
</template>

<style scoped>
.indeterminate {
  animation: slide 1.2s ease-in-out infinite;
}

@keyframes slide {
  from {
    left: -33%;
  }
  to {
    left: 100%;
  }
}
</style>
