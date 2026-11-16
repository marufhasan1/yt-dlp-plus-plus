<script setup lang="ts">
import { computed, ref } from 'vue'
import { Moon, Sun } from '@lucide/vue'
import { errorMessage } from '@/api/client'
import { useTheme } from '@/composables/useTheme'
import { useToastStore } from '@/stores/toast.store'

const { resolved, toggle } = useTheme()
const toasts = useToastStore()
const busy = ref(false)

const label = computed(() => (resolved.value === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'))

async function onClick(): Promise<void> {
  busy.value = true
  try {
    await toggle()
  } catch (error) {
    toasts.error('Theme could not be changed', errorMessage(error))
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <button
    type="button"
    class="flex size-9 items-center justify-center rounded-lg text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg disabled:opacity-50"
    :aria-label="label"
    :title="label"
    :disabled="busy"
    data-testid="theme-toggle"
    @click="onClick"
  >
    <Sun v-if="resolved === 'dark'" :size="18" aria-hidden="true" />
    <Moon v-else :size="18" aria-hidden="true" />
  </button>
</template>
