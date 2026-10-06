import { describe, expect, it } from 'vitest'
import { parseVersion } from './semver'
import { WHATS_NEW, whatsNewBetween, whatsNewFor, type WhatsNewEntry } from './whatsNew'

const entries: WhatsNewEntry[] = ['0.1.1', '0.1.2', '0.1.3', '0.1.4'].map((version) => ({
  version,
  date: '2026-10-06',
  highlights: [version]
}))
const versions = (list: WhatsNewEntry[]) => list.map((e) => e.version)

describe('whatsNewBetween', () => {
  it('returns the versions after previous up to current, newest first', () => {
    expect(versions(whatsNewBetween('0.1.2', '0.1.4', entries))).toEqual(['0.1.4', '0.1.3'])
    expect(versions(whatsNewBetween('0.1.3', '0.1.4', entries))).toEqual(['0.1.4'])
    expect(versions(whatsNewBetween('0.1.0', '0.1.2', entries))).toEqual(['0.1.2', '0.1.1'])
  })

  it('is empty for a fresh profile, the same version, a downgrade or invalid versions', () => {
    expect(whatsNewBetween(null, '0.1.4', entries)).toEqual([])
    expect(whatsNewBetween(undefined, '0.1.4', entries)).toEqual([])
    expect(whatsNewBetween('0.1.4', '0.1.4', entries)).toEqual([])
    expect(whatsNewBetween('0.1.4', '0.1.2', entries)).toEqual([])
    expect(whatsNewBetween('x', '0.1.4', entries)).toEqual([])
    expect(whatsNewBetween('0.1.2', 'dev', entries)).toEqual([])
  })

  it('skips versions without entries (unknown versions)', () => {
    expect(whatsNewBetween('0.1.4', '0.2.0', entries)).toEqual([])
    expect(versions(whatsNewBetween('0.0.1', '0.1.1-beta.1', entries))).toEqual([])
    expect(versions(whatsNewBetween('0.1.3', '1.0.0', entries))).toEqual(['0.1.4'])
  })

  it('finds the entry of one version', () => {
    expect(whatsNewFor('0.1.3', entries)?.highlights).toEqual(['0.1.3'])
    expect(whatsNewFor('0.9.9', entries)).toBeNull()
  })
})

describe('WHATS_NEW (curated list)', () => {
  it('has valid, unique versions and short lists', () => {
    const seen = new Set<string>()
    for (const e of WHATS_NEW) {
      expect(parseVersion(e.version), e.version).not.toBeNull()
      expect(seen.has(e.version)).toBe(false)
      seen.add(e.version)
      expect(e.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(e.highlights.length).toBeGreaterThan(0)
      expect(e.highlights.length).toBeLessThanOrEqual(5)
    }
    expect([...seen]).toEqual(expect.arrayContaining(['0.1.1', '0.1.2', '0.1.3', '0.1.4']))
  })

  it('0.1.5 explains the typed-confirmation environments and that production is always on', () => {
    const entry = whatsNewFor('0.1.5')
    expect(entry?.highlights[0]).toMatch(/Ajustes › Seguridad.*Producción por defecto/)
    expect(entry?.important?.join(' ')).toMatch(/Producción ahora siempre pide escribir el nombre/)
  })

  it('0.1.6 announces the AI assistant and that only the structure is sent', () => {
    expect(whatsNewFor('0.1.6')?.highlights.join(' ')).toMatch(
      /Asistente de IA con tu propia clave.*solo se envía la estructura/
    )
  })

  it('0.1.4 points to the new switch in Ajustes › Seguridad', () => {
    expect(whatsNewFor('0.1.4')?.important?.join(' ')).toMatch(/Ajustes › Seguridad/)
  })
})
