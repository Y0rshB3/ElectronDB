import { describe, expect, it } from 'vitest'
import { describeForLog as ipcDescribeForLog } from '../ipc/errorLog'
import { MysqlUserError, describeError } from '../mysql/errors'
import {
  CAPABILITY_MESSAGES,
  DbUserError,
  ServerError,
  describeForLog,
  requireCapability,
  requireConnectionCapability
} from './errors'

describe('DbUserError and MysqlUserError', () => {
  it('keeps MysqlUserError a DbUserError with its own name and code', () => {
    const err = new MysqlUserError('Falta la contraseña')
    expect(err).toBeInstanceOf(DbUserError)
    expect(err).toBeInstanceOf(MysqlUserError)
    expect(err.name).toBe('MysqlUserError')
    expect(err.code).toBe('E_MYSQL_USER')
    // the "(CODE)" suffix MySQL users read in "Probar conexión" is unchanged
    expect(describeError(err)).toBe('Falta la contraseña (E_MYSQL_USER)')
    expect(new MysqlUserError('x', 'E_PRODUCTION_CONFIRM').code).toBe('E_PRODUCTION_CONFIRM')
  })

  it('gives DbUserError a neutral default code', () => {
    const err = new DbUserError('Mensaje')
    expect(err.name).toBe('DbUserError')
    expect(err.code).toBe('E_DB_USER')
  })
})

describe('describeForLog', () => {
  it('keeps the message of our own errors only', () => {
    expect(describeForLog(new DbUserError('Sin conexión'))).toBe('Sin conexión')
    expect(describeForLog(new MysqlUserError('Sin clave'))).toBe('Sin clave')
  })

  it('logs a value-echoing ServerError as its class and code, through the IPC error path too', () => {
    const err = new ServerError(
      'E11000 duplicate key error collection: shop.users dup key: { email: "ana@example.com" }',
      11000
    )
    for (const describe of [describeForLog, ipcDescribeForLog]) {
      const line = describe(err)
      expect(line).toBe('ServerError(11000)')
      expect(line).not.toContain('ana@example.com')
    }
    expect(describeForLog(new ServerError('invalid input syntax: "secreto"'))).toBe(
      'ServerError(sin código)'
    )
  })

  it('reduces raw driver errors to name and code', () => {
    const err = Object.assign(new Error("Duplicate entry 'ana@example.com' for key 'email'"), {
      code: 'ER_DUP_ENTRY',
      errno: 1062
    })
    expect(describeForLog(err)).toBe('Error ER_DUP_ENTRY errno 1062')
  })
})

describe('capability gates', () => {
  const pg = { name: 'PG local', engine: 'postgresql' as const }

  it('lets MySQL (explicit or implied) through every gate', () => {
    for (const conn of [{ name: 'A' }, { name: 'B', engine: 'mysql' as const }]) {
      expect(() =>
        requireConnectionCapability(conn, 'supportsBackupsNb3', CAPABILITY_MESSAGES.backups)
      ).not.toThrow()
      expect(() =>
        requireConnectionCapability(conn, 'supportsAutomation', CAPABILITY_MESSAGES.automation)
      ).not.toThrow()
      expect(() =>
        requireConnectionCapability(conn, 'events', CAPABILITY_MESSAGES.events)
      ).not.toThrow()
      expect(() =>
        requireCapability(conn, 'supportsBackupsNb3', CAPABILITY_MESSAGES.sessions)
      ).not.toThrow()
    }
  })

  it('rejects a PostgreSQL connection with a Spanish DbUserError', () => {
    const cases: [() => void, string][] = [
      [
        () => requireConnectionCapability(pg, 'supportsBackupsNb3', CAPABILITY_MESSAGES.backups),
        'Las copias de seguridad .nb3 solo están disponibles para conexiones MySQL y MariaDB; «PG local» es PostgreSQL.'
      ],
      [
        () => requireConnectionCapability(pg, 'events', CAPABILITY_MESSAGES.events),
        'Los eventos programados no existen en PostgreSQL («PG local»).'
      ],
      [
        () => requireCapability(pg, 'supportsBackupsNb3', CAPABILITY_MESSAGES.sessions),
        CAPABILITY_MESSAGES.sessions
      ]
    ]
    for (const [run, message] of cases) {
      let caught: unknown
      try {
        run()
      } catch (err) {
        caught = err
      }
      expect(caught).toBeInstanceOf(DbUserError)
      expect((caught as Error).message).toBe(message)
      // safe to log: the message is ours
      expect(describeForLog(caught)).toBe(message)
    }
  })

  it('refuses an unknown engine with the engines.ts message', () => {
    expect(() =>
      requireCapability({ engine: 'oracle' as never }, 'events', CAPABILITY_MESSAGES.sessions)
    ).toThrow('Motor de base de datos desconocido: "oracle".')
  })
})
