<script setup lang="ts">
import { computed } from 'vue'
import { TriangleAlert } from '@lucide/vue'
import type { EngineSource, EngineStatus } from '@shared/types/engines'
import { ENGINE_LABELS } from '@/stores/engines.store'
import EngineHealthBadge from './EngineHealthBadge.vue'

const props = defineProps<{ status: EngineStatus }>()

const SOURCE_LABELS: Record<EngineSource, string> = {
  managed: 'Managed by the app',
  bundled: 'Bundled with the app',
  system: 'System installation'
}

const problems = computed(() => props.status.problems.filter((problem) => problem.code !== 'NOT_FOUND'))
</script>

<template>
  <div class="px-5 py-4" :data-testid="`engine-${status.id}`">
    <div class="flex items-center justify-between gap-4">
      <div class="flex min-w-0 items-center gap-2.5">
        <span class="text-[13.5px] font-medium">{{ ENGINE_LABELS[status.id] }}</span>
        <EngineHealthBadge :health="status.health" />
      </div>
      <span
        v-if="status.version"
        class="selectable font-mono text-[12.5px] text-fg-muted"
        :title="status.build ?? undefined"
        data-testid="engine-version"
      >
        {{ status.version }}
      </span>
    </div>

    <dl v-if="status.path" class="mt-2 grid grid-cols-[72px_1fr] gap-x-3 gap-y-1 text-[12.5px]">
      <dt class="text-fg-subtle">Source</dt>
      <dd class="text-fg-muted">{{ status.source ? SOURCE_LABELS[status.source] : '—' }}</dd>
      <dt class="text-fg-subtle">Location</dt>
      <dd class="selectable truncate font-mono text-fg-muted" :title="status.path">{{ status.path }}</dd>
    </dl>

    <ul v-if="problems.length > 0" class="mt-2.5 space-y-1">
      <li
        v-for="problem in problems"
        :key="problem.code"
        class="flex items-start gap-2 text-[12.5px]"
        :class="status.health === 'broken' ? 'text-danger' : 'text-warning'"
      >
        <TriangleAlert :size="14" class="mt-0.5 shrink-0" aria-hidden="true" />
        <span class="selectable">{{ problem.message }}</span>
      </li>
    </ul>
  </div>
</template>
