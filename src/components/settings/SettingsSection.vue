<script setup lang="ts">
defineProps<{
  title: string
  description?: string
}>()
</script>

<template>
  <section class="rounded-xl border border-border bg-surface shadow-card">
    <header class="border-b border-border px-5 py-4">
      <h2 class="text-sm font-semibold tracking-tight">{{ title }}</h2>
      <p v-if="description" class="mt-0.5 text-[13px] text-fg-muted">{{ description }}</p>
    </header>
    <div class="divide-y divide-border">
      <slot />
    </div>
  </section>
</template>
