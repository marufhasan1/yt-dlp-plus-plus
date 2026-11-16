<script setup lang="ts">
import { computed } from 'vue'
import type { EngineHealth } from '@shared/types/engines'

const props = defineProps<{ health: EngineHealth }>()

const APPEARANCE: Record<EngineHealth, { label: string; classes: string; dot: string }> = {
  ok: { label: 'Ready', classes: 'bg-success-soft text-success', dot: 'bg-success' },
  degraded: { label: 'Limited', classes: 'bg-warning-soft text-warning', dot: 'bg-warning' },
  broken: { label: 'Needs repair', classes: 'bg-danger-soft text-danger', dot: 'bg-danger' },
  missing: { label: 'Not installed', classes: 'bg-surface-3 text-fg-muted', dot: 'bg-fg-subtle' },
  checking: { label: 'Checking…', classes: 'bg-surface-3 text-fg-muted', dot: 'bg-fg-subtle animate-pulse' }
}

const appearance = computed(() => APPEARANCE[props.health])
</script>

<template>
  <span
    class="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11.5px] font-medium"
    :class="appearance.classes"
    :data-health="health"
  >
    <span class="size-1.5 rounded-full" :class="appearance.dot" aria-hidden="true" />
    {{ appearance.label }}
  </span>
</template>
