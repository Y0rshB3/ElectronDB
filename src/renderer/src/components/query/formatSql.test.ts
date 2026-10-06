import { describe, expect, it } from 'vitest'
import { formatSql } from './formatSql'

describe('formatSql', () => {
  it('upper-cases keywords but not strings, identifiers or comments', () => {
    const src =
      "select `from`, name from t where note = 'select me' -- from here\nand x.order is not null"
    expect(formatSql(src)).toBe(
      "SELECT `from`, name FROM t WHERE note = 'select me' -- from here\nAND x.order IS NOT NULL"
    )
  })
})
