<script setup lang="ts">
import type { Component } from 'vue'
import { LoaderCircle } from '@lucide/vue'

const props = withDefaults(
  defineProps<{
    variant?: 'primary' | 'secondary' | 'ghost'
    icon?: Component
    loading?: boolean
    disabled?: boolean
    type?: 'button' | 'submit'
  }>(),
  { variant: 'secondary', icon: undefined, loading: false, disabled: false, type: 'button' }
)

const VARIANT_CLASS = {
  primary: 'bg-accent text-accent-fg hover:bg-accent-hover',
  secondary: 'border border-border bg-surface text-fg shadow-card hover:bg-surface-2',
  ghost: 'text-fg-muted hover:bg-surface-2 hover:text-fg'
} as const
</script>

<template>
  <button
    :type="props.type"
    class="inline-flex h-9 items-center justify-center gap-2 rounded-lg px-3.5 text-[13.5px] font-medium transition-colors disabled:pointer-events-none disabled:opacity-50"
    :class="VARIANT_CLASS[props.variant]"
    :disabled="props.disabled || props.loading"
    :aria-busy="props.loading || undefined"
  >
    <LoaderCircle v-if="props.loading" :size="16" class="animate-spin" aria-hidden="true" />
    <component :is="props.icon" v-else-if="props.icon" :size="16" aria-hidden="true" />
    <slot />
  </button>
</template>
