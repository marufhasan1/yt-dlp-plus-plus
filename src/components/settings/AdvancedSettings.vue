<script setup lang="ts">
import { computed, ref } from 'vue'
import type { AppSettings } from '@shared/types/settings'
import { proxySchema, redactProxy } from '@shared/validation/network'
import { errorMessage } from '@/api/client'
import AppButton from '@/components/common/AppButton.vue'
import SegmentedControl, { type SegmentOption } from '@/components/common/SegmentedControl.vue'
import SelectField, { type SelectOption } from '@/components/common/SelectField.vue'
import { useSettingsStore } from '@/stores/settings.store'
import { useToastStore } from '@/stores/toast.store'
import SettingsRow from './SettingsRow.vue'
import SettingsSection from './SettingsSection.vue'

const settingsStore = useSettingsStore()
const toasts = useToastStore()

function setting<K extends 'maxRetries' | 'networkTimeoutSeconds' | 'speedLimitKib' | 'logLevel'>(key: K) {
  return computed<AppSettings[K]>({
    get: () => settingsStore.settings[key],
    set: (value) => {
      settingsStore.update({ [key]: value }).catch((error: unknown) => toasts.error('Setting not saved', errorMessage(error)))
    }
  })
}

const retries = setting('maxRetries')
const timeout = setting('networkTimeoutSeconds')
const logLevel = setting('logLevel')
// SelectField works with strings and numbers; "none" stands for no limit.
const speedLimit = computed<number | 'none'>({
  get: () => settingsStore.settings.speedLimitKib ?? 'none',
  set: (value) => {
    settingsStore
      .update({ speedLimitKib: value === 'none' ? null : value })
      .catch((error: unknown) => toasts.error('Setting not saved', errorMessage(error)))
  }
})

const RETRY_OPTIONS: readonly SelectOption<number>[] = Array.from({ length: 11 }, (_, n) => ({
  value: n,
  label: n === 0 ? 'Off' : `${n} ${n === 1 ? 'time' : 'times'}`
}))
const TIMEOUT_OPTIONS: readonly SelectOption<number>[] = [10, 20, 30, 60, 120, 300].map((s) => ({
  value: s,
  label: s < 60 ? `${s} seconds` : `${s / 60} minute${s === 60 ? '' : 's'}`
}))
const SPEED_OPTIONS: readonly SelectOption<number | 'none'>[] = [
  { value: 'none', label: 'No limit' },
  { value: 256, label: '256 KB/s' },
  { value: 512, label: '512 KB/s' },
  ...[1, 2, 5, 10, 20, 50].map((mb) => ({ value: mb * 1024, label: `${mb} MB/s` }))
]
const LOG_OPTIONS: readonly SegmentOption<AppSettings['logLevel']>[] = [
  { value: 'info', label: 'Normal' },
  { value: 'debug', label: 'Detailed' }
]

// ─── Proxy ───────────────────────────────────────────────────────────────────
const proxyDraft = ref('')
const proxyError = ref<string | null>(null)
const savingProxy = ref(false)
const currentProxy = computed(() => (settingsStore.settings.proxy ? redactProxy(settingsStore.settings.proxy) : null))

async function saveProxy(value: string | null): Promise<void> {
  proxyError.value = null
  const parsed = proxySchema.safeParse(value)
  if (!parsed.success) {
    proxyError.value = parsed.error.issues[0]?.message ?? 'This proxy address is not valid.'
    return
  }
  savingProxy.value = true
  try {
    await settingsStore.update({ proxy: parsed.data })
    proxyDraft.value = ''
    toasts.success(parsed.data ? 'Proxy saved' : 'Proxy removed', parsed.data ? 'New connections use it.' : 'YT-DLP++ connects directly again.')
  } catch (error) {
    proxyError.value = errorMessage(error)
  } finally {
    savingProxy.value = false
  }
}
</script>

<template>
  <SettingsSection title="Advanced" description="Connection and logging behaviour. The defaults suit most networks.">
    <SettingsRow label="Automatic retries" description="Downloads that fail because of a network problem are resumed after 5 s, 15 s, 45 s… keeping what was already downloaded.">
      <div class="w-36"><SelectField v-model="retries" :options="RETRY_OPTIONS" label="Automatic retries" data-testid="setting-retries" /></div>
    </SettingsRow>
    <SettingsRow label="Network timeout" description="How long yt-dlp waits for a server to respond before treating the connection as failed.">
      <div class="w-36"><SelectField v-model="timeout" :options="TIMEOUT_OPTIONS" label="Network timeout" data-testid="setting-timeout" /></div>
    </SettingsRow>
    <SettingsRow label="Speed limit" description="Maximum speed of each download. Applies to downloads started or resumed after the change.">
      <div class="w-36"><SelectField v-model="speedLimit" :options="SPEED_OPTIONS" label="Speed limit" data-testid="setting-speed-limit" /></div>
    </SettingsRow>

    <div class="px-5 py-4" data-testid="setting-proxy">
      <div class="flex items-start justify-between gap-6">
        <div class="min-w-0">
          <p class="text-[13.5px] font-medium">Proxy</p>
          <p class="mt-0.5 text-[13px] text-fg-muted">
            Used by yt-dlp and by YT-DLP++'s own requests (thumbnails, engine downloads). Supports http, https, socks4(a) and
            socks5(h). A user name and password, if included, are stored unencrypted in YT-DLP++'s settings on this computer.
          </p>
          <p class="mt-1.5 text-[12.5px]" data-testid="proxy-current">
            <span class="text-fg-muted">Current:</span>
            <span v-if="currentProxy" class="selectable ml-1 font-mono">{{ currentProxy }}</span>
            <span v-else class="ml-1">Direct connection (system settings)</span>
          </p>
        </div>
      </div>
      <form class="mt-3 flex gap-2" novalidate @submit.prevent="saveProxy(proxyDraft)">
        <input
          v-model="proxyDraft"
          type="text"
          spellcheck="false"
          autocomplete="off"
          maxlength="2048"
          placeholder="socks5h://127.0.0.1:9050"
          :aria-invalid="proxyError !== null"
          aria-label="Proxy address"
          class="h-9 min-w-0 flex-1 rounded-lg border bg-surface px-3 font-mono text-[13px] shadow-card placeholder:text-fg-subtle"
          :class="proxyError ? 'border-danger' : 'border-border'"
          data-testid="proxy-input"
          @input="proxyError = null"
        />
        <AppButton type="submit" :loading="savingProxy" :disabled="proxyDraft.trim() === ''" data-testid="proxy-save">Use proxy</AppButton>
        <AppButton v-if="currentProxy" variant="ghost" :disabled="savingProxy" data-testid="proxy-clear" @click="saveProxy(null)">Remove</AppButton>
      </form>
      <p v-if="proxyError" class="mt-1.5 text-[12.5px] text-danger" role="alert" data-testid="proxy-error">{{ proxyError }}</p>
    </div>

    <SettingsRow label="Log detail" description="Detailed logs also record yt-dlp warnings and other diagnostics. Logs stay on this computer.">
      <SegmentedControl v-model="logLevel" :options="LOG_OPTIONS" label="Log detail" data-testid="setting-log-level" />
    </SettingsRow>
  </SettingsSection>
</template>
