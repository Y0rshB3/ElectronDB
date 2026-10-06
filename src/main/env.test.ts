import { describe, expect, it } from 'vitest'
import { envVar } from './env'

describe('envVar', () => {
  it('reads the ELECTRONDB_ name', () => {
    expect(envVar('SMOKE', { ELECTRONDB_SMOKE: '1' })).toBe('1')
  })

  it('falls back to the legacy NAVIDOG_ name', () => {
    expect(envVar('USER_DATA', { NAVIDOG_USER_DATA: '/tmp/p' })).toBe('/tmp/p')
  })

  it('prefers the new name when both are set', () => {
    expect(envVar('DEBUG', { ELECTRONDB_DEBUG: 'new', NAVIDOG_DEBUG: 'old' })).toBe('new')
  })

  it('is undefined when neither is set', () => {
    expect(envVar('SMOKE', {})).toBeUndefined()
  })
})
