import { describe, expect, it } from 'vitest'
import { formatBackupFileName, parseBackupFileName, sanitizeLabel } from './naming'

describe('backup file naming', () => {
  it('parses Navicat names with and without labels', () => {
    const plain = parseBackupFileName('20260317144801.nb3')
    expect(plain.label).toBeNull()
    expect(new Date(plain.createdAt!).getTime()).toBe(new Date(2026, 2, 17, 14, 48, 1).getTime())
    expect(parseBackupFileName('20260317145120-staging.nb3').label).toBe('staging')
    expect(parseBackupFileName('20260317145120 antes de migrar.nb3').label).toBe('antes de migrar')
  })

  it('rejects names that are not timestamps', () => {
    expect(parseBackupFileName('backup.nb3')).toEqual({ createdAt: null, label: null })
    expect(parseBackupFileName('20261340999999.nb3').createdAt).toBeNull()
  })

  it('sanitises labels', () => {
    expect(sanitizeLabel('a/b\\c:d')).toBe('a-b-c-d')
    expect(sanitizeLabel('x\u0000y\u001fz')).toBe('x-y-z')
    expect(sanitizeLabel('  ..hola  ')).toBe('hola')
    expect(sanitizeLabel(null)).toBe('')
  })

  it('formats round-trippable names', () => {
    const date = new Date(2026, 9, 5, 7, 8, 9)
    expect(formatBackupFileName(date)).toBe('20261005070809.nb3')
    const name = formatBackupFileName(date, 'Nightly job')
    expect(name).toBe('20261005070809-Nightly job.nb3')
    expect(parseBackupFileName(name).label).toBe('Nightly job')
  })
})
