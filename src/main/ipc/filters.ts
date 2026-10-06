import type { AppContext } from '../context'
import { FilterProfilesRepo } from '../storage/filterProfiles'
import { handle } from './typed'

/** Filter profiles of the table data filter builder (Navicat "Guardar perfil"). */
export function registerFiltersHandlers(ctx: AppContext): void {
  const repo = new FilterProfilesRepo(ctx.userDataPath)
  handle('filters:list', (connectionId, schema, table) => repo.list(connectionId, schema, table))
  handle('filters:save', (connectionId, schema, table, name, filter) =>
    repo.save(connectionId, schema, table, name, filter)
  )
  handle('filters:delete', (connectionId, schema, table, name) =>
    repo.delete(connectionId, schema, table, name)
  )
}
