<script setup lang="ts">
import { computed } from 'vue'
import { LoaderCircle } from '@lucide/vue'
import type { UpdateState } from '@shared/types/updates'

const props = defineProps<{ state: UpdateState }>()

const STATES: Record<UpdateState, { label: string; classes: string; busy?: boolean }> = {
  unknown: { label: 'Not checked yet', classes: 'bg-surface-3 text-fg-muted' },
  checking: { label: 'Checking', classes: 'bg-accent-soft text-accent', busy: true },
  'up-to-date': { label: 'Up to date', classes: 'bg-success-soft text-success' },
  available: { label: 'Update available', classes: 'bg-accent-soft text-accent' },
  waiting: { label: 'Waiting', classes: 'bg-warning-soft text-warning' },
  downloading: { label: 'Downloading', classes: 'bg-accent-soft text-accent', busy: true },
  installing: { label: 'Installing', classes: 'bg-accent-soft text-accent', busy: true },
  ready: { label: 'Ready to install', classes: 'bg-accent-soft text-accent' },
  updated: { label: 'Updated', classes: 'bg-success-soft text-success' },
  failed: { label: 'Failed', classes: 'bg-danger-soft text-danger' },
  unavailable: { label: 'Not available', classes: 'bg-surface-3 text-fg-muted' }
}
const view = computed(() => STATES[props.state])
</script>

<template>
  <span class="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium" :class="view.classes" data-testid="update-state" :data-state="state">
    <LoaderCircle v-if="view.busy" :size="11" class="animate-spin" aria-hidden="true" />
    {{ view.label }}
  </span>
</template>
