import { EventEmitter } from 'node:events'
import { access, constants, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import {
  DEFAULT_SETTINGS,
  appSettingsSchema,
  settingsFields,
  settingsPatchSchema,
  type SettingKey
} from '@shared/validation/settings'
import type { AppSettings } from '@shared/types/settings'
import type { Unsubscribe } from '@shared/types/ipc'
import { AppError } from '../../utils/errors'
import type { Logger } from '../../utils/logger'
import type { SettingsRepository } from '../storage/settings.repository'

type ChangeListener = (settings: AppSettings) => void

/**
 * Owns the in-memory copy of the user's settings. Reads are served from memory;
 * writes are validated, persisted, then broadcast to listeners.
 */
export class SettingsService {
  private current: AppSettings
  private readonly events = new EventEmitter()

  constructor(
    private readonly repository: SettingsRepository,
    private readonly logger: Logger
  ) {
    this.current = this.load()
  }

  get(): AppSettings {
    return { ...this.current }
  }

  /** Validates and applies a partial update from the renderer. Throws a ZodError on invalid input. */
  update(patch: unknown): AppSettings {
    return this.apply(settingsPatchSchema.parse(patch))
  }

  /**
   * Main-process only: called after the user picked a folder in the native
   * dialog. The folder must be absolute, exist and be writable; null restores
   * the OS Downloads folder.
   */
  async setDownloadDirectory(directory: string | null): Promise<AppSettings> {
    if (directory !== null) {
      if (!isAbsolute(directory)) throw new AppError('VALIDATION_FAILED', 'The download folder must be an absolute path.')
      try {
        if (!(await stat(directory)).isDirectory()) throw new Error('not a directory')
        await access(directory, constants.W_OK)
      } catch (error) {
        throw new AppError('OPERATION_FAILED', 'The selected folder cannot be written to.', { cause: error })
      }
    }
    return this.apply({ downloadDirectory: settingsFields.downloadDirectory.parse(directory) })
  }

  private apply(validated: Partial<AppSettings>): AppSettings {
    const changed: Partial<AppSettings> = {}
    for (const [key, value] of Object.entries(validated) as [SettingKey, unknown][]) {
      if (value !== undefined && value !== this.current[key]) {
        Object.assign(changed, { [key]: value })
      }
    }
    if (Object.keys(changed).length === 0) {
      return this.get()
    }

    this.repository.setMany(changed)
    this.current = { ...this.current, ...changed }
    this.logger.info('Settings updated', Object.keys(changed))
    const snapshot = this.get()
    this.events.emit('changed', snapshot)
    return snapshot
  }

  onChanged(listener: ChangeListener): Unsubscribe {
    this.events.on('changed', listener)
    return () => this.events.off('changed', listener)
  }

  private load(): AppSettings {
    const stored = this.repository.getAllRaw()
    const settings: AppSettings = { ...DEFAULT_SETTINGS }

    for (const key of Object.keys(settingsFields) as SettingKey[]) {
      const raw = stored.get(key)
      if (raw === undefined) continue

      let decoded: unknown
      try {
        decoded = JSON.parse(raw)
      } catch {
        this.logger.warn(`Ignoring unreadable stored setting "${key}"; using default`)
        continue
      }

      const parsed = settingsFields[key].safeParse(decoded)
      if (parsed.success) {
        Object.assign(settings, { [key]: parsed.data })
      } else {
        this.logger.warn(`Ignoring invalid stored setting "${key}"; using default`)
      }
    }

    return appSettingsSchema.parse(settings)
  }
}
