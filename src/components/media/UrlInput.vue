<script setup lang="ts">
import { computed } from 'vue'
import { ClipboardPaste, Link2, Search, X } from '@lucide/vue'
import { classifyMediaUrl } from '@shared/validation/media'
import { bridge, errorMessage, unwrap } from '@/api/client'
import AppButton from '@/components/common/AppButton.vue'
import { useMediaStore } from '@/stores/media.store'
import { useToastStore } from '@/stores/toast.store'

const media = useMediaStore()
const toasts = useToastStore()
const analyzing = computed(() => media.status === 'analyzing')

const hint = computed(() => {
  const kind = classifyMediaUrl(media.url).kind
  if (kind === 'youtube-playlist') return 'Playlist links open on the Playlists page, where you can pick videos.'
  if (kind === 'youtube-channel') return "Channel links list the channel's videos on the Playlists page."
  return 'Works with single videos and playlists on YouTube and many other sites.'
})

async function paste(): Promise<void> {
  try {
    const text = await unwrap(bridge.app.readClipboard())
    if (!text) {
      toasts.info('The clipboard does not contain a link')
      return
    }
    media.url = text
    await media.analyze()
  } catch (error) {
    toasts.error('Could not read the clipboard', errorMessage(error))
  }
}
</script>

<template>
  <section class="rounded-xl border border-border bg-surface p-5 shadow-card">
    <!-- novalidate: the app validates links itself and explains problems in its own words. -->
    <form class="flex gap-2" novalidate @submit.prevent="media.analyze()">
      <div class="relative min-w-0 flex-1">
        <Link2 :size="17" class="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-fg-subtle" aria-hidden="true" />
        <input
          v-model="media.url"
          type="url"
          inputmode="url"
          spellcheck="false"
          autocomplete="off"
          placeholder="Paste a video link, e.g. https://www.youtube.com/watch?v=…"
          aria-label="Video link"
          class="h-10 w-full rounded-lg border border-border bg-bg pr-9 pl-10 text-[14px] text-fg placeholder:text-fg-subtle focus:border-accent focus:outline-none"
          :disabled="analyzing"
          data-testid="url-input"
        />
        <button
          v-if="media.url && !analyzing"
          type="button"
          class="absolute top-1/2 right-2 -translate-y-1/2 rounded-md p-1 text-fg-subtle hover:bg-surface-2 hover:text-fg"
          aria-label="Clear"
          title="Clear"
          data-testid="url-clear"
          @click="media.clear()"
        >
          <X :size="15" aria-hidden="true" />
        </button>
      </div>
      <AppButton :icon="ClipboardPaste" :disabled="analyzing" data-testid="url-paste" @click="paste">Paste</AppButton>
      <AppButton
        v-if="!analyzing"
        type="submit"
        variant="primary"
        :icon="Search"
        :disabled="!media.url.trim()"
        data-testid="url-analyze"
      >
        Analyze
      </AppButton>
      <AppButton v-else variant="secondary" :icon="X" data-testid="url-cancel" @click="media.cancel()">Cancel</AppButton>
    </form>
    <p
      v-if="media.status === 'error' && media.error"
      class="selectable mt-2.5 text-[13px] text-danger"
      role="alert"
      data-testid="url-error"
    >
      {{ media.error }}
    </p>
    <p v-else class="mt-2.5 text-[12.5px] text-fg-subtle">{{ hint }}</p>
  </section>
</template>
