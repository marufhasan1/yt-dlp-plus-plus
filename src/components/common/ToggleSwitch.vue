<script setup lang="ts">
defineProps<{
  label: string
  disabled?: boolean
}>()

const model = defineModel<boolean>({ required: true })
</script>

<template>
  <button
    type="button"
    role="switch"
    :aria-checked="model"
    :aria-label="label"
    :disabled="disabled"
    class="relative inline-flex h-5.5 w-9.5 shrink-0 items-center rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-50"
    :class="model ? 'border-accent bg-accent' : 'border-border-strong bg-surface-3'"
    @click="model = !model"
  >
    <span
      class="inline-block size-4 rounded-full bg-white shadow-card transition-transform"
      :class="model ? 'translate-x-[17px]' : 'translate-x-[2px]'"
      aria-hidden="true"
    />
  </button>
</template>
