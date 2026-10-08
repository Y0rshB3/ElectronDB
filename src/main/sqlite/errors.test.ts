import { describe, expect, it } from 'vitest'
import { describeError, SqliteServerError } from './errors'

describe('describeError (SQLite)', () => {
  it('explains the result code, then marks SQLite text', () => {
    expect(describeError(new SqliteServerError('UNIQUE constraint failed: t.id', 2067))).toBe(
      'Ya existe una fila con ese valor en una columna o índice UNIQUE. Mensaje de SQLite: UNIQUE constraint failed: t.id (SQLITE_CONSTRAINT_UNIQUE)'
    )
    expect(describeError(new SqliteServerError('FOREIGN KEY constraint failed', 787))).toMatch(
      /^La clave foránea no se cumple.*\. Mensaje de SQLite: FOREIGN KEY constraint failed \(SQLITE_CONSTRAINT_FOREIGNKEY\)$/
    )
  })

  it('marks unexplained codes too', () => {
    expect(describeError(new SqliteServerError('no such table: x', 1))).toBe(
      'Mensaje de SQLite: no such table: x (SQLITE_ERROR)'
    )
  })
})
