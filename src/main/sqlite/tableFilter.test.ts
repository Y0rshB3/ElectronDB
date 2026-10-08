import { describe, expect, it } from 'vitest'
import type {
  TableFilter,
  TableFilterCondition,
  TableFilterGroup,
  TableFilterNode,
  TableFilterOperator
} from '@shared/types'
import { DbUserError } from '../db/errors'
import {
  MAX_FILTER_CONDITIONS,
  MAX_FILTER_DEPTH,
  MAX_IN_VALUES,
  buildSqliteFilterWhere,
  compileCondition,
  escapeLike,
  sqliteFilterNeedsColumns,
  resolveColumn,
  type SqliteFilterColumn
} from './tableFilter'

const COLUMNS: SqliteFilterColumn[] = [
  { name: 'id', typeKind: 'integer', dataType: 'INTEGER' },
  { name: 'name', typeKind: 'text', dataType: 'TEXT' },
  { name: 'Order', typeKind: 'text', dataType: 'TEXT' },
  { name: 'active', typeKind: 'integer', dataType: 'BOOLEAN' },
  { name: 'loose', typeKind: 'other', dataType: '' },
  { name: 'img', typeKind: 'binary', dataType: 'BLOB' },
  { name: 'we"ird', typeKind: 'text', dataType: 'TEXT' }
]

function cond(
  operator: TableFilterOperator,
  extra: Partial<TableFilterCondition> = {}
): TableFilterCondition {
  return {
    kind: 'condition',
    enabled: true,
    column: 'name',
    operator,
    values: [],
    connector: 'AND',
    ...extra
  }
}

function group(children: TableFilterNode[], extra: Partial<TableFilterGroup> = {}): TableFilter {
  return { kind: 'group', enabled: true, connector: 'AND', children, ...extra }
}

const where = (...children: TableFilterNode[]): string =>
  buildSqliteFilterWhere(group(children), COLUMNS)

describe('compileCondition (SQLite): every operator', () => {
  const cases: [TableFilterOperator, string[], string][] = [
    ['eq', ['a'], `name = 'a'`],
    ['ne', ['a'], `name <> 'a'`],
    ['lt', ['5'], `name < '5'`],
    ['le', ['5'], `name <= '5'`],
    ['gt', ['5'], `name > '5'`],
    ['ge', ['5'], `name >= '5'`],
    ['contains', ['ab'], `name LIKE '%ab%' ESCAPE '\\'`],
    ['notContains', ['ab'], `name NOT LIKE '%ab%' ESCAPE '\\'`],
    ['beginsWith', ['ab'], `name LIKE 'ab%' ESCAPE '\\'`],
    ['notBeginsWith', ['ab'], `name NOT LIKE 'ab%' ESCAPE '\\'`],
    ['endsWith', ['ab'], `name LIKE '%ab' ESCAPE '\\'`],
    ['notEndsWith', ['ab'], `name NOT LIKE '%ab' ESCAPE '\\'`],
    ['isNull', [], 'name IS NULL'],
    ['isNotNull', [], 'name IS NOT NULL'],
    ['isEmpty', [], `(CAST(name AS TEXT) = '' OR name IS NULL)`],
    ['isNotEmpty', [], `(CAST(name AS TEXT) <> '' AND name IS NOT NULL)`],
    ['in', ['a', 'b'], `name IN ('a', 'b')`],
    ['notIn', ['a'], `name NOT IN ('a')`],
    ['between', ['a', 'c'], `name BETWEEN 'a' AND 'c'`],
    ['notBetween', ['a', 'c'], `name NOT BETWEEN 'a' AND 'c'`]
  ]
  it.each(cases)('%s', (op, values, sql) => {
    expect(compileCondition(cond(op, { values }), COLUMNS)).toBe(sql)
  })
})

describe('SQLite value handling', () => {
  it('escapes quotes by doubling and never uses backslash escapes', () => {
    expect(compileCondition(cond('eq', { values: ["o'reilly\\x"] }), COLUMNS)).toBe(
      `name = 'o''reilly\\x'`
    )
    expect(compileCondition(cond('eq', { values: ["x'; DROP TABLE t; --"] }), COLUMNS)).toBe(
      `name = 'x''; DROP TABLE t; --'`
    )
  })

  it('escapes LIKE wildcards', () => {
    expect(escapeLike('50%_a\\b')).toBe('50\\%\\_a\\\\b')
    expect(compileCondition(cond('contains', { values: ['50%'] }), COLUMNS)).toBe(
      `name LIKE '%50\\%%' ESCAPE '\\'`
    )
  })

  it('turns booleans into 1 and 0 and refuses other values', () => {
    const b = (v: string, op: TableFilterOperator = 'eq') =>
      compileCondition(cond(op, { column: 'active', values: [v] }), COLUMNS)
    expect(b('true')).toBe('active = 1')
    expect(b('Sí')).toBe('active = 1')
    expect(b('0')).toBe('active = 0')
    expect(b('f', 'ne')).toBe('active <> 0')
    expect(() => b('maybe')).toThrow('no es un booleano')
  })

  it('compares number-looking values as numbers only on untyped columns', () => {
    expect(compileCondition(cond('eq', { column: 'loose', values: ['5'] }), COLUMNS)).toBe(
      'loose = 5'
    )
    expect(compileCondition(cond('eq', { column: 'loose', values: ['-1.5e3'] }), COLUMNS)).toBe(
      'loose = -1.5e3'
    )
    expect(compileCondition(cond('eq', { column: 'loose', values: ['5 apples'] }), COLUMNS)).toBe(
      `loose = '5 apples'`
    )
    expect(compileCondition(cond('in', { column: 'loose', values: ['1', 'x'] }), COLUMNS)).toBe(
      `loose IN (1, 'x')`
    )
    // Declared numeric affinity converts the text literal itself.
    expect(compileCondition(cond('eq', { column: 'id', values: ['5'] }), COLUMNS)).toBe(`id = '5'`)
    expect(compileCondition(cond('eq', { column: 'img', values: ['5'] }), COLUMNS)).toBe(
      `img = '5'`
    )
  })

  it('uses LIKE (ASCII case-insensitive) and CAST for emptiness on any column', () => {
    expect(compileCondition(cond('contains', { column: 'loose', values: ['k'] }), COLUMNS)).toBe(
      `loose LIKE '%k%' ESCAPE '\\'`
    )
    expect(compileCondition(cond('isEmpty', { column: 'img' }), COLUMNS)).toBe(
      `(CAST(img AS TEXT) = '' OR img IS NULL)`
    )
  })

  it('accepts finite numbers and refuses objects, NaN and NUL characters', () => {
    expect(
      compileCondition(cond('eq', { column: 'id', values: [5 as unknown as string] }), COLUMNS)
    ).toBe(`id = '5'`)
    expect(() =>
      compileCondition(cond('eq', { values: [{} as unknown as string] }), COLUMNS)
    ).toThrow('Falta el valor')
    expect(() =>
      compileCondition(cond('eq', { values: [NaN as unknown as string] }), COLUMNS)
    ).toThrow(DbUserError)
    expect(() => compileCondition(cond('eq', { values: ['a\0b'] }), COLUMNS)).toThrow(
      'carácter nulo'
    )
  })

  it('limits IN lists', () => {
    const many = Array.from({ length: MAX_IN_VALUES + 1 }, (_, i) => String(i))
    expect(() => compileCondition(cond('in', { values: many }), COLUMNS)).toThrow(
      `como máximo ${MAX_IN_VALUES} valores`
    )
    expect(() => compileCondition(cond('in', { values: [] }), COLUMNS)).toThrow('Falta la lista')
  })
})

describe('SQLite column resolution', () => {
  it('quotes keywords and odd names, and matches names case-insensitively', () => {
    expect(compileCondition(cond('isNull', { column: 'order' }), COLUMNS)).toBe('"Order" IS NULL')
    expect(compileCondition(cond('isNull', { column: 'we"ird' }), COLUMNS)).toBe(
      '"we""ird" IS NULL'
    )
    expect(resolveColumn('ID', COLUMNS).name).toBe('id')
  })

  it('refuses unknown or ambiguous names, so no identifier is ever injected', () => {
    expect(resolveColumn('NAME', COLUMNS).name).toBe('name')
    expect(() => resolveColumn('nombre', COLUMNS)).toThrow('«nombre» no existe')
    expect(() => resolveColumn('name" = name OR "1', COLUMNS)).toThrow('no existe')
    expect(() => resolveColumn('', COLUMNS)).toThrow('Elige una columna')
    expect(() => compileCondition(cond('bogus' as TableFilterOperator), COLUMNS)).toThrow(
      'Operador de filtro no válido'
    )
  })
})

describe('buildSqliteFilterWhere', () => {
  it('joins with connectors, skips disabled items and keeps custom SQL on its own lines', () => {
    expect(
      where(
        cond('eq', { values: ['a'], connector: 'OR' }),
        cond('eq', { column: 'id', values: ['1'], enabled: false }),
        group([cond('isNull', { connector: 'AND' }), cond('custom', { sql: 'id > 2 -- note' })], {
          connector: 'AND'
        }) as TableFilterNode
      )
    ).toBe(`(name = 'a') OR ((name IS NULL) AND (\nid > 2 -- note\n))`)
    expect(buildSqliteFilterWhere(null, COLUMNS)).toBe('')
    expect(where()).toBe('')
    expect(
      buildSqliteFilterWhere(group([cond('eq', { values: ['a'] })], { enabled: false }), COLUMNS)
    ).toBe('')
  })

  it('enforces the depth and size limits', () => {
    let deep: TableFilterNode = cond('isNull')
    for (let i = 0; i <= MAX_FILTER_DEPTH + 1; i++) deep = group([deep]) as TableFilterNode
    expect(() => buildSqliteFilterWhere(deep as TableFilter, COLUMNS)).toThrow(
      'niveles de paréntesis'
    )
    const many = Array.from({ length: MAX_FILTER_CONDITIONS + 1 }, () => cond('isNull'))
    expect(() => where(...many)).toThrow(`como máximo ${MAX_FILTER_CONDITIONS} condiciones`)
    expect(() =>
      buildSqliteFilterWhere({ kind: 'condition' } as unknown as TableFilter, COLUMNS)
    ).toThrow('Filtro no válido')
    expect(() => where(cond('isNull', { connector: 'XOR' as 'AND' }))).toThrow('AND u OR')
  })

  it('knows when the column list is needed', () => {
    expect(sqliteFilterNeedsColumns(null)).toBe(false)
    expect(sqliteFilterNeedsColumns(group([cond('custom', { sql: 'x' })]))).toBe(false)
    expect(sqliteFilterNeedsColumns(group([cond('isNull')]))).toBe(true)
    expect(sqliteFilterNeedsColumns(group([cond('isNull', { enabled: false })]))).toBe(false)
  })
})
