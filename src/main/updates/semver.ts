/**
 * Minimal semantic-version handling for release tags ("v0.1.3", "0.2.0-beta.1").
 * Build metadata (+...) is ignored; a pre-release sorts lower than its release.
 * Pure (no electron) so it is unit tested.
 */

export interface ParsedVersion {
  major: number
  minor: number
  patch: number
  /** Dot-separated pre-release identifiers ("beta.1" -> ['beta', '1']); empty for a release. */
  prerelease: string[]
}

const VERSION_RE =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/i

/** Parses a version or tag; null when it is not valid semver (with an optional "v"). */
export function parseVersion(raw: unknown): ParsedVersion | null {
  if (typeof raw !== 'string') return null
  const m = VERSION_RE.exec(raw.trim())
  if (!m) return null
  const nums = [m[1], m[2], m[3]].map(Number)
  if (nums.some((n) => !Number.isSafeInteger(n))) return null
  return { major: nums[0], minor: nums[1], patch: nums[2], prerelease: m[4] ? m[4].split('.') : [] }
}

/** "1.2.3" or "1.2.3-beta.1" (no "v", no build metadata). */
export function formatVersion(v: ParsedVersion): string {
  const core = `${v.major}.${v.minor}.${v.patch}`
  return v.prerelease.length ? `${core}-${v.prerelease.join('.')}` : core
}

function compareIdentifiers(a: string, b: string): number {
  const aNum = /^\d+$/.test(a)
  const bNum = /^\d+$/.test(b)
  if (aNum && bNum) return Math.sign(Number(a) - Number(b))
  // Numeric identifiers sort lower than alphanumeric ones (semver 11.4.4).
  if (aNum) return -1
  if (bNum) return 1
  return a < b ? -1 : a > b ? 1 : 0
}

/** -1, 0 or 1. */
export function compareParsed(a: ParsedVersion, b: ParsedVersion): number {
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1
  }
  if (!a.prerelease.length && !b.prerelease.length) return 0
  if (!a.prerelease.length) return 1
  if (!b.prerelease.length) return -1
  const len = Math.max(a.prerelease.length, b.prerelease.length)
  for (let i = 0; i < len; i++) {
    const x = a.prerelease[i]
    const y = b.prerelease[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const c = compareIdentifiers(x, y)
    if (c !== 0) return c
  }
  return 0
}

/** Compares two version strings; null when either is not valid semver. */
export function compareVersions(a: string, b: string): number | null {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  return pa && pb ? compareParsed(pa, pb) : null
}

/** True only when `candidate` is valid and strictly newer than `current`. */
export function isNewer(candidate: string, current: string): boolean {
  return (compareVersions(candidate, current) ?? 0) > 0
}
