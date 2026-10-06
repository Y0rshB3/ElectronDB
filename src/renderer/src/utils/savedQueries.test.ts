import { afterEach, describe, expect, it } from 'vitest'
import { readSavedQueries, writeSavedQueries, type SavedQuery } from './savedQueries'

const query: SavedQuery = {
  id: 'q1',
  name: 'Pedidos',
  sql: 'SELECT 1',
  schema: 'shop',
  updatedAt: '2026-10-01T00:00:00.000Z'
}

describe('savedQueries', () => {
  afterEach(() => localStorage.clear())

  it('round-trips under the electrondb.queries. key', () => {
    writeSavedQueries('c1', [query])
    expect(localStorage.getItem('electrondb.queries.c1')).not.toBeNull()
    expect(readSavedQueries('c1')).toEqual([query])
  })

  it('adopts queries saved before the rename and moves them to the new key', () => {
    localStorage.setItem('navidog.queries.c2', JSON.stringify([query]))
    expect(readSavedQueries('c2')).toEqual([query])
    expect(localStorage.getItem('navidog.queries.c2')).toBeNull()
    expect(JSON.parse(localStorage.getItem('electrondb.queries.c2') ?? '[]')).toEqual([query])
  })

  it('prefers the current key over a leftover legacy one', () => {
    writeSavedQueries('c3', [query])
    localStorage.setItem('navidog.queries.c3', JSON.stringify([]))
    expect(readSavedQueries('c3')).toEqual([query])
  })
})
