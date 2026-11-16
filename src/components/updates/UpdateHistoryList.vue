<script setup lang="ts">
import { onMounted } from 'vue'
import type { UpdateHistoryEntry } from '@shared/types/updates'
import { useUpdatesStore } from '@/stores/updates.store'
import { formatDateTime } from '@/utils/format'

const store = useUpdatesStore()
onMounted(() => void store.loadHistory().catch(() => {}))

const NAMES: Record<UpdateHistoryEntry['component'], string> = { app: 'MediaFlow', 'yt-dlp': 'yt-dlp', ffmpeg: 'FFmpeg', ffprobe: 'FFprobe', deno: 'Deno' }
const OUTCOMES: Record<UpdateHistoryEntry['status'], { label: string; classes: string }> = {
  success: { label: 'Installed', classes: 'text-success' },
  failed: { label: 'Failed', classes: 'text-danger' },
  rolled_back: { label: 'Rolled back', classes: 'text-warning' }
}
</script>

<template>
  <section class="space-y-3" data-testid="update-history">
    <div>
      <h2 class="text-sm font-semibold tracking-tight">Update history</h2>
      <p class="mt-0.5 text-[13px] text-fg-muted">Installs, updates and rollbacks, newest first.</p>
    </div>
    <div v-if="store.history.length > 0" class="overflow-hidden rounded-xl border border-border bg-surface shadow-card">
      <table class="w-full text-left text-[12.5px]">
        <thead class="border-b border-border bg-surface-2 text-fg-subtle">
          <tr>
            <th class="px-4 py-2 font-medium">Component</th>
            <th class="px-4 py-2 font-medium">Change</th>
            <th class="px-4 py-2 font-medium">Result</th>
            <th class="px-4 py-2 font-medium">When</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-border">
          <tr v-for="entry in store.history" :key="entry.id" :data-testid="`history-entry-${entry.id}`" :data-status="entry.status">
            <td class="px-4 py-2.5 font-medium">{{ NAMES[entry.component] }}</td>
            <td class="px-4 py-2.5 font-mono text-fg-muted">
              {{ entry.previousVersion ?? '—' }} → {{ entry.newVersion ?? '—' }}
              <p v-if="entry.errorMessage" class="selectable mt-0.5 font-sans text-[12px] text-fg-subtle">{{ entry.errorMessage }}</p>
            </td>
            <td class="px-4 py-2.5" :class="OUTCOMES[entry.status].classes">{{ OUTCOMES[entry.status].label }}</td>
            <td class="px-4 py-2.5 whitespace-nowrap text-fg-muted">{{ formatDateTime(entry.createdAt) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <p v-else class="rounded-xl border border-dashed border-border-strong px-5 py-6 text-center text-[13px] text-fg-muted">
      Nothing has been installed or updated yet.
    </p>
  </section>
</template>
