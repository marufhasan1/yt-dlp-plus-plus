import pluginVue from 'eslint-plugin-vue'
import { defineConfigWithVueTs, vueTsConfigs } from '@vue/eslint-config-typescript'

export default defineConfigWithVueTs(
  {
    ignores: ['out/**', 'release/**', 'node_modules/**', 'test-results/**', 'playwright-report/**', 'resources/**', '.qa/**']
  },
  pluginVue.configs['flat/essential'],
  vueTsConfigs.recommended,
  {
    rules: {
      // Page components are single words by design (Home.vue, Settings.vue, …).
      'vue/multi-word-component-names': 'off',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      'no-console': ['warn', { allow: ['warn', 'error'] }]
    }
  },
  {
    // Build and release scripts are plain Node.js command-line tools (CommonJS where Electron requires it).
    files: ['scripts/**/*.{cjs,mjs}'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
      'no-console': 'off'
    }
  }
)
