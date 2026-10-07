import { describe, expect, it } from 'vitest'
import * as dialect from '@shared/dialects/mysql'
import * as writeGuard from '@renderer/components/query/writeGuard'
import * as sql from './sql'

// P1a moved these helpers to src/shared/dialects/mysql.ts; the old paths
// re-export the very same functions for one phase.
describe('old import paths (renderer)', () => {
  it('re-export the dialect functions unchanged', () => {
    expect(sql.quoteIdent).toBe(dialect.quoteIdent)
    expect(sql.quoteString).toBe(dialect.quoteString)
    expect(sql.qualified).toBe(dialect.qualified)
    expect(sql.analyzeDestructive).toBe(dialect.analyzeDestructive)
    expect(sql.splitStatements).toBe(dialect.splitOnSemicolons)
    expect(writeGuard.analyzeWrites).toBe(dialect.analyzeWrites)
  })
})
