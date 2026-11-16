<script setup lang="ts">
import { computed, ref } from 'vue'
import { CircleAlert, Download, ExternalLink, RefreshCw, RotateCw, X } from '@lucide/vue'
import type { ComponentUpdate } from '@shared/types/updates'
import { BridgeError, errorMessage } from '@/api/client'
import AppButton from '@/components/common/AppButton.vue'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'
import ProgressBar from '@/components/common/ProgressBar.vue'
import { useAppStore } from '@/stores/app.store'
import { useDownloadsStore } from '@/stores/downloads.store'
import { useToastStore } from '@/stores/toast.store'
import { useUpdatesStore } from '@/stores/updates.store'
import { formatDate, formatRelative } from '@/utils/format'
import UpdateStateBadge from './UpdateStateBadge.vue'

const props = defineProps<{ update: ComponentUpdate }>()
const store = useUpdatesStore()
const appStore = useAppStore()
const downloads = useDownloadsStore()
const toasts = useToastStore()
const busy = ref(false)
const confirmInstall = ref(false)

const name = computed(() => appStore.info?.name ?? 'MediaFlow')
const canCheck = computed(() => !['checking', 'downloading', 'unavailable'].includes(props.update.state))

async function run(action: () => Promise<unknown>, failure: string): Promise<void> {
  busy.value = true
  try {
    await action()
  } catch (error) {
    if (!(error instanceof BridgeError && error.code === 'CANCELLED')) toasts.error(failure, errorMessage(error))
  } finally {
    busy.value = false
  }
}

const check = () => run(() => store.check('app'), 'Could not check for updates')
const download = () => run(() => store.downloadApp(), 'The update could not be downloaded')
const cancel = () => run(() => store.cancelAppDownload(), 'Could not cancel')
const install = () => run(() => store.installApp(), 'The update could not be installed')
const notes = () => run(() => store.openReleaseNotes('app'), 'Release notes unavailable')
</script>

<template>
  <section class="rounded-xl border border-border bg-surface shadow-card" data-testid="update-card-app">
    <header class="flex items-start justify-between gap-4 px-5 py-4">
      <div class="min-w-0">
        <div class="flex items-center gap-2.5">
          <h3 class="text-sm font-semibold tracking-tight">{{ name }}</h3>
          <UpdateStateBadge :state="update.state" />
        </div>
        <dl class="mt-2 grid grid-cols-[110px_1fr] gap-x-3 gap-y-1 text-[12.5px]">
          <dt class="text-fg-subtle">Installed</dt>
          <dd class="font-mono text-fg-muted" data-testid="installed-version">{{ update.installedVersion ?? '—' }}</dd>
          <template v-if="update.latestVersion && update.state !== 'unavailable'">
            <dt class="text-fg-subtle">Latest</dt>
            <dd class="font-mono text-fg-muted" data-testid="latest-version">
              {{ update.latestVersion }}<span v-if="update.releasedAt" class="ml-2 font-sans text-fg-subtle">released {{ formatDate(update.releasedAt.slice(0, 10)) }}</span>
            </dd>
          </template>
          <template v-if="update.checkedAt">
            <dt class="text-fg-subtle">Last checked</dt>
            <dd class="text-fg-muted" :title="update.checkedAt">{{ formatRelative(update.checkedAt) }}</dd>
          </template>
        </dl>
      </div>
      <div class="flex shrink-0 items-center gap-2">
        <AppButton v-if="update.notesUrl" variant="ghost" :icon="ExternalLink" data-testid="app-notes" @click="notes">Release notes</AppButton>
        <AppButton v-if="canCheck" :icon="RefreshCw" :loading="busy && update.state !== 'downloading'" data-testid="app-check" @click="check">Check</AppButton>
        <AppButton v-if="update.state === 'available'" variant="primary" :icon="Download" :disabled="busy" data-testid="app-download" @click="download">
          Download {{ update.latestVersion }}
        </AppButton>
        <AppButton v-if="update.state === 'ready'" variant="primary" :icon="RotateCw" data-testid="app-install" @click="confirmInstall = true">
          Restart to update
        </AppButton>
      </div>
    </header>

    <div v-if="update.state === 'downloading'" class="border-t border-border px-5 py-4" data-testid="app-progress">
      <div class="mb-2 flex items-center justify-between gap-4 text-[13px] text-fg-muted">
        <span>Downloading {{ name }} {{ update.latestVersion }} — {{ Math.floor(update.progress ?? 0) }}%</span>
        <AppButton variant="ghost" :icon="X" class="h-7 px-2 text-[12.5px]" data-testid="app-cancel" @click="cancel">Cancel</AppButton>
      </div>
      <ProgressBar :value="(update.progress ?? 0) / 100" :label="`Downloading ${name} ${update.latestVersion}`" />
    </div>

    <p v-if="update.state === 'ready'" class="border-t border-border px-5 py-3 text-[12.5px] text-fg-muted" data-testid="app-ready">
      Downloaded and verified. It is installed when you restart {{ name }}, or the next time you quit it.
    </p>
    <p
      v-if="update.message"
      class="flex items-start gap-2 border-t border-border px-5 py-3 text-[12.5px]"
      :class="update.state === 'failed' ? 'text-danger' : 'text-fg-muted'"
      data-testid="app-message"
    >
      <CircleAlert v-if="update.state === 'failed'" :size="14" class="mt-0.5 shrink-0" aria-hidden="true" />
      <span class="selectable">{{ update.message }}</span>
    </p>

    <details v-if="update.releaseNotes && ['available', 'downloading', 'ready'].includes(update.state)" class="border-t border-border px-5 py-3" data-testid="app-release-notes">
      <summary class="cursor-pointer text-[12.5px] font-medium text-fg-muted select-none hover:text-fg">What's new in {{ update.latestVersion }}</summary>
      <p class="selectable mt-2 max-h-64 overflow-y-auto text-[12.5px] whitespace-pre-line text-fg-muted">{{ update.releaseNotes }}</p>
    </details>

    <ConfirmDialog v-model:open="confirmInstall" :title="`Restart and update to ${update.latestVersion}?`" confirm-label="Restart and update" @confirm="install">
      <p>{{ name }} closes, installs version {{ update.latestVersion }} and starts again.</p>
      <p v-if="downloads.active.length > 0" class="mt-2">
        {{ downloads.active.length }} running download{{ downloads.active.length === 1 ? ' is' : 's are' }} paused first and can be resumed after the
        restart.
      </p>
    </ConfirmDialog>
  </section>
</template>
