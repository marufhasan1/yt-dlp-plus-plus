/// <reference types="vite/client" />

import type { MediaFlowApi } from '@shared/types/ipc'

declare global {
  interface Window {
    /** Exposed by electron/preload.ts. Access it through src/api/client.ts. */
    readonly mediaflow: MediaFlowApi
  }
}

declare module 'vue-router' {
  interface RouteMeta {
    title: string
    description?: string
  }
}

export {}
