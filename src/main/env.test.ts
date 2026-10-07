import { describe, expect, it } from 'vitest'
import { envVar } from './env'

describe('envVar', () => {
  it('reads the VORTAQ_ name', () => {
    expect(envVar('SMOKE', { VORTAQ_SMOKE: '1' })).toBe('1')
  })

  it('falls back to the ElectronDB name', () => {
    expect(envVar('USER_DATA', { ELECTRONDB_USER_DATA: '/tmp/e' })).toBe('/tmp/e')
  })

  it('falls back to the Navidog name', () => {
    expect(envVar('USER_DATA', { NAVIDOG_USER_DATA: '/tmp/p' })).toBe('/tmp/p')
  })

  it('prefers the newest name when several are set', () => {
    expect(
      envVar('DEBUG', { VORTAQ_DEBUG: 'new', ELECTRONDB_DEBUG: 'mid', NAVIDOG_DEBUG: 'old' })
    ).toBe('new')
    expect(envVar('DEBUG', { ELECTRONDB_DEBUG: 'mid', NAVIDOG_DEBUG: 'old' })).toBe('mid')
  })

  it('is undefined when none is set', () => {
    expect(envVar('SMOKE', {})).toBeUndefined()
  })
})
