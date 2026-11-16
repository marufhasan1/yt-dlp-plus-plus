<script setup lang="ts">
import { ref, watch } from 'vue'
import AppButton from './AppButton.vue'

const props = withDefaults(
  defineProps<{
    title: string
    confirmLabel?: string
    cancelLabel?: string
    tone?: 'default' | 'danger'
  }>(),
  { confirmLabel: 'Continue', cancelLabel: 'Cancel', tone: 'default' }
)

const emit = defineEmits<{ confirm: []; cancel: [] }>()
const open = defineModel<boolean>('open', { required: true })
const dialog = ref<HTMLDialogElement | null>(null)

// The native <dialog> provides the modal backdrop, focus trapping and Escape handling.
watch(
  open,
  (isOpen) => {
    const element = dialog.value
    if (!element) return
    if (isOpen && !element.open) element.showModal()
    if (!isOpen && element.open) element.close()
  },
  { flush: 'post' }
)

function cancel(): void {
  open.value = false
  emit('cancel')
}

function confirm(): void {
  open.value = false
  emit('confirm')
}
</script>

<template>
  <dialog
    ref="dialog"
    class="m-auto w-[min(440px,calc(100vw-32px))] rounded-2xl border border-border bg-surface p-0 text-fg shadow-raised backdrop:bg-black/50"
    data-testid="confirm-dialog"
    @cancel.prevent="cancel"
  >
    <div class="px-6 pt-5 pb-4">
      <h2 class="text-base font-semibold tracking-tight">{{ props.title }}</h2>
      <div class="mt-2 text-[13.5px] text-fg-muted">
        <slot />
      </div>
    </div>
    <div class="flex justify-end gap-2 border-t border-border px-6 py-3.5">
      <AppButton variant="ghost" data-testid="confirm-cancel" @click="cancel">{{ props.cancelLabel }}</AppButton>
      <AppButton
        :variant="props.tone === 'danger' ? 'secondary' : 'primary'"
        :class="props.tone === 'danger' ? 'text-danger' : ''"
        data-testid="confirm-accept"
        autofocus
        @click="confirm"
      >
        {{ props.confirmLabel }}
      </AppButton>
    </div>
  </dialog>
</template>
