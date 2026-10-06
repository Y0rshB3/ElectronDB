import { describe, expect, it } from 'vitest'
import type { ConnectionConfig, JobInput, JobTask } from '@shared/types'
import { assertRestoreStepsAllowed, validateJobInput } from './jobValidation'

const connections: Record<string, ConnectionConfig> = {
  staging: { id: 'staging', name: 'Staging', environment: 'staging' } as ConnectionConfig,
  local: { id: 'local', name: 'Local', environment: 'local' } as ConnectionConfig,
  prod: { id: 'prod', name: 'Producción', environment: 'production' } as ConnectionConfig
}
const lookup = (id: string) => connections[id]

const backup: JobTask = {
  id: 'b1',
  type: 'backupschema',
  connectionId: 'staging',
  schema: 'auth',
  referenceName: 'Backup auth'
}
const restore = (connectionId: string): JobTask => ({
  id: 'r1',
  type: 'restoreschema',
  connectionId,
  schema: '',
  referenceName: 'Restaurar auth',
  restoreSource: { kind: 'task', taskId: 'b1' },
  safetyBackup: true
})
const job = (tasks: JobTask[], enabled = true): JobInput => ({
  name: 'Staging -> Local',
  continueOnError: false,
  tasks,
  schedule: { enabled, cron: '0 3 * * *', launchAgent: false }
})

describe('validateJobInput (jobs:save)', () => {
  it('accepts a «Staging -> Local» job with a restore step', () => {
    expect(() => validateJobInput(job([backup, restore('local')]), lookup)).not.toThrow()
  })

  it('refuses a restore step into production, scheduled or not', () => {
    for (const enabled of [true, false])
      expect(() => validateJobInput(job([backup, restore('prod')], enabled), lookup)).toThrow(
        /restaura sobre «Producción», una conexión de producción/
      )
  })

  it('refuses at save a restore step whose target is a system database (mysql, sys, performance_schema)', () => {
    for (const schema of ['mysql', 'sys', 'performance_schema'])
      expect(() =>
        validateJobInput(job([backup, { ...restore('local'), schema }]), lookup)
      ).toThrow(/base de datos del sistema/)
  })

  it('refuses restoring onto the source database and unknown task types', () => {
    expect(() => validateJobInput(job([backup, restore('staging')]), lookup)).toThrow(
      /sobre sí misma/
    )
    const bad = { ...backup, type: 'dropeverything' } as unknown as JobTask
    expect(() => validateJobInput(job([bad]), lookup)).toThrow(/tipo desconocido/)
  })

  it('assertRestoreStepsAllowed re-checks restore steps of a stored job at run time', () => {
    expect(() => assertRestoreStepsAllowed(job([backup, restore('local')]), lookup)).not.toThrow()
    expect(() => assertRestoreStepsAllowed(job([backup, restore('prod')]), lookup)).toThrow(
      /producción/
    )
  })
})
