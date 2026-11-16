<script setup lang="ts" generic="T extends string">
import type { Component } from 'vue'

export interface SegmentOption<V extends string> {
  value: V
  label: string
  icon?: Component
}

defineProps<{
  options: readonly SegmentOption<T>[]
  label: string
  disabled?: boolean
}>()

const model = defineModel<T>({ required: true })
</script>

<template>
  <div
    role="radiogroup"
    :aria-label="label"
    class="inline-flex rounded-lg border border-border bg-surface-2 p-0.5"
  >
    <button
      v-for="option in options"
      :key="option.value"
      type="button"
      role="radio"
      :aria-checked="model === option.value"
      :disabled="disabled"
      :data-testid="`segment-${option.value}`"
      class="inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-[13px] font-medium transition-colors disabled:opacity-60"
      :class="
        model === option.value
          ? 'bg-surface text-fg shadow-card'
          : 'text-fg-muted hover:text-fg'
      "
      @click="model = option.value"
    >
      <component :is="option.icon" v-if="option.icon" :size="15" aria-hidden="true" />
      {{ option.label }}
    </button>
  </div>
</template>
