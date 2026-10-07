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
  buildPgFilterWhere,
  compileCondition,
  escapeLike,
  pgFilterNeedsColumns,
  resolveColumn,
  type PgFilterColumn
} from './tableFilter'

const COLUMNS: PgFilterColumn[] = [
  { name: 'id', typeKind: 'integer', dataType: 'integer' },
  { name: 'name', typeKind: 'text', dataType: 'text' },
  { name: 'Name', typeKind: 'text', dataType: 'text' },
  { name: 'active', typeKind: 'boolean', dataType: 'boolean' },
  { name: 'doc', typeKind: 'json', dataType: 'json' },
  { name: 'data', typeKind: 'json', dataType: 'jsonb' },
  { name: 'tags', typeKind: 'array', dataType: 'text[]' },
  { name: 'we"ird', typeKind: 'text', dataType: 'text' },
  { name: 'mood', typeKind: 'enum', dataType: 'mood' }
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
  buildPgFilterWhere(group(children), COLUMNS)

describe('compileCondition (PostgreSQL): every operator', () => {
  const cases: [TableFilterOperator, string[], string][] = [
    ['eq', ['a'], `name = 'a'`],
    ['ne', ['a'], `name <> 'a'`],
    ['lt', ['5'], `name < '5'`],
    ['le', ['5'], `name <= '5'`],
    ['gt', ['5'], `name > '5'`],
    ['ge', ['5'], `name >= '5'`],
    ['contains', ['ab'], `name::text ILIKE '%ab%' ESCAPE '\\'`],
    ['notContains', ['ab'], `name::text NOT ILIKE '%ab%' ESCAPE '\\'`],
    ['beginsWith', ['ab'], `name::text ILIKE 'ab%' ESCAPE '\\'`],
    ['notBeginsWith', ['ab'], `name::text NOT ILIKE 'ab%' ESCAPE '\\'`],
    ['endsWith', ['ab'], `name::text ILIKE '%ab' ESCAPE '\\'`],
    ['notEndsWith', ['ab'], `name::text NOT ILIKE '%ab' ESCAPE '\\'`],
    ['isNull', [], 'name IS NULL'],
    ['isNotNull', [], 'name IS NOT NULL'],
    ['isEmpty', [], `(name::text = '' OR name IS NULL)`],
    ['isNotEmpty', [], `(name::text <> '' AND name IS NOT NULL)`],
    ['in', ['a', 'b'], `name IN ('a', 'b')`],
    ['notIn', ['a'], `name NOT IN ('a')`],
    ['between', ['a', 'c'], `name BETWEEN 'a' AND 'c'`],
    ['notBetween', ['a', 'c'], `name NOT BETWEEN 'a' AND 'c'`]
  ]
  it.each(cases)('%s', (op, values, sql) => {
    expect(compileCondition(cond(op, { values }), COLUMNS)).toBe(sql)
  })
})

describe('PostgreSQL value handling', () => {
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
      `name::text ILIKE '%50\\%%' ESCAPE '\\'`
    )
  })

  it('normalises booleans and refuses other values', () => {
    const b = (v: string, op: TableFilterOperator = 'eq') =>
      compileCondition(cond(op, { column: 'active', values: [v] }), COLUMNS)
    expect(b('true')).toBe('active = TRUE')
    expect(b('Sí')).toBe('active = TRUE')
    expect(b('0')).toBe('active = FALSE')
    expect(b('f', 'ne')).toBe('active <> FALSE')
    expect(() => b('maybe')).toThrow('no es un booleano')
  })

  it('compares json as text and jsonb as jsonb', () => {
    expect(compileCondition(cond('eq', { column: 'doc', values: ['{"a":1}'] }), COLUMNS)).toBe(
      `doc::text = '{"a":1}'`
    )
    expect(compileCondition(cond('eq', { column: 'data', values: ['{"a": 1}'] }), COLUMNS)).toBe(
      `data = '{"a": 1}'::jsonb`
    )
    expect(compileCondition(cond('in', { column: 'data', values: ['1', '"x"'] }), COLUMNS)).toBe(
      `data IN ('1'::jsonb, '"x"'::jsonb)`
    )
    expect(compileCondition(cond('contains', { column: 'data', values: ['k'] }), COLUMNS)).toBe(
      `data::text ILIKE '%k%' ESCAPE '\\'`
    )
  })

  it('leaves arrays and enums to the server cast (untyped literal)', () => {
    expect(compileCondition(cond('eq', { column: 'tags', values: ['{a,"b c"}'] }), COLUMNS)).toBe(
      `tags = '{a,"b c"}'`
    )
    expect(compileCondition(cond('eq', { column: 'mood', values: ['happy'] }), COLUMNS)).toBe(
      `mood = 'happy'`
    )
    expect(compileCondition(cond('isEmpty', { column: 'tags' }), COLUMNS)).toBe(
      `(tags::text = '' OR tags IS NULL)`
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

describe('PostgreSQL column resolution', () => {
  it('quotes identifiers and prefers the exact (case-sensitive) name', () => {
    expect(compileCondition(cond('isNull', { column: 'Name' }), COLUMNS)).toBe('"Name" IS NULL')
    expect(compileCondition(cond('isNull', { column: 'we"ird' }), COLUMNS)).toBe(
      '"we""ird" IS NULL'
    )
    expect(resolveColumn('ID', COLUMNS).name).toBe('id')
  })

  it('refuses unknown or ambiguous names, so no identifier is ever injected', () => {
    expect(() => resolveColumn('NAME', COLUMNS)).toThrow('«NAME» no existe')
    expect(() => resolveColumn('name" = name OR "1', COLUMNS)).toThrow('no existe')
    expect(() => resolveColumn('', COLUMNS)).toThrow('Elige una columna')
    expect(() => compileCondition(cond('bogus' as TableFilterOperator), COLUMNS)).toThrow(
      'Operador de filtro no válido'
    )
  })
})

describe('buildPgFilterWhere', () => {
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
    expect(buildPgFilterWhere(null, COLUMNS)).toBe('')
    expect(where()).toBe('')
    expect(
      buildPgFilterWhere(group([cond('eq', { values: ['a'] })], { enabled: false }), COLUMNS)
    ).toBe('')
  })

  it('enforces the depth and size limits', () => {
    let deep: TableFilterNode = cond('isNull')
    for (let i = 0; i <= MAX_FILTER_DEPTH + 1; i++) deep = group([deep]) as TableFilterNode
    expect(() => buildPgFilterWhere(deep as TableFilter, COLUMNS)).toThrow('niveles de paréntesis')
    const many = Array.from({ length: MAX_FILTER_CONDITIONS + 1 }, () => cond('isNull'))
    expect(() => where(...many)).toThrow(`como máximo ${MAX_FILTER_CONDITIONS} condiciones`)
    expect(() =>
      buildPgFilterWhere({ kind: 'condition' } as unknown as TableFilter, COLUMNS)
    ).toThrow('Filtro no válido')
    expect(() => where(cond('isNull', { connector: 'XOR' as 'AND' }))).toThrow('AND u OR')
  })

  it('knows when the column list is needed', () => {
    expect(pgFilterNeedsColumns(null)).toBe(false)
    expect(pgFilterNeedsColumns(group([cond('custom', { sql: 'x' })]))).toBe(false)
    expect(pgFilterNeedsColumns(group([cond('isNull')]))).toBe(true)
    expect(pgFilterNeedsColumns(group([cond('isNull', { enabled: false })]))).toBe(false)
  })
})
