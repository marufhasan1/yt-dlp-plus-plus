import { initialSchema } from './001_initial_schema'
import { denoEngine } from './002_deno_engine'
import { downloadJobs } from './003_download_jobs'
import { playlists } from './004_playlists'
import { downloadRecovery } from './005_download_recovery'
import { updateChecks } from './006_update_checks'
import type { Migration } from './types'

export type { Migration } from './types'

/** Append new migrations here. Never edit or reorder one that has shipped. */
export const MIGRATIONS: readonly Migration[] = [initialSchema, denoEngine, downloadJobs, playlists, downloadRecovery, updateChecks]
