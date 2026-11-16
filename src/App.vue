<script setup lang="ts">
import ToastHost from '@/components/common/ToastHost.vue'
import { useThemeClass } from '@/composables/useTheme'
import MainLayout from '@/layouts/MainLayout.vue'

useThemeClass()
</script>

<template>
  <MainLayout />
  <ToastHost />
</template>
