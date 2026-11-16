<script setup lang="ts">
import { computed } from 'vue'
import { CircleAlert, Download, Wrench, X } from '@lucide/vue'
import type { EngineId, InstallStage, InstallTarget } from '@shared/types/engines'
import AppButton from '@/components/common/AppButton.vue'
import ProgressBar from '@/components/common/ProgressBar.vue'
import EngineUpdateRow from '@/components/updates/EngineUpdateRow.vue'
import { useEnginesStore } from '@/stores/engines.store'
import { useUpdatesStore } from '@/stores/updates.store'
import { formatBytes } from '@/utils/format'
import EngineRow from './EngineRow.vue'

const props = defineProps<{
  target: InstallTarget
  title: string
  description: string
  engines: readonly EngineId[]
}>()

const emit = defineEmits<{ install: [target: InstallTarget]; cancel: [] }>()
const store = useEnginesStore()
const updates = useUpdatesStore()
const update = computed(() => updates.snapshot?.components[props.target] ?? null)

const statuses = computed(() => {
  const snapshot = store.snapshot
  return snapshot ? props.engines.map((id) => snapshot.engines[id]) : []
})
const provider = computed(() => store.snapshot?.providers[props.target] ?? null)
const progress = computed(() => (store.installing?.target === props.target ? store.installing : null))
const lastFailure = computed(() => {
  const install = store.snapshot?.install
  return install?.target === props.target && install.stage === 'failed' ? install.error : null
})

const action = computed<{ label: string; variant: 'primary' | 'secondary'; icon: typeof Download } | null>(() => {
  if (!provider.value || statuses.value.length === 0) return null
  const healths = statuses.value.map((status) => status.health)
  if (healths.includes('checking')) return null
  if (healths.every((health) => health === 'missing')) return { label: 'Install', variant: 'primary', icon: Download }
  if (healths.some((health) => health === 'missing' || health === 'broken')) {
    return { label: 'Repair', variant: 'primary', icon: Wrench }
  }
  // A working engine with an update available is updated from the update row instead.
  if (update.value?.state === 'available' || update.value?.state === 'waiting') return null
  if (statuses.value.every((status) => status.source === 'managed')) {
    return { label: 'Reinstall', variant: 'secondary', icon: Download }
  }
  return { label: 'Install managed copy', variant: 'secondary', icon: Download }
})

const STAGE_LABELS: Record<InstallStage, string> = {
  resolving: 'Finding the latest release…',
  downloading: 'Downloading…',
  verifying: 'Verifying integrity…',
  extracting: 'Extracting…',
  installing: 'Installing…',
  completed: 'Installed',
  failed: 'Failed',
  cancelled: 'Cancelled'
}

const progressText = computed(() => {
  const p = progress.value
  if (!p) return ''
  const stage = STAGE_LABELS[p.stage]
  const version = p.version ? ` ${p.version}` : ''
  if (p.stage !== 'downloading') return `${stage}${version}`
  const size = p.totalBytes ? `${formatBytes(p.receivedBytes)} of ${formatBytes(p.totalBytes)}` : formatBytes(p.receivedBytes)
  return `Downloading${version} — ${size}`
})

const progressValue = computed(() => {
  const p = progress.value
  if (!p || p.stage !== 'downloading' || !p.totalBytes) return null
  return p.receivedBytes / p.totalBytes
})
</script>

<template>
  <section class="rounded-xl border border-border bg-surface shadow-card" :data-testid="`engine-card-${target}`">
    <header class="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
      <div class="min-w-0">
        <h3 class="text-sm font-semibold tracking-tight">{{ title }}</h3>
        <p class="mt-0.5 text-[13px] text-fg-muted">{{ description }}</p>
      </div>
      <AppButton
        v-if="action && !progress"
        :variant="action.variant"
        :icon="action.icon"
        :disabled="store.installing !== null || store.snapshot?.checking"
        :data-testid="`engine-install-${target}`"
        @click="emit('install', target)"
      >
        {{ action.label }}
      </AppButton>
    </header>

    <div class="divide-y divide-border">
      <EngineRow v-for="status in statuses" :key="status.id" :status="status" />
    </div>

    <EngineUpdateRow v-if="update && provider" :target="target" :update="update" />

    <div v-if="progress" class="border-t border-border px-5 py-4" :data-testid="`engine-progress-${target}`">
      <div class="mb-2 flex items-center justify-between gap-4">
        <span class="text-[13px] text-fg-muted">{{ progressText }}</span>
        <AppButton variant="ghost" :icon="X" class="h-7 px-2 text-[12.5px]" @click="emit('cancel')">Cancel</AppButton>
      </div>
      <ProgressBar :value="progressValue" :label="`Installing ${title}`" />
    </div>

    <p
      v-else-if="lastFailure"
      class="flex items-start gap-2 border-t border-border px-5 py-3 text-[12.5px] text-danger"
      role="alert"
    >
      <CircleAlert :size="14" class="mt-0.5 shrink-0" aria-hidden="true" />
      <span class="selectable">{{ lastFailure }}</span>
    </p>

    <p v-if="!provider && store.snapshot" class="border-t border-border px-5 py-3 text-[12.5px] text-fg-muted">
      No trusted build is published for this platform. Install it with your system's package manager and it will be
      detected automatically.
    </p>
  </section>
</template>
