<script setup lang="ts">
import { CircleAlert, CircleCheck, Info, X } from '@lucide/vue'
import { useToastStore, type ToastKind } from '@/stores/toast.store'

const store = useToastStore()

const ICONS = { success: CircleCheck, error: CircleAlert, info: Info } as const
const ICON_CLASS: Record<ToastKind, string> = {
  success: 'text-success',
  error: 'text-danger',
  info: 'text-accent'
}
</script>

<template>
  <Teleport to="body">
    <div
      class="pointer-events-none fixed right-5 bottom-5 z-50 flex w-90 flex-col gap-2"
      aria-live="polite"
      data-testid="toast-host"
    >
      <TransitionGroup
        enter-active-class="transition duration-200 ease-out"
        enter-from-class="translate-y-2 opacity-0"
        leave-active-class="transition duration-150 ease-in"
        leave-to-class="opacity-0"
      >
        <div
          v-for="toast in store.toasts"
          :key="toast.id"
          :role="toast.kind === 'error' ? 'alert' : 'status'"
          class="pointer-events-auto flex items-start gap-3 rounded-xl border border-border bg-surface px-4 py-3 shadow-raised"
        >
          <component
            :is="ICONS[toast.kind]"
            :size="18"
            class="mt-0.5 shrink-0"
            :class="ICON_CLASS[toast.kind]"
            aria-hidden="true"
          />
          <div class="min-w-0 flex-1">
            <p class="text-[13.5px] font-medium">{{ toast.title }}</p>
            <p v-if="toast.message" class="selectable mt-0.5 text-[13px] text-fg-muted">{{ toast.message }}</p>
          </div>
          <button
            type="button"
            class="-mr-1 rounded-md p-1 text-fg-subtle transition-colors hover:bg-surface-2 hover:text-fg"
            aria-label="Dismiss notification"
            @click="store.dismiss(toast.id)"
          >
            <X :size="15" aria-hidden="true" />
          </button>
        </div>
      </TransitionGroup>
    </div>
  </Teleport>
</template>
