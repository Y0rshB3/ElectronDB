import { describe, expect, it } from 'vitest'
import golden from './golden/mysql.json'
import {
  analyzeDestructive,
  analyzeWrites,
  isObviousWrite,
  leadingKeyword,
  mysqlDialect,
  qualified,
  quoteIdent,
  quoteString,
  splitOnSemicolons,
  splitStatements
} from './mysql'

/**
 * Golden corpus for the MySQL dialect. golden/mysql.json was captured from the
 * v0.1.0 (c147306) helpers at their old paths, before P1a moved them, so these
 * tests prove the move changed no output: splits (with start lines), both guard
 * functions (including the dialog reasons and their order) and quoting.
 *
 * Only add entries whose outputs were computed with the v0.1.0 code; never
 * regenerate the file from the code under test.
 */

const label = (input: string): string => JSON.stringify(input).slice(0, 80)

describe('MySQL dialect golden corpus', () => {
  it('covers the whole corpus', () => {
    expect(golden.sql.length).toBeGreaterThanOrEqual(300)
    expect(new Set(golden.sql.map((e) => e.input)).size).toBe(golden.sql.length)
  })

  describe.each(golden.sql.map((e) => [label(e.input), e] as const))('%s', (_name, e) => {
    it('splits like the mysql CLI', () => {
      expect(splitStatements(e.input)).toEqual(e.splitStatements)
      expect(mysqlDialect.splitStatements(e.input)).toEqual(e.splitStatements)
    })

    it('main guard (denylist) gives the same verdict', () => {
      expect(leadingKeyword(e.input)).toBe(e.leadingKeyword)
      expect(isObviousWrite(e.input)).toBe(e.isObviousWrite)
      expect(mysqlDialect.isObviousWrite(e.input)).toBe(e.isObviousWrite)
      const statements = mysqlDialect.splitStatements(e.input)
      expect(statements.some((s) => mysqlDialect.isObviousWrite(s.sql))).toBe(
        e.scriptObviouslyWrites
      )
    })

    it('renderer guard (allowlist) gives the same verdict and reasons', () => {
      expect(analyzeWrites(e.input)).toEqual(e.analyzeWrites)
      expect(mysqlDialect.analyzeWrites(e.input)).toEqual(e.analyzeWrites)
      expect(analyzeDestructive(e.input)).toEqual(e.analyzeDestructive)
      expect(splitOnSemicolons(e.input)).toEqual(e.splitSimple)
    })

    it('main never blocks what the renderer lets through (section 10)', () => {
      const asks = mysqlDialect.analyzeWrites(e.input).writes
      if (mysqlDialect.isObviousWrite(e.input)) expect(asks).toBe(true)
      for (const s of mysqlDialect.splitStatements(e.input)) {
        if (mysqlDialect.isObviousWrite(s.sql)) expect(asks).toBe(true)
      }
    })
  })

  it('quotes identifiers and strings like v0.1.0', () => {
    for (const e of golden.quoteIdent) {
      expect(quoteIdent(e.input), label(e.input)).toBe(e.output)
      expect(mysqlDialect.quoteIdent(e.input), label(e.input)).toBe(e.output)
    }
    for (const e of golden.quoteString) {
      expect(quoteString(e.input), label(e.input)).toBe(e.output)
      expect(mysqlDialect.quoteString(e.input), label(e.input)).toBe(e.output)
    }
    for (const e of golden.qualified) {
      const schema = 'schema' in e ? e.schema : undefined
      expect(qualified(schema, e.name), label(e.name)).toBe(e.output)
      expect(mysqlDialect.qualified(schema, e.name), label(e.name)).toBe(e.output)
    }
  })
})
