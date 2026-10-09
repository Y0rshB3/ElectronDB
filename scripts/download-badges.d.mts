// Types for scripts/download-badges.mjs (used by TypeScript tests).
export const INSTALLER: RegExp
export function installerDownloads(release: {
  assets?: { name: string; download_count?: number }[]
}): number
export function badge(
  label: string,
  count: number,
  color: string
): { schemaVersion: 1; label: string; message: string; color: string; cacheSeconds: number }
