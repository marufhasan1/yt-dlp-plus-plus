<script setup lang="ts">
import { useRoute } from 'vue-router'
import ThemeToggle from '@/components/common/ThemeToggle.vue'

const route = useRoute()
</script>

<template>
  <header class="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-border bg-bg/80 px-8">
    <div class="min-w-0">
      <h1 class="truncate text-[15px] font-semibold tracking-tight" data-testid="page-title">
        {{ route.meta.title }}
      </h1>
      <p v-if="route.meta.description" class="truncate text-xs text-fg-subtle">
        {{ route.meta.description }}
      </p>
    </div>
    <ThemeToggle />
  </header>
</template>
