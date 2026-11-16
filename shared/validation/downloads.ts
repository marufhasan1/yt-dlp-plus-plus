import { z } from 'zod'

export const HISTORY_PAGE_SIZE = 50

/** Output formats a download can have (see DownloadPlan.outputFormat). */
export const OUTPUT_FORMATS = ['mp4', 'webm', 'mkv', 'mp3', 'm4a', 'wav', 'flac', 'opus', 'srt', 'vtt'] as const

/** ISO timestamps are normalised so they compare correctly with stored `created_at` values. */
const isoDate = z.iso.datetime({ offset: true }).transform((value) => new Date(value).toISOString())

export const historyQuerySchema = z
  .object({
    search: z.string().trim().max(200).optional(),
    format: z.enum(OUTPUT_FORMATS).optional(),
    status: z.enum(['completed', 'failed', 'cancelled']).optional(),
    from: isoDate.optional(),
    to: isoDate.optional(),
    offset: z.number().int().min(0).max(1_000_000),
    limit: z.number().int().min(1).max(200)
  })
  .strict()
  .refine((query) => !query.from || !query.to || query.from < query.to, { message: 'The start date must be before the end date' })

export const historyDeleteSchema = z
  .object({
    id: z.uuid(),
    /** Also move the downloaded file to the Recycle Bin / Trash. */
    deleteFile: z.boolean()
  })
  .strict()
