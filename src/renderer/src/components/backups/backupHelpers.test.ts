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
    expect(backupObjectTypeLabel('Sequence')).toBe('Sequence')
  })
})
