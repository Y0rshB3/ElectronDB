import { guardedRiskSignature, guardedWriteTargets, isObviousWrite } from '@shared/productionGuard'
import {
  environmentPhrase,
  normalizeTypedConfirmEnvironments,
  requiresTypedConfirm
} from '@shared/typedConfirm'
import type { ConnectionConfig, Environment, Job, JobInput, WriteOptions } from '@shared/types'
import type { AppContext } from '../context'
import { dialectForEngine } from '@shared/dialects'
import { isObviousMongoWrite } from '@shared/mongo/classify'
import { MysqlUserError } from '../mysql/errors'
import { splitStatements } from '../mysql/sqlSplit'

/**
 * Main-side enforcement of the CLAUDE.md rule: writes to a connection whose
 * environment needs the typed-name confirmation (always 'production', plus
 * the environments chosen in Ajustes › Seguridad) need explicit confirmation.
 * The renderer shows the dialog and then sends `confirmProduction: true` (the
 * IPC field keeps its historical name); these checks catch any caller that
 * skipped the dialog. Production is enforced even when the settings file was
 * edited by hand to leave it out.
 */

type GuardContext = Pick<AppContext, 'connections' | 'settings'>

const CODE = 'E_PRODUCTION_CONFIRM'

/** Environments that need the typed confirmation, from settings (always with production). */
export function typedConfirmEnvironments(ctx: Pick<AppContext, 'settings'>): Environment[] {
  return normalizeTypedConfirmEnvironments(ctx.settings.get().typedConfirmEnvironments)
}

/** True when writes to `connection` need the typed confirmation. */
export function needsTypedConfirm(
  ctx: Pick<AppContext, 'settings'>,
  connection: Pick<ConnectionConfig, 'environment'> | null | undefined
): boolean {
  return requiresTypedConfirm(connection?.environment, typedConfirmEnvironments(ctx))
}

/** Throws when `connectionId` needs the typed confirmation and the write was not confirmed. */
export function assertProductionWriteConfirmed(
  ctx: GuardContext,
  connectionId: string,
  options: WriteOptions | undefined,
  action: string
): void {
  if (options?.confirmProduction === true) return
  const connection = ctx.connections.get(connectionId)
  if (!connection || !needsTypedConfirm(ctx, connection)) return
  throw new MysqlUserError(
    `${action} en «${connection.name}» (${environmentPhrase(connection.environment)}) necesita confirmación explícita. Vuelve a intentarlo desde Vortaq y confirma la operación escribiendo el nombre de la conexión.`,
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
  if (options?.confirmProduction === true) return
  if (!scriptHasObviousWrite(ctx, connectionId, script)) return
  assertProductionWriteConfirmed(ctx, connectionId, options, 'Ejecutar SQL que modifica datos')
}

/**
 * Main's denylist per engine: MySQL keeps the v0.1.0 splitter and
 * isObviousWrite; other engines use their dialect's (section 10), MongoDB its
 * shell classifier (mongo:execute also re-checks the parsed pipelines).
 */
function scriptHasObviousWrite(ctx: GuardContext, connectionId: string, script: string): boolean {
  const engine = ctx.connections.get(connectionId)?.engine ?? 'mysql'
  if (engine === 'mysql') return splitStatements(script).some((s) => isObviousWrite(s.sql))
  if (engine === 'mongodb') return isObviousMongoWrite(script)
  const dialect = dialectForEngine(engine)
  if (!dialect) return false
  return dialect.splitStatements(script).some((s) => dialect.isObviousWrite(s.sql))
}

function guardedTargets(ctx: GuardContext, job: Pick<Job, 'tasks'>): ConnectionConfig[] {
  return guardedWriteTargets(
    job.tasks,
    (id) => ctx.connections.get(id),
    typedConfirmEnvironments(ctx)
  )
}

/** "«Prod» (producción), «Pre» (entorno Staging)" */
function describeTargets(targets: ConnectionConfig[]): string {
  return targets.map((c) => `«${c.name}» (${environmentPhrase(c.environment)})`).join(', ')
}

/** jobs:run: SQL tasks that target a guarded connection need confirmation. */
export function assertJobRunAllowed(
  ctx: GuardContext,
  job: Pick<Job, 'name' | 'tasks'>,
  options: WriteOptions | undefined
): void {
  if (options?.confirmProduction === true) return
  const targets = guardedTargets(ctx, job)
  if (!targets.length) return
  throw new MysqlUserError(
    `La tarea «${job.name}» ejecuta SQL sobre ${describeTargets(targets)} y necesita confirmación explícita. Ejecútala desde Vortaq y confirma la operación.`,
    CODE
  )
}

/**
 * jobs:save: scheduling SQL tasks against a guarded connection needs
 * confirmation, unless the stored job already had exactly the same risk
 * (confirmed before). Scheduled and launchd runs rely on this check.
 */
export function assertJobSaveAllowed(
  ctx: GuardContext,
  input: JobInput,
  existing: Job | null,
  options: WriteOptions | undefined
): void {
  if (options?.confirmProduction === true || !input.schedule?.enabled) return
  const lookup = (id: string) => ctx.connections.get(id)
  const environments = typedConfirmEnvironments(ctx)
  const risk = guardedRiskSignature(input.tasks, input.schedule, lookup, environments)
  if (!risk) return
  if (
    existing &&
    guardedRiskSignature(existing.tasks, existing.schedule, lookup, environments) === risk
  )
    return
  throw new MysqlUserError(
    `Programar «${input.name}» ejecutará SQL sobre ${describeTargets(guardedTargets(ctx, input))} sin supervisión y necesita confirmación explícita. Guarda la tarea desde Vortaq y confirma la operación.`,
    CODE
  )
}
