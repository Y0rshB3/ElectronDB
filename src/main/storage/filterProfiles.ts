import { join } from 'node:path'
import type { TableFilter, TableFilterProfile } from '@shared/types'
import { JsonStore } from './jsonStore'
import { nowIso } from './ids'

/**
 * Navicat-style filter profiles: named filter trees per connection + schema +
 * table, in userData/filter-profiles.json. Only the filter definition is
 * stored (columns, operators and the values typed in the filter), never rows.
 */
interface ProfilesDoc {
  version: number
  /** Key: connectionId \u0000 schema \u0000 table. */
  tables: Record<string, TableFilterProfile[]>
}

export const MAX_PROFILE_NAME = 80
/** Serialized size cap of one profile filter (a filter, not a data dump). */
export const MAX_PROFILE_BYTES = 256 * 1024

export class FilterProfileError extends Error {}

function key(connectionId: string, schema: string, table: string): string {
  for (const part of [connectionId, schema, table]) {
    if (typeof part !== 'string' || !part) throw new FilterProfileError('Falta la tabla del perfil')
  }
  return `${connectionId}\u0000${schema}\u0000${table}`
}

function checkName(name: unknown): string {
  const n = typeof name === 'string' ? name.trim() : ''
  if (!n) throw new FilterProfileError('Escribe un nombre para el perfil de filtro')
  if (n.length > MAX_PROFILE_NAME)
    throw new FilterProfileError(
      `El nombre del perfil admite como máximo ${MAX_PROFILE_NAME} caracteres`
    )
  return n
}

function checkFilter(filter: unknown): TableFilter {
  const f = filter as TableFilter | null
  if (!f || typeof f !== 'object' || f.kind !== 'group' || !Array.isArray(f.children))
    throw new FilterProfileError('El perfil no contiene un filtro válido')
  if (JSON.stringify(f).length > MAX_PROFILE_BYTES)
    throw new FilterProfileError('El filtro es demasiado grande para guardarlo como perfil')
  return f
}

export class FilterProfilesRepo {
  private store: JsonStore<ProfilesDoc>
  constructor(dir: string) {
    this.store = new JsonStore<ProfilesDoc>(join(dir, 'filter-profiles.json'), () => ({
      version: 1,
      tables: {}
    }))
  }

  list(connectionId: string, schema: string, table: string): TableFilterProfile[] {
    const items = this.store.get().tables[key(connectionId, schema, table)] ?? []
    return [...items].sort((a, b) => a.name.localeCompare(b.name, 'es'))
  }

  save(
    connectionId: string,
    schema: string,
    table: string,
    name: string,
    filter: TableFilter
  ): TableFilterProfile[] {
    const k = key(connectionId, schema, table)
    const profile: TableFilterProfile = {
      name: checkName(name),
      filter: checkFilter(filter),
      updatedAt: nowIso()
    }
    this.store.update((d) => {
      const items = (d.tables[k] ?? []).filter((p) => p.name !== profile.name)
      d.tables[k] = [...items, profile]
    })
    return this.list(connectionId, schema, table)
  }

  delete(connectionId: string, schema: string, table: string, name: string): TableFilterProfile[] {
    const k = key(connectionId, schema, table)
    this.store.update((d) => {
      const items = (d.tables[k] ?? []).filter((p) => p.name !== name)
      if (items.length) d.tables[k] = items
      else delete d.tables[k]
    })
    return this.list(connectionId, schema, table)
  }
}
