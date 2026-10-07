import { describe, expect, it } from 'vitest'
import * as dialect from '@shared/dialects/mysql'
import * as guard from '@shared/productionGuard'
import * as split from './sqlSplit'

// P1a moved these helpers to src/shared/dialects/mysql.ts; the old paths
// re-export the very same functions for one phase.
describe('old import paths (main and shared)', () => {
  it('re-export the dialect functions unchanged', () => {
    expect(split.splitStatements).toBe(dialect.splitStatements)
    expect(guard.isObviousWrite).toBe(dialect.isObviousWrite)
    expect(guard.leadingKeyword).toBe(dialect.leadingKeyword)
  })
})
