<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { usePlaylistsStore } from '@/stores/playlists.store'

const props = defineProps<{ playlistId: string; position: number }>()
const store = usePlaylistsStore()
const root = ref<HTMLElement | null>(null)
let observer: IntersectionObserver | null = null

const src = computed(() => store.thumbnails[`${props.playlistId}:${props.position}`] ?? null)

// Ask the main process for the image only once the row is (nearly) on screen.
onMounted(() => {
  observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        store.thumbnail(props.playlistId, props.position)
        observer?.disconnect()
      }
    },
    { rootMargin: '300px' }
  )
  if (root.value) observer.observe(root.value)
})
onBeforeUnmount(() => observer?.disconnect())
</script>

<template>
  <div ref="root" class="aspect-video w-24 shrink-0 overflow-hidden rounded bg-surface-3">
    <img v-if="src" :src="src" alt="" class="size-full object-cover" draggable="false" />
  </div>
</template>
