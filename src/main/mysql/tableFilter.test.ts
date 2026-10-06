import { describe, expect, it } from 'vitest'
import type {
  TableFilter,
  TableFilterCondition,
  TableFilterGroup,
  TableFilterJoin,
  TableFilterNode,
  TableFilterOperator
} from '@shared/types'
import {
  MAX_FILTER_CONDITIONS,
  MAX_FILTER_DEPTH,
  buildFilterWhere,
  compileCondition,
  escapeLike,
  filterNeedsColumns,
  resolveColumn
} from './tableFilter'

const COLUMNS = ['id', 'name', 'created_at', 'we`ird']

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

function where(...children: TableFilterNode[]): string {
  return buildFilterWhere(group(children), COLUMNS)
}

const v = (...values: string[]) => ({ values })
const join = (connector: TableFilterJoin) => ({ connector })

describe('compileCondition: every operator', () => {
  const cases: [TableFilterOperator, string[], string, unknown[]][] = [
    ['eq', ['a'], '`name` = ?', ['a']],
    ['ne', ['a'], '`name` <> ?', ['a']],
    ['lt', ['5'], '`name` < ?', ['5']],
    ['le', ['5'], '`name` <= ?', ['5']],
    ['gt', ['5'], '`name` > ?', ['5']],
    ['ge', ['5'], '`name` >= ?', ['5']],
    ['contains', ['ab'], '`name` LIKE ?', ['%ab%']],
    ['notContains', ['ab'], '`name` NOT LIKE ?', ['%ab%']],
    ['beginsWith', ['ab'], '`name` LIKE ?', ['ab%']],
    ['notBeginsWith', ['ab'], '`name` NOT LIKE ?', ['ab%']],
    ['endsWith', ['ab'], '`name` LIKE ?', ['%ab']],
    ['notEndsWith', ['ab'], '`name` NOT LIKE ?', ['%ab']],
    ['isNull', [], '`name` IS NULL', []],
    ['isNotNull', [], '`name` IS NOT NULL', []],
    ['isEmpty', [], "(`name` = '' OR `name` IS NULL)", []],
    ['isNotEmpty', [], "(`name` <> '' AND `name` IS NOT NULL)", []],
    ['in', ['a', 'b', 'c'], '`name` IN (?, ?, ?)', ['a', 'b', 'c']],
    ['notIn', ['a'], '`name` NOT IN (?)', ['a']],
    ['between', ['1', '9'], '`name` BETWEEN ? AND ?', ['1', '9']],
    ['notBetween', ['1', '9'], '`name` NOT BETWEEN ? AND ?', ['1', '9']]
  ]
  it.each(cases)('%s', (operator, values, sql, params) => {
    expect(compileCondition(cond(operator, { values }), COLUMNS)).toEqual({ sql, params })
  })

  it('accepts finite numbers as values', () => {
    expect(compileCondition(cond('gt', { values: [3 as never] }), COLUMNS).params).toEqual(['3'])
  })

  it('rejects custom and unknown operators', () => {
    expect(() => compileCondition(cond('custom'), COLUMNS)).toThrow(/no válido/)
    expect(() => compileCondition(cond('drop' as never), COLUMNS)).toThrow(/no válido/)
  })
})

describe('values are never SQL', () => {
  it('escapes LIKE wildcards and the escape character', () => {
    expect(escapeLike('50%_a\\b')).toBe('50\\%\\_a\\\\b')
    expect(compileCondition(cond('contains', v('100%')), COLUMNS).params).toEqual(['%100\\%%'])
  })

  it('escapes quotes and backslashes in the rendered WHERE', () => {
    expect(where(cond('eq', v("o'k\\")))).toBe("(`name` = 'o\\'k\\\\')")
    expect(where(cond('beginsWith', v("a_'%")))).toBe("(`name` LIKE 'a\\\\_\\'\\\\%%')")
  })

  it('does not expand objects or arrays given as a value', () => {
    expect(() => where(cond('eq', { values: [{ id: 1 }] as never }))).toThrow(/Falta el valor/)
    expect(() => where(cond('eq', { values: [['a']] as never }))).toThrow(/Falta el valor/)
    expect(() => where(cond('in', { values: [{ a: 1 }] as never }))).toThrow(/Falta el valor/)
    expect(() => where(cond('eq', { values: [Number.NaN] as never }))).toThrow(/Falta el valor/)
    expect(() => where(cond('eq', { values: 'abc' as never }))).toThrow(/Falta el valor/)
  })

  it('a ? inside a value or a custom row does not shift other parameters', () => {
    expect(
      where(
        cond('custom', { sql: "name <> 'why?'" }),
        cond('eq', v('?')),
        cond('between', { column: 'id', values: ['1', '2'] })
      )
    ).toBe("(\nname <> 'why?'\n) AND (`name` = '?') AND (`id` BETWEEN '1' AND '2')")
  })

  it('requires both BETWEEN bounds and a non-empty IN list', () => {
    expect(() => where(cond('between', v('1')))).toThrow(/valor final/)
    expect(() => where(cond('in'))).toThrow(/lista de valores/)
    expect(() => where(cond('eq'))).toThrow(/Falta el valor/)
  })
})

describe('identifiers', () => {
  it('escapes backticks and resolves names case-insensitively to the real column', () => {
    expect(where(cond('isNull', { column: 'we`ird' }))).toBe('(`we``ird` IS NULL)')
    expect(where(cond('isNull', { column: 'NAME' }))).toBe('(`name` IS NULL)')
    expect(resolveColumn('Created_At', COLUMNS)).toBe('created_at')
  })

  it('rejects a column the table does not have, or no column at all', () => {
    expect(() => where(cond('eq', { column: 'name` OR 1=1 -- ', values: ['x'] }))).toThrow(
      'La columna «name` OR 1=1 -- » no existe en la tabla'
    )
    expect(() => where(cond('isNull', { column: '' }))).toThrow(/Elige una columna/)
  })
})

describe('buildFilterWhere: tree, connectors and skipped items', () => {
  it('returns empty for no filter, an empty or disabled root, disabled items and empty groups', () => {
    expect(buildFilterWhere(null, COLUMNS)).toBe('')
    expect(where()).toBe('')
    expect(buildFilterWhere(group([cond('isNull')], { enabled: false }), COLUMNS)).toBe('')
    expect(
      where(
        cond('eq', { enabled: false, values: ['x'] }),
        cond('custom', { sql: '  ' }),
        group([]),
        group([cond('isNull', { enabled: false })])
      )
    ).toBe('')
  })

  it('joins siblings with each item connector (AND binds tighter, like SQL)', () => {
    expect(
      where(
        cond('eq', { ...v('a'), ...join('OR') }),
        cond('eq', { ...v('b'), ...join('AND') }),
        cond('isNull', { column: 'id' })
      )
    ).toBe("(`name` = 'a') OR (`name` = 'b') AND (`id` IS NULL)")
  })

  it('uses the connector of the last included item when the next ones are disabled', () => {
    expect(
      where(
        cond('eq', { ...v('a'), ...join('OR') }),
        cond('eq', { ...v('b'), ...join('AND'), enabled: false }),
        cond('isNull', { column: 'id' })
      )
    ).toBe("(`name` = 'a') OR (`id` IS NULL)")
  })

  it('nests brackets, with the group connector joining it to the next sibling', () => {
    // email contiene jorge y ( id > 1 o id < 10 -- nota ) o name es nulo
    const sql = where(
      cond('contains', { ...v('jorge'), ...join('AND') }),
      group(
        [
          cond('gt', { column: 'id', ...v('1'), ...join('OR') }),
          group([cond('custom', { sql: 'id < 10 -- nota' })]),
          cond('isNull', { enabled: false })
        ],
        join('OR')
      ),
      cond('isNull')
    )
    expect(sql).toBe(
      "(`name` LIKE '%jorge%') AND ((`id` > '1') OR ((\nid < 10 -- nota\n))) OR (`name` IS NULL)"
    )
  })

  it('skips a disabled group whole, even with enabled children', () => {
    expect(where(cond('isNull'), group([cond('isNotNull')], { enabled: false }))).toBe(
      '(`name` IS NULL)'
    )
  })

  it('rejects bad connectors, malformed nodes, too deep or too many conditions', () => {
    expect(() => where(cond('isNull', { connector: 'XOR' as never }))).toThrow(/AND u OR/)
    expect(() => where('nope' as never)).toThrow(/no válido/)
    expect(() => buildFilterWhere({ kind: 'condition' } as never, COLUMNS)).toThrow(/no válido/)
    let deep: TableFilterNode = cond('isNull')
    for (let i = 0; i <= MAX_FILTER_DEPTH; i++) deep = group([deep])
    expect(() => where(deep)).toThrow(/niveles de paréntesis/)
    const many = Array.from({ length: MAX_FILTER_CONDITIONS + 1 }, () => cond('isNull'))
    expect(() => where(...many)).toThrow(/como máximo/)
  })

  it('knows when the column list is needed', () => {
    expect(filterNeedsColumns(null)).toBe(false)
    expect(filterNeedsColumns(group([cond('custom', { sql: '1' })]))).toBe(false)
    expect(filterNeedsColumns(group([cond('isNull', { enabled: false })]))).toBe(false)
    expect(filterNeedsColumns(group([group([cond('isNull')], { enabled: false })]))).toBe(false)
    expect(filterNeedsColumns(group([group([group([cond('isNull')])])]))).toBe(true)
  })
})
