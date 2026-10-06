import { describe, expect, it } from 'vitest'
import {
  isSystemSchema,
  restoreSourceOf,
  restoreTargetSchema,
  restoreTaskProblem,
  restoreProductionRefusal
} from './restoreTask'
import type { ConnectionConfig, JobTask } from './types'

const conn = (id: string, environment: ConnectionConfig['environment']): ConnectionConfig =>
  ({ id, name: id === 'prod' ? 'Producción' : id, environment }) as ConnectionConfig
const connections: Record<string, ConnectionConfig> = {
  staging: conn('staging', 'staging'),
  local: conn('local', 'local'),
  prod: conn('prod', 'production')
}
const lookup = (id: string) => connections[id]

const backup: JobTask = {
  id: 'b1',
  type: 'backupschema',
  connectionId: 'staging',
  schema: 'auth',
  referenceName: 'Backup auth'
}
const restore = (overrides: Partial<JobTask> = {}): JobTask => ({
  id: 'r1',
  type: 'restoreschema',
  connectionId: 'local',
  schema: '',
  referenceName: 'Restaurar auth',
  restoreSource: { kind: 'task', taskId: 'b1' },
  safetyBackup: true,
  ...overrides
})

describe('restore task rules', () => {
  it('accepts «backup on staging, then restore it into local» and defaults the target name', () => {
    const r = restore()
    expect(restoreTaskProblem(r, [backup, r], lookup, 'paso 2')).toBeNull()
    expect(restoreSourceOf(r, [backup, r])).toEqual({ connectionId: 'staging', schema: 'auth' })
    expect(restoreTargetSchema(r, [backup, r])).toBe('auth')
    expect(restoreTargetSchema(restore({ schema: 'auth_copy' }), [backup])).toBe('auth_copy')
  })

  it('refuses a production target with a clear Spanish message (saved jobs run unattended)', () => {
    const r = restore({ connectionId: 'prod' })
    const problem = restoreTaskProblem(r, [backup, r], lookup, 'paso 2')
    expect(problem).toBe(restoreProductionRefusal('Restaurar auth', 'Producción'))
    expect(problem).toMatch(/producción/)
    expect(problem).toMatch(/«Restaurar todo»/)
    // A confirmed rollback from the history may write to production.
    expect(restoreTaskProblem(r, [backup, r], lookup, 'paso 2', { rollback: true })).toBeNull()
  })

  it('refuses restoring a database onto itself (same connection and schema)', () => {
    const r = restore({ connectionId: 'staging' })
    expect(restoreTaskProblem(r, [backup, r], lookup, 'paso 2')).toMatch(/sobre sí misma/)
    // Same connection into another database is fine.
    const copy = restore({ connectionId: 'staging', schema: 'auth_copy' })
    expect(restoreTaskProblem(copy, [backup, copy], lookup, 'paso 2')).toBeNull()
    const latest = restore({
      connectionId: 'local',
      restoreSource: { kind: 'latest', connectionId: 'local', schema: 'auth' }
    })
    expect(restoreTaskProblem(latest, [latest], lookup, 'paso 1')).toMatch(/sobre sí misma/)
  })

  it('requires an earlier backup step as task source', () => {
    const before = restore()
    expect(restoreTaskProblem(before, [before, backup], lookup, 'paso 1')).toMatch(
      /debe ir después/
    )
    const query: JobTask = { ...backup, id: 'q1', type: 'runquery', sql: 'SELECT 1' }
    const fromQuery = restore({ restoreSource: { kind: 'task', taskId: 'q1' } })
    expect(restoreTaskProblem(fromQuery, [query, fromQuery], lookup, 'paso 2')).toMatch(
      /Copia de seguridad/
    )
    const missing = restore({ restoreSource: { kind: 'task', taskId: 'nope' } })
    expect(restoreTaskProblem(missing, [missing], lookup, 'paso 1')).toMatch(/no existe/)
  })

  it('validates «latest backup on disk» and never accepts explicit files in saved jobs', () => {
    const latest = restore({
      restoreSource: { kind: 'latest', connectionId: 'staging', schema: '' }
    })
    expect(restoreTaskProblem(latest, [latest], lookup, 'paso 1')).toMatch(/esquema de origen/)
    const ok = restore({
      restoreSource: { kind: 'latest', connectionId: 'staging', schema: 'auth' }
    })
    expect(restoreTaskProblem(ok, [ok], lookup, 'paso 1')).toBeNull()
    const file = restore({
      restoreSource: { kind: 'file', path: '/b/auth.nb3', schema: 'auth', connectionId: null }
    })
    expect(restoreTaskProblem(file, [file], lookup, 'paso 1')).toMatch(/archivo concreto/)
    expect(restoreTaskProblem(file, [file], lookup, 'paso 1', { rollback: true })).toBeNull()
    expect(restoreTaskProblem(restore({ restoreSource: undefined }), [], lookup, 'paso 1')).toMatch(
      /copia de origen/
    )
  })

  it('refuses system databases as targets, also for «Restaurar todo» (rollback)', () => {
    for (const schema of ['mysql', 'sys', 'performance_schema', 'information_schema', 'SYS']) {
      const r = restore({ schema })
      expect(restoreTaskProblem(r, [backup, r], lookup, 'paso 2')).toMatch(
        /base de datos del sistema de MySQL/
      )
      expect(restoreTaskProblem(r, [backup, r], lookup, 'paso 2', { rollback: true })).toMatch(
        /base de datos del sistema/
      )
    }
    // Defaulted to the source name: backing up `mysql` and restoring it is refused too.
    const sys = { ...backup, schema: 'mysql' }
    const r = restore()
    expect(restoreTaskProblem(r, [sys, r], lookup, 'paso 2')).toMatch(
      /«mysql» es una base de datos del sistema/
    )
    expect(isSystemSchema(' Performance_Schema ')).toBe(true)
    expect(isSystemSchema('mysql_app')).toBe(false)
  })

  it('refuses restoring a structure-only backup step (the tables would end up empty)', () => {
    const struct = { ...backup, includeData: false }
    const r = restore()
    expect(restoreTaskProblem(r, [struct, r], lookup, 'paso 2')).toMatch(/solo de estructura/)
  })
})
