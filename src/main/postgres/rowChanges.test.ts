import { describe, expect, it } from 'vitest'
import type { ColumnInfo } from '@shared/types'
import { NO_PRIMARY_KEY, buildPgRowStatement, displayPgStatement } from './rowChanges'

const col = (name: string, extra: Partial<ColumnInfo> = {}): ColumnInfo => ({
  name,
  ordinal: 1,
  columnType: 'text',
  dataType: 'text',
  nullable: true,
  key: '',
  defaultValue: null,
  extra: '',
  characterSet: null,
  collation: null,
  comment: '',
  sqlType: 'text',
  ...extra
})

const columns = [
  col('id', { sqlType: 'integer', autoIncrement: true, primaryKey: true, hasDefault: true }),
  col('code', { sqlType: 'bigint', identity: 'always', autoIncrement: true }),
  col('mood', { sqlType: 'app.mood' }),
  col('tags', { sqlType: 'text[]' }),
  col('blob', { sqlType: 'bytea', typeKind: 'binary' }),
  col('total', { sqlType: 'numeric(10,2)', generated: 'stored' })
]

describe('PostgreSQL grid statements', () => {
  it('binds typed parameters and returns the generated key', () => {
    const stmt = buildPgRowStatement(
      'app',
      'Items',
      { kind: 'insert', values: { mood: 'ok', tags: '{a,"b c"}', blob: '0xDEAD' } },
      columns,
      ['id']
    )
    expect(stmt.sql).toBe(
      'INSERT INTO app."Items" (mood, tags, blob) VALUES ($1::app.mood, $2::text[], $3::bytea) RETURNING id'
    )
    expect(stmt.params).toEqual(['ok', '{a,"b c"}', '\\xDEAD'])
    expect(displayPgStatement(stmt)).toBe(
      `INSERT INTO app."Items" (mood, tags, blob) VALUES ('ok'::app.mood, '{a,"b c"}'::text[], '\\xDEAD'::bytea) RETURNING id`
    )
  })

  it('leaves empty serial/identity cells to the server and refuses writing generated values', () => {
    const stmt = buildPgRowStatement(
      'app',
      't',
      { kind: 'insert', values: { id: null, code: null } },
      columns,
      ['id']
    )
    expect(stmt.sql).toBe('INSERT INTO app.t DEFAULT VALUES RETURNING id')
    expect(() =>
      buildPgRowStatement('app', 't', { kind: 'insert', values: { code: '5' } }, columns, ['id'])
    ).toThrow(/GENERATED ALWAYS AS IDENTITY/)
    expect(() =>
      buildPgRowStatement(
        'app',
        't',
        { kind: 'update', key: { id: 1 }, values: { total: '3' } },
        columns,
        ['id']
      )
    ).toThrow(/calculada/)
  })

  it('addresses rows by primary key only', () => {
    const stmt = buildPgRowStatement(
      'app',
      't',
      { kind: 'update', key: { id: 7 }, values: { mood: 'sad' } },
      columns,
      ['id']
    )
    expect(stmt.sql).toBe('UPDATE app.t SET mood = $1::app.mood WHERE id = $2::integer')
    expect(stmt.params).toEqual(['sad', '7'])
    expect(() =>
      buildPgRowStatement('app', 't', { kind: 'delete', key: { mood: 'x' } }, columns, [])
    ).toThrow(NO_PRIMARY_KEY)
    expect(() =>
      buildPgRowStatement(
        'app',
        't',
        { kind: 'update', key: { id: 1 }, values: { nope: 1 } },
        columns,
        ['id']
      )
    ).toThrow('La columna nope no existe en app.t')
  })
})
