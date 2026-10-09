import { describe, expect, it } from 'vitest'
import type { ConnectionConfig, JobTask } from './types'
import {
  ownPackageEntries,
  packageRestoreTasks,
  packageTargetName,
  restorePackageProblem,
  selectPackageEntries
} from './restorePackage'
import { buildCopyRestoreSteps, naturalStepName } from './jobRecipes'

const conn = (id: string, engine: ConnectionConfig['engine'], environment = 'local') =>
  ({ id, name: id, engine, environment }) as unknown as ConnectionConfig
const connections: Record<string, ConnectionConfig> = {
  staging: conn('staging', 'mysql', 'staging'),
  local: conn('local', 'mariadb'),
  pg: conn('pg', 'postgresql'),
  prod: conn('prod', 'mysql', 'production'),
  pre: conn('pre', 'mysql', 'staging')
}
const lookup = (id: string) => connections[id]

const backup = (id: string, schema: string, extra: Partial<JobTask> = {}): JobTask => ({
  id,
  type: 'backupschema',
  connectionId: 'staging',
  schema,
  referenceName: '',
  format: 'vqb',
  ...extra
})
const pkg = (extra: Partial<JobTask> = {}): JobTask => ({
  id: 'p',
  type: 'restorepackage',
  connectionId: 'local',
  schema: '',
  referenceName: '',
  packageSource: { kind: 'own' },
  ...extra
})

describe('restore package rules', () => {
  it('own package: restorable copies placed before the step, never .sql ones or later ones', () => {
    const tasks = [
      backup('b1', 'auth'),
      backup('b2', 'dump', { format: 'sql' }),
      backup('b3', 'logs', { includeData: false }),
      pkg(),
      backup('b4', 'later')
    ]
    expect(ownPackageEntries(tasks[3], tasks).map((e) => e.schema)).toEqual(['auth', 'logs'])
    // «Todas» with data leaves the structure-only copy out; «Solo estructura» keeps it.
    const all = selectPackageEntries(tasks[3], ownPackageEntries(tasks[3], tasks))
    expect(all.selected.map((e) => e.schema)).toEqual(['auth'])
    expect(all.skipped.map((e) => e.schema)).toEqual(['logs'])
    const bare = { ...tasks[3], includeData: false }
    expect(selectPackageEntries(bare, ownPackageEntries(bare, tasks)).selected).toHaveLength(2)
  })

  it('target names: own name, else name + suffix', () => {
    const t = pkg({ packageSuffix: '_dev', packageTargets: { auth: 'auth_qa' } })
    expect(packageTargetName(t, 'auth')).toBe('auth_qa')
    expect(packageTargetName(t, 'ventas')).toBe('ventas_dev')
    expect(packageTargetName(pkg(), 'ventas')).toBe('ventas')
  })

  it('problems: guarded targets, missing copies, engines, collisions and self restores', () => {
    const tasks = (p: JobTask) => [backup('b1', 'auth'), backup('b2', 'ventas'), p]
    const check = (p: JobTask, typed: ('staging' | 'production')[] = []) =>
      restorePackageProblem(p, tasks(p), lookup, 'paso 3', { typedEnvironments: typed })
    expect(check(pkg())).toBeNull()
    expect(check(pkg({ packageSource: undefined }))).toMatch(/necesita el paquete/)
    expect(check(pkg({ connectionId: 'prod' }))).toMatch(/producción/)
    expect(check(pkg({ connectionId: 'pre' }), ['production', 'staging'])).toMatch(
      /entorno Staging/
    )
    expect(check(pkg({ packageDatabases: ['crm'] }))).toMatch(/«crm», que no está/)
    expect(check(pkg({ connectionId: 'pg' }))).toMatch(/mismo motor/)
    expect(check(pkg({ connectionId: 'staging' }))).toMatch(/sobre sí misma/)
    expect(check(pkg({ connectionId: 'staging', packageSuffix: '_copia' }))).toBeNull()
    expect(check(pkg({ packageTargets: { auth: 'ventas' } }))).toMatch(
      /«auth» y «ventas» en la misma base de datos «ventas»/
    )
    expect(check(pkg({ packageSuffix: 'a/b' }))).toMatch(/sufijo/)
    expect(check(pkg({ packageTargets: { auth: 'sys' } }))).toMatch(/sistema de MySQL/)
    // Another job's package: only the explicit names are known before it runs.
    const other = pkg({ packageSource: { kind: 'job', jobId: 'j2' } })
    expect(
      restorePackageProblem(other, [other], lookup, 'paso 1', { jobExists: () => true })
    ).toBeNull()
    expect(restorePackageProblem(other, [other], lookup, 'paso 1', { jobId: 'j2' })).toMatch(
      /su propia tarea/
    )
  })

  it('becomes one ordinary restore per copy (own copies by step, other copies by file)', () => {
    const t = pkg({ safetyBackup: false, packageTargets: { auth: 'auth_dev' } })
    const restores = packageRestoreTasks(
      t,
      [
        { schema: 'auth', connectionId: 'staging', structureOnly: false, taskId: 'b1' },
        { schema: 'logs', connectionId: 'staging', structureOnly: true, path: '/x/logs.vqb' }
      ],
      (e, target) => `${e.schema} -> ${target}`
    )
    expect(restores).toEqual([
      {
        id: 'p#1',
        type: 'restoreschema',
        connectionId: 'local',
        schema: 'auth_dev',
        referenceName: 'auth -> auth_dev',
        restoreSource: { kind: 'task', taskId: 'b1' },
        safetyBackup: false,
        includeData: true
      },
      {
        id: 'p#2',
        type: 'restoreschema',
        connectionId: 'local',
        schema: 'logs',
        referenceName: 'logs -> logs',
        restoreSource: {
          kind: 'file',
          path: '/x/logs.vqb',
          schema: 'logs',
          connectionId: 'staging'
        },
        safetyBackup: false,
        includeData: false
      }
    ])
  })

  it('names and the «Copiar y restaurar» recipe as one package step', () => {
    const nameOf = (id: string) => connections[id]?.name ?? ''
    expect(naturalStepName(pkg(), [], nameOf)).toBe('Restaurar paquete de esta tarea en local')
    expect(
      naturalStepName(
        pkg({ packageSource: { kind: 'job', jobId: 'j', jobName: 'Copia nocturna' } }),
        [],
        nameOf
      )
    ).toBe('Restaurar paquete de «Copia nocturna» en local')
    let n = 0
    const steps = buildCopyRestoreSteps(
      {
        sourceConnectionId: 'staging',
        targetConnectionId: 'local',
        databases: [
          { name: 'auth', target: 'auth' },
          { name: 'ventas', target: 'ventas_dev' }
        ],
        safetyBackup: true,
        includeData: true,
        restoreAs: 'package'
      },
      nameOf,
      () => `s${++n}`
    )
    expect(steps.map((s) => s.type)).toEqual(['backupschema', 'backupschema', 'restorepackage'])
    expect(steps[2]).toMatchObject({
      connectionId: 'local',
      packageSource: { kind: 'own' },
      packageDatabases: ['auth', 'ventas'],
      packageTargets: { ventas: 'ventas_dev' },
      safetyBackup: true,
      includeData: true
    })
    expect(restorePackageProblem(steps[2], steps, lookup, 'paso 3')).toBeNull()
  })
})
