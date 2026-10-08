import { describe, expect, it } from 'vitest'
import type { ConnectionConfig, JobTask } from './types'
import {
  backupFamilyOf,
  jobBackupFormats,
  jobStepEngineProblem,
  systemDatabaseRefusal
} from './jobEngines'

const conns: ConnectionConfig[] = [
  { id: 'my', name: 'MySQL', engine: 'mysql' } as ConnectionConfig,
  { id: 'maria', name: 'Maria', engine: 'mariadb' } as ConnectionConfig,
  { id: 'mongo', name: 'Mongo', engine: 'mongodb' } as ConnectionConfig
]
const lookup = (id: string) => conns.find((c) => c.id === id)
const restore = (source: JobTask['restoreSource'], connectionId = 'my'): JobTask => ({
  id: 'r',
  type: 'restoreschema',
  connectionId,
  schema: 'x',
  referenceName: 'R',
  restoreSource: source
})

describe('job rules per engine', () => {
  it('groups MySQL and MariaDB and limits the other engines to .vqb', () => {
    expect(backupFamilyOf('mariadb')).toBe('mysql')
    expect(backupFamilyOf(undefined)).toBe('mysql')
    expect(jobBackupFormats({ engine: 'mariadb' })).toEqual(['vqb', 'nb3', 'sql'])
    expect(jobBackupFormats({ engine: 'sqlite' })).toEqual(['vqb'])
    expect(systemDatabaseRefusal('mongodb', 'local')).toMatch(/del sistema de MongoDB/)
    expect(systemDatabaseRefusal('mongodb', 'tienda')).toBeNull()
  })

  it('refuses a cross-engine latest-copy restore, but trusts a «Restaurar todo» file', () => {
    expect(
      jobStepEngineProblem(
        restore({ kind: 'latest', connectionId: 'mongo', schema: 'x' }),
        [],
        lookup,
        'paso 1'
      )
    ).toMatch(/una copia solo se restaura en una conexión del mismo motor/)
    expect(
      jobStepEngineProblem(
        restore({ kind: 'latest', connectionId: 'maria', schema: 'x' }),
        [],
        lookup,
        'paso 1'
      )
    ).toBeNull()
    // The plan already checked the file's own manifest; the folder owner may be another engine.
    expect(
      jobStepEngineProblem(
        restore({ kind: 'file', path: '/b/x.vqb', schema: 'x', connectionId: 'mongo' }),
        [],
        lookup,
        'paso 1'
      )
    ).toBeNull()
  })
})
