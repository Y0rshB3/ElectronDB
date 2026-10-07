import { describe, expect, it } from 'vitest'
import { mysqlDriver } from '../mysql/driver'
import { DbUserError } from './errors'
import { getDriver, hasDriver } from './registry'

describe('driver registry', () => {
  it('serves the MySQL driver for mysql connections', async () => {
    expect(hasDriver('mysql')).toBe(true)
    expect(await getDriver('mysql')).toBe(mysqlDriver)
  })

  it('refuses every engine without a driver in this build', async () => {
    const labels = {
      mariadb: 'MariaDB',
      postgresql: 'PostgreSQL',
      sqlite: 'SQLite',
      mongodb: 'MongoDB'
    } as const
    for (const [engine, label] of Object.entries(labels) as [keyof typeof labels, string][]) {
      expect(hasDriver(engine)).toBe(false)
      const err = await getDriver(engine).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(DbUserError)
      expect((err as Error).message).toBe(
        `${label} todavía no está disponible en esta versión de Vortaq.`
      )
    }
  })

  it('refuses an unknown engine', async () => {
    await expect(getDriver('oracle' as never)).rejects.toThrow(
      'Motor de base de datos desconocido: "oracle".'
    )
  })
})
