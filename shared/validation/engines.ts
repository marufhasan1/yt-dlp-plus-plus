import { z } from 'zod'

export const installTargetSchema = z.enum(['yt-dlp', 'ffmpeg', 'deno'])

export const installRequestSchema = z.object({ target: installTargetSchema }).strict()

export const refreshRequestSchema = z.object({ deep: z.boolean() }).strict()

export const updateComponentSchema = z.enum(['app', 'yt-dlp', 'ffmpeg', 'deno'])

export const updateCheckRequestSchema = z.object({ component: z.union([updateComponentSchema, z.literal('all')]) }).strict()

export const updateComponentRequestSchema = z.object({ component: updateComponentSchema }).strict()
