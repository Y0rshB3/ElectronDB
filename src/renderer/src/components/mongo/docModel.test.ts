import { describe, expect, it } from 'vitest'
import {
  changesFor,
  columnsOf,
  currentDoc,
  editCount,
  emptyEdit,
  insertTemplate,
  isChanged,
  parseRows,
  stageValue,
  withoutId,
  type StagedEdit
} from './docModel'

const DOC = JSON.stringify({
  _id: { $oid: '6ac6f781fc637c60b5590643' },
  name: 'Ana',
  age: { $numberInt: '30' },
  tags: ['a', 'b', 'c'],
  addr: { city: 'Lima', zip: { $numberInt: '15001' } },
  'a.b': 1
})

function setup() {
  const rows = parseRows([DOC], [true])
  const edit = emptyEdit()
  return { rows, row: rows[0], edit, edits: new Map<number, StagedEdit>([[0, edit]]) }
}

describe('docModel', () => {
  it('orders columns with _id first', () => {
    const rows = parseRows([DOC], [true])
    expect(columnsOf([{ path: 'name', count: 1, types: { string: 1 } }], rows)).toEqual([
      '_id',
      'name',
      'age',
      'tags',
      'addr',
      'a.b'
    ])
  })

  it('keeps the typed value and the original as the optimistic check', () => {
    const { row, edit, rows, edits } = setup()
    expect(stageValue(row, edit, ['age'], { $numberInt: '31' })).toBeNull()
    expect(stageValue(row, edit, ['addr', 'city'], 'Cusco')).toBeNull()
    expect(changesFor(rows, edits)).toEqual([
      {
        kind: 'update',
        id: '{"$oid":"6ac6f781fc637c60b5590643"}',
        set: { age: '{"$numberInt":"31"}', 'addr.city': '"Cusco"' },
        unset: [],
        expected: { age: '{"$numberInt":"30"}', 'addr.city': '"Lima"' }
      }
    ])
  })

  it('sets a whole array when an element is edited or removed', () => {
    const { row, edit, rows, edits } = setup()
    expect(stageValue(row, edit, ['tags', 1], undefined)).toBeNull()
    expect(currentDoc(row, edit).tags).toEqual(['a', 'c'])
    expect(stageValue(row, edit, ['tags', 0], 'z')).toBeNull()
    const [change] = changesFor(rows, edits)
    expect(change).toMatchObject({ set: { tags: '["z","c"]' }, unset: [] })
    expect(change).toMatchObject({ expected: { tags: '["a","b","c"]' } })
    expect(isChanged(edit, ['tags', 0])).toBe(true)
  })

  it('removes fields with $unset and refuses _id and unaddressable names', () => {
    const { row, edit, rows, edits } = setup()
    expect(stageValue(row, edit, ['name'], undefined)).toBeNull()
    expect(changesFor(rows, edits)[0]).toMatchObject({
      unset: ['name'],
      expected: { name: '"Ana"' }
    })
    expect(stageValue(row, edit, ['_id'], 'x')).toMatch(/_id/)
    expect(stageValue(row, edit, ['a.b'], 2)).toMatch(/documento completo/)
    expect(stageValue(row, edit, ['$weird'], 2)).toMatch(/documento completo/)
  })

  it('drops edits back to the loaded value', () => {
    const { row, edit, rows, edits } = setup()
    stageValue(row, edit, ['name'], 'Bea')
    stageValue(row, edit, ['name'], 'Ana')
    expect(editCount(edit, row)).toBe(0)
    expect(changesFor(rows, edits)).toEqual([])
  })

  it('stages deletes by _id', () => {
    const { rows, edit, edits } = setup()
    edit.deleted = true
    expect(changesFor(rows, edits)).toEqual([
      { kind: 'delete', id: '{"$oid":"6ac6f781fc637c60b5590643"}' }
    ])
  })

  it('builds insert templates and duplicates without _id', () => {
    expect(
      insertTemplate([
        { path: '_id', count: 1, types: { objectId: 1 } },
        { path: 'at', count: 1, types: { date: 1 } },
        { path: 'n', count: 2, types: { int: 2 } }
      ])
    ).toBe('{\n  at: new Date(),\n  n: NumberInt(0)\n}')
    const { row } = setup()
    expect(Object.keys(withoutId(row.original))).not.toContain('_id')
  })
})
