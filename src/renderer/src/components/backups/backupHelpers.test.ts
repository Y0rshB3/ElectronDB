import { describe, expect, it } from 'vitest'
import { backupObjectTypeLabel } from './backupHelpers'

describe('backupObjectTypeLabel', () => {
  it('maps Navicat object types to Spanish labels', () => {
    expect(backupObjectTypeLabel('Table')).toBe('Tabla')
    expect(backupObjectTypeLabel('View')).toBe('Vista')
    expect(backupObjectTypeLabel('Function')).toBe('Función')
    expect(backupObjectTypeLabel('Procedure')).toBe('Procedimiento')
    expect(backupObjectTypeLabel('Event')).toBe('Evento')
    expect(backupObjectTypeLabel('trigger')).toBe('Disparador')
  })

  it('keeps unknown types unchanged', () => {
    expect(backupObjectTypeLabel('Rule')).toBe('Rule')
  })

  it('labels the PostgreSQL types of .vqb backups', () => {
    expect(backupObjectTypeLabel('Sequence')).toBe('Secuencia')
    expect(backupObjectTypeLabel('MaterializedView')).toBe('Vista materializada')
  })
})

describe('sourceChip', () => {
  it('never throws on an unexpected backup source (e.g. "navidog" from a pre-rename main)', async () => {
    const { sourceChip } = await import('./backupHelpers')
    expect(sourceChip('electrondb').label).toBe('Vortaq')
    expect(sourceChip('navicat').label).toBe('Navicat')
    expect(sourceChip('navidog').label).toBe('Desconocido')
    expect(sourceChip(undefined).label).toBe('Desconocido')
  })
})

describe('restoreTargets (SQLite)', () => {
  it('offers a SQLite .vqb only to SQLite connections, and keeps MySQL and PostgreSQL apart', async () => {
    const { restoreTargets, engineLabel } = await import('./backupHelpers')
    const { makeConnection } = await import('@renderer/__tests__/shellTestUtils')
    const list = [
      makeConnection({ id: 'my' }),
      makeConnection({ id: 'pg', engine: 'postgresql' }),
      makeConnection({ id: 'lite', engine: 'sqlite' })
    ]
    const ids = (engine: 'mysql' | 'postgresql' | 'sqlite') =>
      restoreTargets(list, { format: 'vqb', engine, locked: false }).map((c) => c.id)
    expect(ids('sqlite')).toEqual(['lite'])
    expect(ids('postgresql')).toEqual(['pg'])
    expect(ids('mysql')).toEqual(['my'])
    expect(restoreTargets(list, { format: 'nb3', locked: false }).map((c) => c.id)).toEqual(['my'])
    expect(engineLabel('sqlite', 'sqlite')).toBe('SQLite')
  })
})
