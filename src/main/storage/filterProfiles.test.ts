import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TableFilter } from '@shared/types'
import { FilterProfilesRepo } from './filterProfiles'

const filter: TableFilter = {
  kind: 'group',
  enabled: true,
  connector: 'AND',
  children: [
    {
      kind: 'condition',
      enabled: true,
      column: 'id',
      operator: 'isNull',
      values: [],
      connector: 'AND'
    }
  ]
}

describe('FilterProfilesRepo', () => {
  let dir: string
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'vortaq-fp-'))))
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('keeps profiles per connection, schema and table, sorted and replaced by name', () => {
    const repo = new FilterProfilesRepo(dir)
    repo.save('c1', 'shop', 'items', 'Pendientes', filter)
    repo.save('c1', 'shop', 'items', 'Activos', filter)
    repo.save('c1', 'shop', 'items', ' Pendientes ', { ...filter, enabled: false })
    repo.save('c1', 'shop', 'orders', 'Otro', filter)
    expect(repo.list('c1', 'shop', 'items').map((p) => [p.name, p.filter.enabled])).toEqual([
      ['Activos', true],
      ['Pendientes', false]
    ])
    expect(repo.list('c2', 'shop', 'items')).toEqual([])
    // Persisted across instances.
    expect(new FilterProfilesRepo(dir).list('c1', 'shop', 'orders')).toHaveLength(1)
    expect(readFileSync(join(dir, 'filter-profiles.json'), 'utf8')).toContain('Pendientes')

    expect(repo.delete('c1', 'shop', 'items', 'Activos').map((p) => p.name)).toEqual(['Pendientes'])
    repo.delete('c1', 'shop', 'items', 'Pendientes')
    expect(repo.list('c1', 'shop', 'items')).toEqual([])
  })

  it('rejects empty names and things that are not a filter', () => {
    const repo = new FilterProfilesRepo(dir)
    expect(() => repo.save('c1', 's', 't', '  ', filter)).toThrow(/nombre/)
    expect(() => repo.save('c1', 's', 't', 'x', { rows: [] } as never)).toThrow(/filtro válido/)
    expect(() => repo.save('', 's', 't', 'x', filter)).toThrow(/tabla/)
  })
})
