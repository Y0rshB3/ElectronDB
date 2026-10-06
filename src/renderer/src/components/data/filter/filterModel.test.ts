import { describe, expect, it } from 'vitest'
import {
  FILTER_OPERATORS,
  activeConditions,
  conditionProblem,
  filterLines,
  filterProblem,
  fromTableFilter,
  insertCondition,
  insertGroup,
  newCondition,
  newGroup,
  removeNode,
  restoreFilterState,
  emptyFilterState,
  splitList,
  toTableFilter,
  unwrapGroup,
  wrapInGroup,
  type FilterConditionState
} from './filterModel'

function cond(column: string, extra: Partial<FilterConditionState> = {}): FilterConditionState {
  return { ...newCondition(column), operator: 'isNull', ...extra }
}

describe('filterModel', () => {
  it('lists every Navicat operator with its Spanish label', () => {
    expect(FILTER_OPERATORS.map((o) => o.label)).toEqual([
      '=',
      '!=',
      '<',
      '<=',
      '>',
      '>=',
      'contiene',
      'no contiene',
      'empieza por',
      'no empieza por',
      'termina en',
      'no termina en',
      'es nulo',
      'no es nulo',
      'está vacío',
      'no está vacío',
      'está en la lista',
      'no está en la lista',
      'entre',
      'no entre',
      '[Personalizado]'
    ])
  })

  it('splits pasted lists on commas and new lines', () => {
    expect(splitList(' a, b ,,c\nd ')).toEqual(['a', 'b', 'c', 'd'])
  })

  it('reports incomplete conditions by operator', () => {
    expect(conditionProblem(cond('id', { operator: 'eq' }))).toBe('Falta el valor')
    expect(conditionProblem(cond('id'))).toBeNull()
    expect(conditionProblem(cond(''))).toBe('Elige una columna')
    expect(conditionProblem(cond('id', { operator: 'between', values: ['1'] }))).toBe(
      'Faltan los dos valores'
    )
    expect(conditionProblem(cond('id', { operator: 'in', values: [''] }))).toBe(
      'Añade al menos un valor'
    )
    expect(conditionProblem(cond('', { operator: 'custom', sql: 'x > 1' }))).toBeNull()
  })

  it('inserts after a condition, inside a bracket, or at the end', () => {
    const a = cond('a')
    const root = newGroup([a])
    const b = insertCondition(root, a.id, 'b')
    const g = insertGroup(root, null, 'c')
    const inside = insertCondition(root, g.id, 'd')
    expect(root.children.map((n) => n.id)).toEqual([a.id, b.id, g.id])
    expect(g.children.map((n) => (n as FilterConditionState).column)).toEqual(['c', 'd'])
    expect(g.children[1].id).toBe(inside.id)
  })

  it('wraps, unwraps and removes keeping the connectors readable', () => {
    const a = cond('a', { connector: 'OR' })
    const b = cond('b')
    const root = newGroup([a, b])
    const g = wrapInGroup(root, a.id)!
    expect(g.connector).toBe('OR')
    expect(a.connector).toBe('AND')
    expect(filterLines(root).map((l) => `${l.type}:${l.depth}`)).toEqual([
      'open:0',
      'condition:1',
      'close:0',
      'condition:0'
    ])
    expect(unwrapGroup(root, g.id)).toBe(true)
    expect(root.children).toEqual([a, b])
    expect(a.connector).toBe('OR')
    expect(removeNode(root, b.id)).toBe(true)
    expect(root.children).toEqual([a])
  })

  it('counts only conditions inside enabled brackets and finds the first problem', () => {
    const bad = cond('x', { operator: 'eq' })
    const off = newGroup([cond('y', { operator: 'eq' })])
    off.enabled = false
    const root = newGroup([cond('a'), cond('b', { enabled: false }), off, newGroup([bad])])
    expect(activeConditions(root).map((c) => c.column)).toEqual(['a', 'x'])
    expect(filterProblem(root)).toEqual({ id: bad.id, message: 'Falta el valor' })
  })

  it('serialises only the fields each operator uses, and loads them back', () => {
    const root = newGroup([
      cond('id', { operator: 'between', values: ['1', '5', 'x'], connector: 'OR' }),
      cond('id', { operator: 'custom', sql: 'id % 2 = 0' }),
      newGroup([cond('name', { operator: 'isEmpty', values: ['ignored'] })])
    ])
    const filter = toTableFilter(root)
    expect(filter).toEqual({
      kind: 'group',
      enabled: true,
      connector: 'AND',
      children: [
        {
          kind: 'condition',
          enabled: true,
          column: 'id',
          operator: 'between',
          values: ['1', '5'],
          connector: 'OR'
        },
        {
          kind: 'condition',
          enabled: true,
          column: '',
          operator: 'custom',
          values: [],
          connector: 'AND',
          sql: 'id % 2 = 0'
        },
        {
          kind: 'group',
          enabled: true,
          connector: 'AND',
          children: [
            {
              kind: 'condition',
              enabled: true,
              column: 'name',
              operator: 'isEmpty',
              values: [],
              connector: 'AND'
            }
          ]
        }
      ]
    })
    expect(toTableFilter(fromTableFilter(filter))).toEqual(filter)
  })

  it('restores a persisted state or falls back to an empty one', () => {
    expect(restoreFilterState(undefined).root.children).toEqual([])
    expect(restoreFilterState({ root: 'nope' }).mode).toBe('builder')
    const restored = restoreFilterState({
      ...emptyFilterState(),
      mode: 'text',
      text: 'id > 1',
      profile: 'P'
    })
    expect(restored).toMatchObject({ mode: 'text', text: 'id > 1', profile: 'P' })
  })
})
