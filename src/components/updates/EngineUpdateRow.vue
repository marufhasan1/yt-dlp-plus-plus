<script setup lang="ts">
import { computed, ref } from 'vue'
import { ArrowUpCircle, CircleAlert, ExternalLink, History, RefreshCw, X } from '@lucide/vue'
import type { InstallTarget } from '@shared/types/engines'
import type { ComponentUpdate } from '@shared/types/updates'
import { BridgeError, errorMessage } from '@/api/client'
import AppButton from '@/components/common/AppButton.vue'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'
import { useEnginesStore } from '@/stores/engines.store'
import { useToastStore } from '@/stores/toast.store'
import { UPDATE_LABELS, useUpdatesStore } from '@/stores/updates.store'
import { formatDate, formatRelative } from '@/utils/format'
import UpdateStateBadge from './UpdateStateBadge.vue'

const props = defineProps<{ target: InstallTarget; update: ComponentUpdate }>()
const store = useUpdatesStore()
const engines = useEnginesStore()
const toasts = useToastStore()
const busy = ref(false)
const confirmUpdate = ref(false)
const confirmRollback = ref(false)

const name = computed(() => UPDATE_LABELS[props.target])
const engineBusy = computed(() => engines.installing !== null || Boolean(engines.snapshot?.checking))
const provider = computed(() => engines.snapshot?.providers[props.target] ?? null)
const inUse = computed(() => engines.snapshot?.inUse.includes(props.target) ?? false)
const updateLabel = computed(() => {
  const u = props.update
  if (u.systemCopy) return `Install MediaFlow's ${u.latestVersion}`
  if (u.channelSwitch) return `Switch to ${u.channel} (${u.latestVersion})`
  return `Update to ${u.latestVersion}`
})
const canCheck = computed(() => !['checking', 'downloading', 'installing', 'unavailable'].includes(props.update.state) || props.update.message === 'Not installed.')

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

const check = () => run(() => store.check(props.target), 'Could not check for updates')
const notes = () => run(() => store.openReleaseNotes(props.target), 'Release notes unavailable')
const cancelWaiting = () => run(() => store.cancelWaiting(props.target), 'Could not cancel')

async function applyUpdate(): Promise<void> {
  await run(async () => {
    const deferred = await store.updateEngine(props.target)
    if (deferred) toasts.info(`${name.value} will be updated when downloads finish`, 'It is in use by running downloads or conversions.')
    else toasts.success(`${name.value} updated`, `Now using ${engines.snapshot?.engines[props.target].version ?? props.update.latestVersion}.`)
  }, `${name.value} could not be updated`)
}

async function rollback(): Promise<void> {
  const to = props.update.rollbackVersion
  await run(async () => {
    await store.rollback(props.target)
    toasts.success(`${name.value} rolled back`, `Now using ${to}.`)
  }, `${name.value} could not be rolled back`)
}
</script>

<template>
  <div class="border-t border-border px-5 py-3.5" :data-testid="`update-row-${target}`" :data-state="update.state">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px]">
        <UpdateStateBadge :state="update.state" />
        <span v-if="update.latestVersion && update.state !== 'unavailable'" class="text-fg-muted" data-testid="latest-version">
          {{ update.channel ? `Latest ${update.channel}:` : 'Latest:' }} <span class="font-mono text-fg">{{ update.latestVersion }}</span>
          <span v-if="update.releasedAt" class="text-fg-subtle"> · {{ formatDate(update.releasedAt.slice(0, 10)) }}</span>
        </span>
        <span v-if="update.checkedAt" class="text-fg-subtle" :title="update.checkedAt">Checked {{ formatRelative(update.checkedAt) }}</span>
      </div>
      <div class="flex shrink-0 items-center gap-1.5">
        <AppButton v-if="update.notesUrl && update.state !== 'unavailable'" variant="ghost" :icon="ExternalLink" class="h-8 px-2.5 text-[12.5px]" :data-testid="`notes-${target}`" @click="notes">
          Notes
        </AppButton>
        <AppButton
          v-if="update.rollbackVersion && !['downloading', 'installing', 'waiting'].includes(update.state)"
          variant="ghost"
          :icon="History"
          class="h-8 px-2.5 text-[12.5px]"
          :disabled="busy || engineBusy || inUse"
          :title="inUse ? 'In use by running downloads or conversions' : undefined"
          :data-testid="`rollback-${target}`"
          @click="confirmRollback = true"
        >
          Roll back to {{ update.rollbackVersion }}
        </AppButton>
        <AppButton v-if="canCheck" :icon="RefreshCw" class="h-8 px-2.5 text-[12.5px]" :loading="busy && update.state === 'checking'" :disabled="engineBusy" :data-testid="`check-${target}`" @click="check">
          Check
        </AppButton>
        <AppButton v-if="update.state === 'waiting'" variant="ghost" :icon="X" class="h-8 px-2.5 text-[12.5px]" :data-testid="`cancel-waiting-${target}`" @click="cancelWaiting">
          Don't update
        </AppButton>
        <AppButton
          v-if="update.state === 'available'"
          variant="primary"
          :icon="ArrowUpCircle"
          class="h-8 px-3 text-[12.5px]"
          :disabled="busy || engineBusy"
          :data-testid="`update-${target}`"
          @click="confirmUpdate = true"
        >
          {{ updateLabel }}
        </AppButton>
      </div>
    </div>
    <p
      v-if="update.message && update.message !== 'Not installed.'"
      class="mt-2 flex items-start gap-1.5 text-[12.5px]"
      :class="update.state === 'failed' ? 'text-danger' : 'text-fg-muted'"
      :data-testid="`update-message-${target}`"
    >
      <CircleAlert v-if="update.state === 'failed'" :size="14" class="mt-0.5 shrink-0" aria-hidden="true" />
      <span class="selectable">{{ update.message }}</span>
    </p>

    <ConfirmDialog v-model:open="confirmUpdate" :title="`${updateLabel}?`" confirm-label="Update" @confirm="applyUpdate">
      <p v-if="provider">
        Downloaded from <span class="font-medium text-fg">{{ provider.name }}</span> and verified against the checksum its provider publishes. It is run
        once before and once after it replaces {{ update.installedVersion }}; if either check fails, {{ update.installedVersion }} stays.
      </p>
      <p v-if="update.systemCopy" class="mt-2">Your system's copy is not changed; MediaFlow uses its own copy from now on.</p>
      <p v-else class="mt-2">{{ update.installedVersion }} is kept, so you can roll back.</p>
      <p v-if="update.channelSwitch" class="mt-2">{{ update.message }}</p>
      <p v-if="inUse" class="mt-2 font-medium text-fg">{{ name }} is in use right now; the update starts as soon as those downloads and conversions finish.</p>
    </ConfirmDialog>
    <ConfirmDialog v-model:open="confirmRollback" :title="`Roll back ${name} to ${update.rollbackVersion}?`" confirm-label="Roll back" @confirm="rollback">
      <p>
        The version kept from before the last update is checked and put back. {{ update.installedVersion }} is kept in turn, so you can switch back
        again.
      </p>
    </ConfirmDialog>
  </div>
</template>
