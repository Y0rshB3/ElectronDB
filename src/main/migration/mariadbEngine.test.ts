import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ConnectionInput } from '@shared/types'
import { ConnectionsRepo } from '../storage/repos'
import { isImportedMariaDb, migrateImportedMariaDb, servesMariaDb } from './mariadbEngine'

const input = (name: string, extra: Partial<ConnectionInput> = {}): ConnectionInput => ({
  name,
  color: null,
  environment: 'local',
  host: 'h',
  port: 3306,
  username: 'root',
  savePassword: false,
  customDatabases: [],
  initialQueries: '',
  ssh: {
    enabled: false,
    host: '',
    port: 22,
    username: '',
    authType: 'password',
    savePassword: false
  },
  ssl: { enabled: false, verifyServer: false },
  backupDir: '/b',
  extraBackupDirs: [],
  ...extra
})

describe('MariaDB engine migration (P5)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vortaq-maria-mig-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('recognises imported MariaDB records and MariaDB servers', () => {
    const source = { app: 'navicat' as const, name: 'x', importedAt: '' }
    expect(
      isImportedMariaDb({ engine: 'mysql', source: { ...source, navicatType: 'MariaDB' } })
    ).toBe(true)
    expect(
      isImportedMariaDb({ engine: 'mysql', source: { ...source, navicatType: 'MySQL' } })
    ).toBe(false)
    expect(isImportedMariaDb({ engine: 'mysql', source })).toBe(false)
    expect(
      isImportedMariaDb({ engine: 'mariadb', source: { ...source, navicatType: 'MariaDB' } })
    ).toBe(false)
    expect(servesMariaDb({ engine: 'mysql' }, '11.8.9-MariaDB-ubu2404')).toBe(true)
    expect(servesMariaDb({ engine: 'mysql' }, '5.5.5-10.11.6-MariaDB')).toBe(true)
    expect(servesMariaDb({ engine: 'mysql' }, '8.4.7')).toBe(false)
    expect(servesMariaDb({ engine: 'mariadb' }, '11.8.9-MariaDB')).toBe(false)
  })

  it('promotes only imported MariaDB entries, once, keeping every other field', () => {
    const repo = new ConnectionsRepo(dir)
    const importedAt = '2026-01-01T00:00:00.000Z'
    const maria = repo.save(
      input('Maria', {
        engine: 'mysql',
        environment: 'production',
        source: { app: 'navicat', name: 'Maria', importedAt, navicatType: 'MariaDB', format: 'ncx' }
      })
    )
    const mysql = repo.save(
      input('MySQL', { engine: 'mysql', source: { app: 'navicat', name: 'MySQL', importedAt } })
    )
    const pg = repo.save(input('PG', { engine: 'postgresql' }))

    expect(migrateImportedMariaDb(repo)).toBe(1)
    const after = repo.get(maria.id)!
    expect(after.engine).toBe('mariadb')
    expect({ ...after, engine: 'mysql', updatedAt: '' }).toEqual({ ...maria, updatedAt: '' })
    expect(repo.get(mysql.id)?.engine).toBe('mysql')
    expect(repo.get(pg.id)?.engine).toBe('postgresql')

    // Idempotent: a second start changes nothing, also after re-reading the file.
    expect(migrateImportedMariaDb(repo)).toBe(0)
    expect(migrateImportedMariaDb(new ConnectionsRepo(dir))).toBe(0)
    expect(new ConnectionsRepo(dir).get(maria.id)?.engine).toBe('mariadb')
  })
})
