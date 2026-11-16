<script setup lang="ts">
defineProps<{
  label: string
  description?: string
}>()
</script>

<template>
  <div class="flex items-center justify-between gap-6 px-5 py-4">
    <div class="min-w-0">
      <p class="text-[13.5px] font-medium">{{ label }}</p>
      <p v-if="description" class="mt-0.5 text-[13px] text-fg-muted">{{ description }}</p>
    </div>
    <div class="flex shrink-0 items-center">
      <slot />
    </div>
  </div>
</template>
