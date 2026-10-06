import {
  isObviousWrite,
  productionRiskSignature,
  productionWriteTargets
} from '@shared/productionGuard'
import type { Job, JobInput, WriteOptions } from '@shared/types'
import type { AppContext } from '../context'
import { MysqlUserError } from '../mysql/errors'
import { splitStatements } from '../mysql/sqlSplit'

/**
 * Main-side enforcement of the CLAUDE.md rule: writes to a connection whose
 * environment is 'production' need explicit confirmation. The renderer shows
 * the dialog and then sends `confirmProduction: true`; these checks catch any
 * caller that skipped the dialog.
 */

type GuardContext = Pick<AppContext, 'connections' | 'settings'>

const CODE = 'E_PRODUCTION_CONFIRM'

function guardEnabled(ctx: GuardContext): boolean {
  return ctx.settings.get().confirmProductionWrites !== false
}

/** Throws when `connectionId` is a production connection and the write was not confirmed. */
export function assertProductionWriteConfirmed(
  ctx: GuardContext,
  connectionId: string,
  options: WriteOptions | undefined,
  action: string
): void {
  if (options?.confirmProduction === true || !guardEnabled(ctx)) return
  const connection = ctx.connections.get(connectionId)
  if (connection?.environment !== 'production') return
  throw new MysqlUserError(
    `${action} en «${connection.name}» (producción) necesita confirmación explícita. Vuelve a intentarlo desde ElectronDB y confirma la operación.`,
    CODE
  )
}

/** Like assertProductionWriteConfirmed, only for scripts with an obvious write statement. */
export function assertScriptAllowed(
  ctx: GuardContext,
  connectionId: string,
  script: string,
  options: WriteOptions | undefined
): void {
  if (options?.confirmProduction === true || !guardEnabled(ctx)) return
  if (!splitStatements(script).some((s) => isObviousWrite(s.sql))) return
  assertProductionWriteConfirmed(ctx, connectionId, options, 'Ejecutar SQL que modifica datos')
}

function productionNames(ctx: GuardContext, job: Pick<Job, 'tasks'>): string {
  return productionWriteTargets(job.tasks, (id) => ctx.connections.get(id))
    .map((c) => `«${c.name}»`)
    .join(', ')
}

/** jobs:run: SQL tasks that target production need confirmation. */
export function assertJobRunAllowed(
  ctx: GuardContext,
  job: Pick<Job, 'name' | 'tasks'>,
  options: WriteOptions | undefined
): void {
  if (options?.confirmProduction === true || !guardEnabled(ctx)) return
  const names = productionNames(ctx, job)
  if (!names) return
  throw new MysqlUserError(
    `La tarea «${job.name}» ejecuta SQL sobre ${names} (producción) y necesita confirmación explícita. Ejecútala desde ElectronDB y confirma la operación.`,
    CODE
  )
}

/**
 * jobs:save: scheduling SQL tasks against production needs confirmation,
 * unless the stored job already had exactly the same risk (confirmed before).
 * Scheduled and launchd runs rely on this check.
 */
export function assertJobSaveAllowed(
  ctx: GuardContext,
  input: JobInput,
  existing: Job | null,
  options: WriteOptions | undefined
): void {
  if (options?.confirmProduction === true || !guardEnabled(ctx) || !input.schedule?.enabled) return
  const lookup = (id: string) => ctx.connections.get(id)
  const risk = productionRiskSignature(input.tasks, input.schedule, lookup)
  if (!risk) return
  if (existing && productionRiskSignature(existing.tasks, existing.schedule, lookup) === risk)
    return
  throw new MysqlUserError(
    `Programar «${input.name}» ejecutará SQL sobre ${productionNames(ctx, input)} (producción) sin supervisión y necesita confirmación explícita. Guarda la tarea desde ElectronDB y confirma la operación.`,
    CODE
  )
}
