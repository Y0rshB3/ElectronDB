import { describe, expect, it } from 'vitest'
import { columnKind, typeLabel, valueHint } from './columnKind'

describe('columnKind', () => {
  it('detects numeric types, including unsigned variants', () => {
    for (const t of ['INT', 'BIGINT UNSIGNED', 'DECIMAL', 'double', 'TINYINT', 'YEAR', 'BIT'])
      expect(columnKind(t)).toBe('number')
  })

  it('detects temporal types', () => {
    for (const t of ['DATE', 'TIME', 'DATETIME', 'TIMESTAMP'])
      expect(columnKind(t)).toBe('temporal')
  })

  it('treats everything else as text', () => {
    for (const t of ['VARCHAR', 'JSON', 'ENUM', 'BLOB', 'INTERVAL', '', undefined, null])
      expect(columnKind(t)).toBe('text')
  })
})

describe('valueHint', () => {
  it('gives the literal format for temporal types and a numeric hint for numbers', () => {
    expect(valueHint('DATE').placeholder).toBe('AAAA-MM-DD')
    expect(valueHint('datetime').placeholder).toBe('AAAA-MM-DD hh:mm:ss')
    expect(valueHint('TIMESTAMP').placeholder).toBe('AAAA-MM-DD hh:mm:ss')
    expect(valueHint('TIME').placeholder).toBe('hh:mm:ss')
    expect(valueHint('YEAR')).toEqual({ placeholder: 'AAAA', inputmode: 'decimal' })
    expect(valueHint('INT UNSIGNED')).toEqual({ placeholder: 'Número', inputmode: 'decimal' })
    expect(valueHint('VARCHAR')).toEqual({ placeholder: 'Valor', inputmode: 'text' })
    expect(valueHint(undefined).placeholder).toBe('Valor')
  })
})

describe('typeLabel', () => {
  it('names the value kind like Navicat', () => {
    expect(typeLabel('INT UNSIGNED')).toBe('Número')
    expect(typeLabel('varchar')).toBe('Texto')
    expect(typeLabel('DATE')).toBe('Fecha')
    expect(typeLabel('DATETIME')).toBe('Fecha y hora')
    expect(typeLabel('TIME')).toBe('Hora')
    expect(typeLabel('BLOB')).toBe('Binario')
    expect(typeLabel('')).toBe('')
  })
})
