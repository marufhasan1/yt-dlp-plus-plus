<script setup lang="ts">
import { computed } from 'vue'
import { CircleAlert, FileAudio, FileVideo, X } from '@lucide/vue'
import type { ConverterInput } from '@shared/types/converter'
import { describeSource } from '@/utils/audio'
import { formatBytes, formatDuration } from '@/utils/format'

const props = defineProps<{ input: ConverterInput; disabled?: boolean }>()
defineEmits<{ remove: [] }>()

const details = computed(() => {
  const parts = [formatBytes(props.input.sizeBytes)]
  if (props.input.durationSeconds !== null) parts.unshift(formatDuration(props.input.durationSeconds))
  return parts.join(' · ')
})
const tags = computed(() => {
  const source = props.input.source
  if (!source) return null
  return [source.artist, source.title].filter(Boolean).join(' — ') || null
})
</script>

<template>
  <li class="flex items-center gap-3 px-5 py-3" :data-testid="`input-${input.name}`" :data-valid="input.source !== null">
    <div
      class="flex size-9 shrink-0 items-center justify-center rounded-lg"
      :class="input.source ? 'bg-surface-2 text-fg-muted' : 'bg-danger-soft text-danger'"
    >
      <FileVideo v-if="input.source?.hasVideo" :size="17" aria-hidden="true" />
      <CircleAlert v-else-if="!input.source" :size="17" aria-hidden="true" />
      <FileAudio v-else :size="17" aria-hidden="true" />
    </div>

    <div class="min-w-0 flex-1">
      <p class="selectable truncate text-[13.5px] font-medium" :title="input.path">{{ input.name }}</p>
      <p v-if="input.source" class="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[12px] text-fg-muted" data-testid="input-details">
        <span>{{ describeSource(input.source) }}</span>
        <span>· {{ details }}</span>
        <span
          v-if="input.source.hasVideo"
          class="rounded bg-surface-3 px-1.5 text-[10.5px] font-semibold tracking-wide uppercase"
          title="Only the audio is converted"
        >
          Video
        </span>
        <span v-if="input.source.hasCover" class="rounded bg-surface-3 px-1.5 text-[10.5px] font-semibold tracking-wide uppercase">Cover art</span>
      </p>
      <p v-if="tags" class="selectable mt-0.5 truncate text-[11.5px] text-fg-subtle">{{ tags }}</p>
      <p v-if="input.error" class="selectable mt-0.5 text-[12px] text-danger" data-testid="input-error">{{ input.error }}</p>
    </div>

    <button
      type="button"
      class="flex size-8 shrink-0 items-center justify-center rounded-lg text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg disabled:opacity-50"
      :aria-label="`Remove ${input.name}`"
      title="Remove from the list"
      :disabled="disabled"
      data-testid="remove-input"
      @click="$emit('remove')"
    >
      <X :size="16" aria-hidden="true" />
    </button>
  </li>
</template>
