<script setup lang="ts">
import type { Component } from 'vue'

defineProps<{
  icon: Component
  title: string
  description: string
  /** Small label above the title, e.g. to mark a feature that is still in development. */
  badge?: string
}>()
</script>

<template>
  <section
    class="flex flex-col items-center rounded-2xl border border-dashed border-border-strong bg-surface/60 px-8 py-16 text-center"
    data-testid="empty-state"
  >
    <div class="flex size-12 items-center justify-center rounded-xl bg-surface-2 text-fg-muted">
      <component :is="icon" :size="22" aria-hidden="true" />
    </div>
    <span
      v-if="badge"
      class="mt-5 rounded-full bg-accent-soft px-2.5 py-0.5 text-[11px] font-semibold tracking-wide text-accent uppercase"
    >
      {{ badge }}
    </span>
    <h2 class="mt-3 text-base font-semibold tracking-tight">{{ title }}</h2>
    <p class="mt-1.5 max-w-md text-[13.5px] text-fg-muted">{{ description }}</p>
    <div v-if="$slots.default" class="mt-6 flex items-center gap-2">
      <slot />
    </div>
  </section>
</template>
