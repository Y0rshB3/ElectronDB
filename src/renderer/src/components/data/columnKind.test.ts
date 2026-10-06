import { describe, expect, it } from 'vitest'
import { columnKind } from './columnKind'

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
