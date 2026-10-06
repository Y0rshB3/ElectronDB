import type { AppSettings, ConnectionConfig, Job, JobInput, JobTask } from '@shared/types'
import { describe, expect, it } from 'vitest'
import {
  assertJobRunAllowed,
  assertJobSaveAllowed,
  assertProductionWriteConfirmed,
  assertScriptAllowed
} from './productionGuard'

function connection(id: string, environment: ConnectionConfig['environment']): ConnectionConfig {
  return { id, name: `conn-${id}`, environment } as ConnectionConfig
}

function makeCtx(confirmProductionWrites = true) {
  const items = [connection('prod', 'production'), connection('dev', 'local')]
  return {
    connections: { get: (id: string) => items.find((c) => c.id === id) ?? null },
    settings: { get: () => ({ confirmProductionWrites }) as AppSettings }
  } as unknown as Parameters<typeof assertProductionWriteConfirmed>[0]
}

const sqlTask = (connectionId: string, sql = 'DELETE FROM t'): JobTask => ({
  id: `t-${connectionId}`,
  type: 'runquery',
  connectionId,
  schema: 'app',
  referenceName: 'paso',
  sql
})

const backupTask = (connectionId: string): JobTask => ({
  id: `b-${connectionId}`,
  type: 'backupschema',
  connectionId,
  schema: 'app',
  referenceName: 'backup'
})

function jobInput(tasks: JobTask[], enabled = true): JobInput {
  return {
    name: 'Nocturna',
    continueOnError: false,
    tasks,
    schedule: { enabled, cron: '0 3 * * *', launchAgent: false }
  }
}

describe('assertProductionWriteConfirmed', () => {
  it('rejects unconfirmed writes on production with an actionable message', () => {
    expect(() =>
      assertProductionWriteConfirmed(makeCtx(), 'prod', undefined, 'Eliminar t')
    ).toThrow(/Eliminar t en «conn-prod» \(producción\) necesita confirmación explícita/)
  })

  it('allows confirmed writes, other environments and a disabled setting', () => {
    const ctx = makeCtx()
    expect(() =>
      assertProductionWriteConfirmed(ctx, 'prod', { confirmProduction: true }, 'x')
    ).not.toThrow()
    expect(() => assertProductionWriteConfirmed(ctx, 'dev', undefined, 'x')).not.toThrow()
    expect(() => assertProductionWriteConfirmed(ctx, 'missing', undefined, 'x')).not.toThrow()
    expect(() =>
      assertProductionWriteConfirmed(makeCtx(false), 'prod', undefined, 'x')
    ).not.toThrow()
  })
})

describe('assertScriptAllowed', () => {
  it('lets read-only scripts through on production', () => {
    const ctx = makeCtx()
    expect(() => assertScriptAllowed(ctx, 'prod', 'SELECT 1; SHOW TABLES', undefined)).not.toThrow()
    expect(() =>
      assertScriptAllowed(ctx, 'prod', "-- note\nSELECT 'DELETE FROM t'", undefined)
    ).not.toThrow()
  })

  it('rejects scripts with an obvious write unless confirmed', () => {
    const ctx = makeCtx()
    expect(() =>
      assertScriptAllowed(ctx, 'prod', 'SELECT 1;\n/* x */ DELETE FROM t', undefined)
    ).toThrow()
    expect(() => assertScriptAllowed(ctx, 'prod', 'TRUNCATE TABLE t', {})).toThrow()
    expect(() =>
      assertScriptAllowed(ctx, 'prod', 'TRUNCATE TABLE t', { confirmProduction: true })
    ).not.toThrow()
    expect(() => assertScriptAllowed(ctx, 'dev', 'DROP TABLE t', undefined)).not.toThrow()
  })
})

describe('assertJobRunAllowed', () => {
  it('needs confirmation only for SQL tasks on production', () => {
    const ctx = makeCtx()
    expect(() =>
      assertJobRunAllowed(ctx, { name: 'j', tasks: [backupTask('prod')] }, undefined)
    ).not.toThrow()
    expect(() =>
      assertJobRunAllowed(ctx, { name: 'j', tasks: [sqlTask('dev')] }, undefined)
    ).not.toThrow()
    expect(() =>
      assertJobRunAllowed(ctx, { name: 'j', tasks: [sqlTask('prod')] }, undefined)
    ).toThrow(/«conn-prod» \(producción\)/)
    expect(() =>
      assertJobRunAllowed(ctx, { name: 'j', tasks: [sqlTask('prod')] }, { confirmProduction: true })
    ).not.toThrow()
  })
})

describe('assertJobSaveAllowed', () => {
  const ctx = makeCtx()

  it('needs confirmation to schedule SQL on production', () => {
    expect(() => assertJobSaveAllowed(ctx, jobInput([sqlTask('prod')]), null, undefined)).toThrow(
      /Programar «Nocturna»/
    )
    expect(() =>
      assertJobSaveAllowed(ctx, jobInput([sqlTask('prod')]), null, { confirmProduction: true })
    ).not.toThrow()
  })

  it('does not ask for unscheduled jobs or jobs without production SQL', () => {
    expect(() =>
      assertJobSaveAllowed(ctx, jobInput([sqlTask('prod')], false), null, undefined)
    ).not.toThrow()
    expect(() =>
      assertJobSaveAllowed(ctx, jobInput([backupTask('prod')]), null, undefined)
    ).not.toThrow()
  })

  it('does not ask again when the stored job already had the same risk', () => {
    const input = jobInput([sqlTask('prod')])
    const stored = { ...input, id: 'j1' } as Job
    expect(() =>
      assertJobSaveAllowed(ctx, { ...input, name: 'Otro nombre' }, stored, undefined)
    ).not.toThrow()
    const changed = jobInput([sqlTask('prod', 'DELETE FROM otra')])
    expect(() => assertJobSaveAllowed(ctx, changed, stored, undefined)).toThrow()
  })
})
