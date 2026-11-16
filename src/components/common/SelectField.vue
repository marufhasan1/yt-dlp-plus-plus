<script setup lang="ts" generic="T extends string | number">
import { ChevronDown } from '@lucide/vue'

export interface SelectOption<V> {
  value: V
  label: string
  disabled?: boolean
}

defineProps<{
  options: readonly SelectOption<T>[]
  label: string
  disabled?: boolean
}>()

const model = defineModel<T>({ required: true })

function onChange(event: Event, options: readonly SelectOption<T>[]): void {
  const index = (event.target as HTMLSelectElement).selectedIndex
  const option = options[index]
  if (option) model.value = option.value
}
</script>

<template>
  <div class="relative">
    <select
      :aria-label="label"
      :disabled="disabled"
      class="h-9 w-full cursor-pointer appearance-none rounded-lg border border-border bg-surface pr-9 pl-3 text-[13.5px] text-fg shadow-card transition-colors hover:border-border-strong disabled:cursor-not-allowed disabled:opacity-50"
      @change="onChange($event, options)"
    >
      <option
        v-for="option in options"
        :key="String(option.value)"
        :value="String(option.value)"
        :selected="option.value === model"
        :disabled="option.disabled"
      >
        {{ option.label }}
      </option>
    </select>
    <ChevronDown
      :size="16"
      class="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-fg-subtle"
      aria-hidden="true"
    />
  </div>
</template>
