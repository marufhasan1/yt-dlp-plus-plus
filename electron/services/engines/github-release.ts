import { z } from 'zod'

/** The subset of the GitHub Releases API response YT-DLP++ relies on. */
export const githubAssetSchema = z.object({
  name: z.string(),
  size: z.number().int().nonnegative(),
  browser_download_url: z.url(),
  digest: z.string().nullish()
})

export const githubReleaseSchema = z.object({
  tag_name: z.string(),
  published_at: z.string().nullish(),
  html_url: z.string().nullish(),
  prerelease: z.boolean(),
  draft: z.boolean(),
  assets: z.array(githubAssetSchema)
})

export type GithubAsset = z.infer<typeof githubAssetSchema>
export type GithubRelease = z.infer<typeof githubReleaseSchema>

export function findAsset(assets: readonly GithubAsset[], name: string): GithubAsset | undefined {
  return assets.find((asset) => asset.name === name)
}
