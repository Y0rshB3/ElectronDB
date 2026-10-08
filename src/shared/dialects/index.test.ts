import { describe, expect, it } from 'vitest'
import type { EngineId } from '../types'
import {
  dialectForEngine,
  getDialect,
  mariadbDialect,
  mysqlDialect,
  postgresqlDialect,
  sqliteDialect
} from './index'
import { MYSQL_LEX } from './mysql'

describe('dialect registry', () => {
  it('ships the MySQL dialect', () => {
    expect(getDialect('mysql')).toBe(mysqlDialect)
    expect(mysqlDialect.id).toBe('mysql')
    expect(mysqlDialect.lex).toBe(MYSQL_LEX)
    expect(dialectForEngine('mysql')).toBe(mysqlDialect)
  })

  it('has no SQL dialect for MongoDB', () => {
    expect(dialectForEngine('mongodb')).toBeNull()
  })

  it('ships the PostgreSQL dialect', () => {
    expect(getDialect('postgresql')).toBe(postgresqlDialect)
    expect(dialectForEngine('postgresql')).toBe(postgresqlDialect)
  })

  it('ships the SQLite dialect', () => {
    expect(getDialect('sqlite')).toBe(sqliteDialect)
    expect(dialectForEngine('sqlite')).toBe(sqliteDialect)
    expect(sqliteDialect.lex.blockBodies).toBe('trigger-begin-end')
  })

  it('ships the MariaDB dialect', () => {
    expect(getDialect('mariadb')).toBe(mariadbDialect)
    expect(dialectForEngine('mariadb')).toBe(mariadbDialect)
    expect(mariadbDialect.lex.executableComments).toContain('/*M!')
  })

  it('refuses an unknown engine with the engines.ts message', () => {
    expect(() => dialectForEngine('oracle' as EngineId)).toThrow(
      'Motor de base de datos desconocido: "oracle".'
    )
  })
})
