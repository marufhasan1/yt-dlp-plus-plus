import { randomUUID } from 'node:crypto'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { EngineId } from '@shared/types/engines'

/**
 * Records what was installed into the managed engines folder, so binaries can
 * later be checked for corruption or tampering against the verified download.
 */
const manifestEntrySchema = z.object({
  version: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  size: z.number().int().nonnegative(),
  installedAt: z.string(),
  provider: z.string(),
  sourceUrl: z.string()
})

const manifestSchema = z.object({
  schemaVersion: z.literal(1),
  engines: z.partialRecord(z.enum(['yt-dlp', 'ffmpeg', 'ffprobe', 'deno']), manifestEntrySchema)
})

export type ManifestEntry = z.infer<typeof manifestEntrySchema>
export type EngineManifest = z.infer<typeof manifestSchema>

const FILENAME = 'manifest.json'

export class EngineManifestStore {
  constructor(private readonly directory: string) {}

  /** Returns an empty manifest if the file is missing or unreadable. */
  async read(): Promise<EngineManifest> {
    try {
      const parsed = manifestSchema.safeParse(JSON.parse(await readFile(join(this.directory, FILENAME), 'utf8')))
      if (parsed.success) return parsed.data
    } catch {
      // Missing or corrupt: treated as "no install records".
    }
    return { schemaVersion: 1, engines: {} }
  }

  async get(engine: EngineId): Promise<ManifestEntry | null> {
    return (await this.read()).engines[engine] ?? null
  }

  /** Atomically records new entries, keeping the others. */
  async update(entries: Partial<Record<EngineId, ManifestEntry>>): Promise<void> {
    const current = await this.read()
    const next: EngineManifest = { schemaVersion: 1, engines: { ...current.engines, ...entries } }
    const target = join(this.directory, FILENAME)
    const temporary = join(this.directory, `.${FILENAME}.${randomUUID()}.tmp`)
    try {
      await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
      await rename(temporary, target)
    } catch (error) {
      await rm(temporary, { force: true })
      throw error
    }
  }
}
