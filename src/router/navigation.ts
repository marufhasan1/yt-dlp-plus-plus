import type { Component } from 'vue'
import { AudioLines, Download, History, House, ListVideo, RefreshCw, Settings } from '@lucide/vue'

export interface NavigationItem {
  name: string
  label: string
  icon: Component
}

/** Sidebar entries, in display order. `name` is the route name. */
export const NAVIGATION: readonly NavigationItem[] = [
  { name: 'home', label: 'Home', icon: House },
  { name: 'downloads', label: 'Downloads', icon: Download },
  { name: 'playlists', label: 'Playlists', icon: ListVideo },
  { name: 'converter', label: 'Audio Converter', icon: AudioLines },
  { name: 'history', label: 'History', icon: History },
  { name: 'settings', label: 'Settings', icon: Settings },
  { name: 'updates', label: 'Software Updates', icon: RefreshCw }
]
