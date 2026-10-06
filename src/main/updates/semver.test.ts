import { describe, expect, it } from 'vitest'
import { compareVersions, formatVersion, isNewer, parseVersion } from './semver'

describe('parseVersion', () => {
  it('accepts plain and v-prefixed versions', () => {
    expect(parseVersion('0.1.2')).toEqual({ major: 0, minor: 1, patch: 2, prerelease: [] })
    expect(parseVersion('v0.1.3')).toEqual({ major: 0, minor: 1, patch: 3, prerelease: [] })
    expect(parseVersion('V1.0.0')).not.toBeNull()
    expect(parseVersion(' v2.10.0 ')).toMatchObject({ major: 2, minor: 10 })
  })

  it('reads pre-release identifiers and ignores build metadata', () => {
    expect(parseVersion('v1.0.0-beta.2+build.7')?.prerelease).toEqual(['beta', '2'])
    expect(formatVersion(parseVersion('v1.0.0-rc.1+abc')!)).toBe('1.0.0-rc.1')
  })

  it('rejects invalid tags', () => {
    for (const bad of [
      '',
      'latest',
      'v1',
      '1.2',
      '1.2.3.4',
      'v01.2.3',
      '1.2.x',
      'release-1.2.3',
      null,
      12,
      {}
    ])
      expect(parseVersion(bad as never)).toBeNull()
  })
})

describe('compareVersions', () => {
  it('orders by major, minor and patch numerically', () => {
    expect(compareVersions('v0.1.3', '0.1.2')).toBe(1)
    expect(compareVersions('0.1.2', 'v0.1.2')).toBe(0)
    expect(compareVersions('0.10.0', '0.9.9')).toBe(1)
    expect(compareVersions('1.0.0', '0.99.99')).toBe(1)
    expect(compareVersions('0.1.2', '0.2.0')).toBe(-1)
  })

  it('sorts pre-releases lower than the release', () => {
    expect(compareVersions('1.0.0-beta.1', '1.0.0')).toBe(-1)
    expect(compareVersions('1.0.0', '1.0.0-rc.1')).toBe(1)
    expect(compareVersions('1.0.0-alpha', '1.0.0-alpha.1')).toBe(-1)
    expect(compareVersions('1.0.0-alpha.2', '1.0.0-alpha.10')).toBe(-1)
    expect(compareVersions('1.0.0-1', '1.0.0-alpha')).toBe(-1)
    expect(compareVersions('1.0.0-beta', '1.0.0-alpha')).toBe(1)
    expect(compareVersions('1.0.1-beta', '1.0.0')).toBe(1)
  })

  it('returns null when a side is invalid; isNewer is then false', () => {
    expect(compareVersions('nightly', '0.1.2')).toBeNull()
    expect(isNewer('nightly', '0.1.2')).toBe(false)
    expect(isNewer('v0.1.3', 'dev')).toBe(false)
    expect(isNewer('v0.1.3', '0.1.2')).toBe(true)
    expect(isNewer('v0.1.2', '0.1.2')).toBe(false)
  })
})
