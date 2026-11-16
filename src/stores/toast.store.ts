import { defineStore } from 'pinia'
import { ref } from 'vue'

export type ToastKind = 'success' | 'error' | 'info'

export interface Toast {
  id: string
  kind: ToastKind
  title: string
  message?: string
}

const DEFAULT_TIMEOUT_MS: Record<ToastKind, number> = {
  success: 3500,
  info: 4500,
  error: 7000
}

const MAX_VISIBLE = 4

export const useToastStore = defineStore('toast', () => {
  const toasts = ref<Toast[]>([])
  const timers = new Map<string, ReturnType<typeof setTimeout>>()

  function dismiss(id: string): void {
    clearTimeout(timers.get(id))
    timers.delete(id)
    toasts.value = toasts.value.filter((toast) => toast.id !== id)
  }

  function push(kind: ToastKind, title: string, message?: string): string {
    const id = crypto.randomUUID()
    toasts.value = [...toasts.value, { id, kind, title, message }]
    while (toasts.value.length > MAX_VISIBLE) {
      const oldest = toasts.value[0]
      if (oldest) dismiss(oldest.id)
    }
    timers.set(
      id,
      setTimeout(() => dismiss(id), DEFAULT_TIMEOUT_MS[kind])
    )
    return id
  }

  return {
    toasts,
    dismiss,
    success: (title: string, message?: string) => push('success', title, message),
    info: (title: string, message?: string) => push('info', title, message),
    error: (title: string, message?: string) => push('error', title, message)
  }
})
