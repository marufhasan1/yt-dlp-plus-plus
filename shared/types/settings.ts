import type { z } from 'zod'
import type { appSettingsSchema, themePreferenceSchema } from '../validation/settings'

export type ThemePreference = z.infer<typeof themePreferenceSchema>
export type AppSettings = z.infer<typeof appSettingsSchema>
export type SettingsPatch = Partial<AppSettings>
