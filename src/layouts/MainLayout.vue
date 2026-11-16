<script setup lang="ts">
import AppHeader from '@/components/layout/AppHeader.vue'
import AppSidebar from '@/components/layout/AppSidebar.vue'
import EngineSetupBanner from '@/components/layout/EngineSetupBanner.vue'
</script>

<template>
  <div class="flex h-full overflow-hidden bg-bg text-fg">
    <AppSidebar />
    <div class="flex min-w-0 flex-1 flex-col">
      <AppHeader />
      <EngineSetupBanner />
      <main class="min-h-0 flex-1 overflow-y-auto" data-testid="page-content">
        <div class="mx-auto w-full max-w-5xl px-8 py-7">
          <RouterView v-slot="{ Component, route }">
            <Transition name="page" mode="out-in">
              <component :is="Component" :key="route.name" />
            </Transition>
          </RouterView>
        </div>
      </main>
    </div>
  </div>
</template>
