// Types for scripts/release-lib.mjs (used by TypeScript tests).
export declare const PRODUCT: string
export declare const PACKAGE_NAME: string
export declare const PLATFORMS: readonly ('mac' | 'win' | 'linux')[]
export type Platform = 'mac' | 'win' | 'linux'
export interface PlatformArtifacts {
  binaries: string[]
  updateInfo: string
  blockmaps: string[]
}
export declare function builderArgs(platform: Platform, outDir: string): string[]
export declare function expectedArtifacts(version: string): Record<Platform, PlatformArtifacts>
export declare function expectedFeedFiles(
  version: string
): Record<Platform, { path: string | null; files: string[] }>
export interface UpdateYml {
  version: string | null
  path: string | null
  sha512: string | null
  files: { url: string; sha512: string | null; size: number | null }[]
}
export declare function parseUpdateYml(text: string): UpdateYml
export declare function hashFile(
  path: string,
  algorithm: 'sha256' | 'sha512',
  encoding: 'hex' | 'base64'
): Promise<string>
export declare function sha256SumsText(entries: { name: string; sha256: string }[]): string
export declare function sha512Base64(buffer: Uint8Array): string
