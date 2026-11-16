<script setup lang="ts">
import { computed } from 'vue'
import { ArrowDownToLine } from '@lucide/vue'
import { NAVIGATION } from '@/router/navigation'
import { useAppStore } from '@/stores/app.store'
import { useConverterStore } from '@/stores/converter.store'
import { useDownloadsStore } from '@/stores/downloads.store'
import { useEnginesStore } from '@/stores/engines.store'
import { useUpdatesStore } from '@/stores/updates.store'

const appStore = useAppStore()
const engines = useEnginesStore()
const updates = useUpdatesStore()
const downloads = useDownloadsStore()
const converter = useConverterStore()
const productName = computed(() => appStore.info?.name ?? 'YT-DLP++')
const version = computed(() => (appStore.info ? `v${appStore.info.version}` : ''))
</script>

<template>
  <aside class="flex w-60 shrink-0 flex-col border-r border-border bg-surface" data-testid="sidebar">
    <div class="flex h-14 items-center gap-2.5 px-5">
      <div class="flex size-7 items-center justify-center rounded-lg bg-accent text-accent-fg">
        <ArrowDownToLine :size="16" :stroke-width="2.5" aria-hidden="true" />
      </div>
      <span class="text-[15px] font-semibold tracking-tight">{{ productName }}</span>
    </div>

    <nav class="flex-1 space-y-0.5 overflow-y-auto px-3 py-3" aria-label="Main">
      <RouterLink
        v-for="item in NAVIGATION"
        :key="item.name"
        v-slot="{ href, navigate, isExactActive }"
        :to="{ name: item.name }"
        custom
      >
        <a
          :href="href"
          :aria-current="isExactActive ? 'page' : undefined"
          :data-testid="`nav-${item.name}`"
          class="group flex items-center gap-3 rounded-lg px-3 py-2 text-[13.5px] font-medium transition-colors"
          :class="
            isExactActive
              ? 'bg-accent-soft text-accent'
              : 'text-fg-muted hover:bg-surface-2 hover:text-fg'
          "
          @click="navigate"
        >
          <component
            :is="item.icon"
            :size="17"
            :stroke-width="isExactActive ? 2.25 : 2"
            aria-hidden="true"
            class="shrink-0"
          />
          <span class="truncate">{{ item.label }}</span>
          <span
            v-if="item.name === 'downloads' && downloads.active.length > 0"
            class="ml-auto rounded-full bg-accent px-1.5 text-[11px] leading-[18px] font-semibold text-accent-fg"
            data-testid="nav-downloads-count"
          >
            {{ downloads.active.length }}
          </span>
          <span
            v-if="item.name === 'converter' && converter.active.length > 0"
            class="ml-auto rounded-full bg-accent px-1.5 text-[11px] leading-[18px] font-semibold text-accent-fg"
            data-testid="nav-converter-count"
          >
            {{ converter.active.length }}
          </span>
          <span
            v-if="item.name === 'updates' && engines.unavailable.length === 0 && updates.available.length > 0"
            class="ml-auto size-2 shrink-0 rounded-full bg-accent"
            :title="`${updates.available.length} update${updates.available.length === 1 ? '' : 's'} available`"
            data-testid="nav-updates-available"
          />
          <span
            v-if="item.name === 'updates' && engines.unavailable.length > 0"
            class="ml-auto size-2 shrink-0 rounded-full bg-warning"
            title="Media engines need attention"
            data-testid="nav-updates-attention"
          />
        </a>
      </RouterLink>
    </nav>

    <div class="border-t border-border px-5 py-3.5">
      <p class="text-xs text-fg-subtle" data-testid="app-version">
        <span class="font-medium text-fg-muted">{{ productName }}</span>
        <span v-if="version" class="ml-1.5 font-mono">{{ version }}</span>
      </p>
    </div>
  </aside>
</template>
