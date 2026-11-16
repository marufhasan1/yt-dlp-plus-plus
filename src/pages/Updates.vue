<script setup lang="ts">
import { computed, ref } from 'vue'
import { FolderOpen, RefreshCw, Settings2 } from '@lucide/vue'
import type { EngineId, InstallTarget } from '@shared/types/engines'
import { BridgeError, errorMessage } from '@/api/client'
import AppButton from '@/components/common/AppButton.vue'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'
import SkeletonBlock from '@/components/common/SkeletonBlock.vue'
import EngineCard from '@/components/engines/EngineCard.vue'
import AppUpdateCard from '@/components/updates/AppUpdateCard.vue'
import UpdateHistoryList from '@/components/updates/UpdateHistoryList.vue'
import { ENGINE_LABELS, useEnginesStore } from '@/stores/engines.store'
import { useSettingsStore } from '@/stores/settings.store'
import { useToastStore } from '@/stores/toast.store'
import { useUpdatesStore } from '@/stores/updates.store'
import { formatDateTime, formatRelative } from '@/utils/format'

const engines = useEnginesStore()
const updates = useUpdatesStore()
const settingsStore = useSettingsStore()
const toasts = useToastStore()

const scheduleText = computed(() => {
  const snapshot = updates.snapshot
  if (!snapshot) return ''
  const last = snapshot.lastCheckedAll ? `Last checked ${formatRelative(snapshot.lastCheckedAll)}` : 'Not checked yet'
  if (!settingsStore.settings.autoCheckUpdates || !snapshot.nextScheduledCheck) return `${last} · automatic checks are off`
  const next = new Date(snapshot.nextScheduledCheck)
  return `${last} · next automatic check ${next.getTime() <= Date.now() ? 'shortly' : formatDateTime(snapshot.nextScheduledCheck)}`
})

async function checkAll(): Promise<void> {
  try {
    await updates.check('all')
    const found = updates.available.length
    toasts.info(found > 0 ? `${found} update${found === 1 ? '' : 's'} available` : 'Everything is up to date')
  } catch (error) {
    toasts.error('Could not check for updates', errorMessage(error))
  }
}

const PLATFORM_NAMES: Record<string, string> = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }
const platformLabel = computed(() => {
  const snapshot = engines.snapshot
  return snapshot ? `${PLATFORM_NAMES[snapshot.platform] ?? snapshot.platform} · ${snapshot.arch}` : ''
})

const TARGET_LABELS: Record<InstallTarget, string> = {
  'yt-dlp': 'yt-dlp',
  ffmpeg: 'FFmpeg and FFprobe',
  deno: 'the Deno JavaScript runtime'
}
const TARGET_ENGINES: Record<InstallTarget, EngineId[]> = {
  'yt-dlp': ['yt-dlp'],
  ffmpeg: ['ffmpeg', 'ffprobe'],
  deno: ['deno']
}

const pendingTarget = ref<InstallTarget | null>(null)
const confirmOpen = ref(false)
const pendingProvider = computed(() =>
  pendingTarget.value ? (engines.snapshot?.providers[pendingTarget.value] ?? null) : null
)

function requestInstall(target: InstallTarget): void {
  pendingTarget.value = target
  confirmOpen.value = true
}

async function confirmInstall(): Promise<void> {
  const target = pendingTarget.value
  if (!target) return
  try {
    await engines.install(target)
    const versions = TARGET_ENGINES[target]
      .map((id) => `${ENGINE_LABELS[id]} ${engines.snapshot?.engines[id].version ?? ''}`.trim())
      .join(', ')
    toasts.success('Installation complete', versions)
    void updates.loadHistory()
  } catch (error) {
    if (error instanceof BridgeError && error.code === 'CANCELLED') {
      toasts.info('Installation cancelled')
    } else {
      toasts.error(`${TARGET_LABELS[target]} could not be installed`, errorMessage(error))
    }
  }
}

async function cancelInstall(): Promise<void> {
  try {
    await engines.cancelInstall()
  } catch (error) {
    toasts.error('Could not cancel', errorMessage(error))
  }
}

const refreshing = ref(false)
async function checkAgain(): Promise<void> {
  refreshing.value = true
  try {
    await engines.refresh(true)
  } catch (error) {
    toasts.error('Engine check failed', errorMessage(error))
  } finally {
    refreshing.value = false
  }
}

async function openFolder(): Promise<void> {
  try {
    await engines.openFolder()
  } catch (error) {
    toasts.error('Engines folder unavailable', errorMessage(error))
  }
}
</script>

<template>
  <div class="space-y-8">
    <div class="flex flex-wrap items-center justify-between gap-3" data-testid="updates-toolbar">
      <p class="text-[13px] text-fg-muted" data-testid="update-schedule">{{ scheduleText }}</p>
      <div class="flex gap-2">
        <AppButton variant="ghost" :icon="Settings2" data-testid="update-settings" @click="$router.push({ name: 'settings', hash: '#updates' })">
          Update settings
        </AppButton>
        <AppButton variant="primary" :icon="RefreshCw" :loading="updates.snapshot?.checkingAll" :disabled="!updates.snapshot" data-testid="check-all" @click="checkAll">
          Check all for updates
        </AppButton>
      </div>
    </div>

    <section class="space-y-4">
      <div>
        <h2 class="text-sm font-semibold tracking-tight">Application</h2>
        <p class="mt-0.5 text-[13px] text-fg-muted">New versions are downloaded only when you choose to, and verified before they are installed.</p>
      </div>
      <AppUpdateCard v-if="updates.snapshot" :update="updates.snapshot.components.app" />
      <SkeletonBlock v-else class="h-28 rounded-xl" />
    </section>

    <section class="space-y-4">
      <div class="flex items-end justify-between gap-4">
        <div>
          <h2 class="text-sm font-semibold tracking-tight">Media engines</h2>
          <p class="mt-0.5 text-[13px] text-fg-muted">
            Downloading and converting rely on these programs. Installation always requires your confirmation.
            <span v-if="platformLabel" class="text-fg-subtle">({{ platformLabel }})</span>
          </p>
        </div>
        <div class="flex shrink-0 gap-2">
          <AppButton variant="ghost" :icon="FolderOpen" data-testid="engines-open-folder" @click="openFolder">
            Open folder
          </AppButton>
          <AppButton
            :icon="RefreshCw"
            :loading="refreshing || engines.snapshot?.checking"
            :disabled="engines.installing !== null"
            data-testid="engines-refresh"
            @click="checkAgain"
          >
            Verify files
          </AppButton>
        </div>
      </div>

      <template v-if="engines.snapshot">
        <EngineCard
          target="yt-dlp"
          title="yt-dlp"
          description="Reads media information and downloads videos, audio and playlists."
          :engines="['yt-dlp']"
          @install="requestInstall"
          @cancel="cancelInstall"
        />
        <EngineCard
          target="ffmpeg"
          title="FFmpeg toolchain"
          description="Merges streams, converts audio and inspects media files. FFmpeg and FFprobe are installed together."
          :engines="['ffmpeg', 'ffprobe']"
          @install="requestInstall"
          @cancel="cancelInstall"
        />
        <EngineCard
          target="deno"
          title="JavaScript runtime (recommended)"
          description="Lets yt-dlp answer YouTube's JavaScript challenges so every format is available. yt-dlp runs it sandboxed, without network or file access."
          :engines="['deno']"
          @install="requestInstall"
          @cancel="cancelInstall"
        />
      </template>
      <div v-else class="space-y-4">
        <SkeletonBlock class="h-36 rounded-xl" />
        <SkeletonBlock class="h-48 rounded-xl" />
      </div>
    </section>

    <UpdateHistoryList />

    <ConfirmDialog
      v-model:open="confirmOpen"
      :title="pendingTarget ? `Install ${TARGET_LABELS[pendingTarget]}?` : ''"
      confirm-label="Download and install"
      @confirm="confirmInstall"
    >
      <template v-if="pendingProvider">
        <p>The latest release will be downloaded from:</p>
        <p class="mt-1.5 font-medium text-fg">{{ pendingProvider.name }}</p>
        <p class="mt-3">
          It is verified against the checksum published by its provider before it is installed into the app's own engines
          folder. Nothing else on your system is changed.
        </p>
        <p class="mt-3 text-[12.5px] text-fg-subtle">License: {{ pendingProvider.license }}</p>
      </template>
    </ConfirmDialog>
  </div>
</template>
