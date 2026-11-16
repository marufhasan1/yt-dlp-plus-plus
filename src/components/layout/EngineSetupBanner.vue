<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { TriangleAlert } from '@lucide/vue'
import AppButton from '@/components/common/AppButton.vue'
import { ENGINE_LABELS, useEnginesStore } from '@/stores/engines.store'

const route = useRoute()
const engines = useEnginesStore()

const message = computed(() => {
  const unavailable = engines.unavailable
  if (unavailable.length === 0) return null
  const names = unavailable.map((status) => ENGINE_LABELS[status.id])
  const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0]
  const verb = unavailable.every((status) => status.health === 'missing') ? 'not installed' : 'not working'
  return `${list} ${names.length > 1 ? 'are' : 'is'} ${verb}. Downloading and converting need them.`
})
</script>

<template>
  <div
    v-if="message && route.name !== 'updates'"
    class="flex items-center gap-3 border-b border-border bg-warning-soft px-8 py-2.5"
    role="status"
    data-testid="engine-banner"
  >
    <TriangleAlert :size="16" class="shrink-0 text-warning" aria-hidden="true" />
    <p class="min-w-0 flex-1 text-[13px]">
      <span class="font-medium">Media engines need setup.</span>
      <span class="ml-1 text-fg-muted">{{ message }}</span>
    </p>
    <AppButton class="h-8" @click="$router.push({ name: 'updates' })">Set up engines</AppButton>
  </div>
</template>
