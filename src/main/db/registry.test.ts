import { describe, expect, it } from 'vitest'
import { mysqlDriver } from '../mysql/driver'
import { postgresDriver } from '../postgres/driver'
import { sqliteDriver } from '../sqlite/driver'
import { mongoDriver } from '../mongo/driver'
import { getDriver, hasDriver } from './registry'

describe('driver registry', () => {
  it('serves the MySQL driver for mysql connections', async () => {
    expect(hasDriver('mysql')).toBe(true)
    expect(await getDriver('mysql')).toBe(mysqlDriver)
  })

  it('serves the PostgreSQL driver (preview) for postgresql connections', async () => {
    expect(hasDriver('postgresql')).toBe(true)
    expect(await getDriver('postgresql')).toBe(postgresDriver)
  })

  it('serves the SQLite driver (preview) for sqlite connections', async () => {
    expect(hasDriver('sqlite')).toBe(true)
    expect(await getDriver('sqlite')).toBe(sqliteDriver)
  })

  it('serves the MongoDB driver (preview) for mongodb connections', async () => {
    expect(hasDriver('mongodb')).toBe(true)
    expect(await getDriver('mongodb')).toBe(mongoDriver)
  })

  it('serves the MySQL driver for mariadb connections (P5)', async () => {
    expect(hasDriver('mariadb')).toBe(true)
    expect(await getDriver('mariadb')).toBe(await getDriver('mysql'))
  })

  it('refuses an unknown engine', async () => {
    await expect(getDriver('oracle' as never)).rejects.toThrow(
      'Motor de base de datos desconocido: "oracle".'
    )
  })
})
