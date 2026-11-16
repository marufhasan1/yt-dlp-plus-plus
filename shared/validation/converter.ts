import { z } from 'zod'

/** Upper bound on files converted in one request. */
export const MAX_CONVERSION_INPUTS = 200

export const conversionRequestSchema = z
  .object({
    inputs: z.array(z.uuid()).min(1).max(MAX_CONVERSION_INPUTS),
    format: z.enum(['mp3', 'm4a', 'wav', 'flac', 'opus']),
    quality: z.enum(['best', '128', '192', '256', '320']),
    destination: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('downloads') }).strict(),
      z.object({ kind: z.literal('source') }).strict(),
      z.object({ kind: z.literal('custom'), token: z.uuid() }).strict()
    ])
  })
  .strict()

export const conversionIdSchema = z.object({ id: z.uuid() }).strict()
