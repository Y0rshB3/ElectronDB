import { describe, expect, it } from 'vitest'
import type { CellValue } from '@shared/types'
import { parseRowChangeFailure } from '@shared/rowChangeFailure'
import { describeForLog } from '../ipc/errorLog'
import {
  RowChangeError,
  applyRowChanges,
  buildRowChangeStatement,
  decodeBinaryValues,
  explainRowChangeError,
  isBinaryDataType,
  type Escaper
} from './rowChanges'

const escaper: Escaper = {
  escapeId: (id) => '`' + id.replace(/`/g, '``') + '`',
  escape: (v) => {
    if (v === null) return 'NULL'
    if (typeof v === 'number' || typeof v === 'boolean') return String(v)
    if (Buffer.isBuffer(v)) return `X'${v.toString('hex')}'`
    return `'${String(v).replace(/'/g, "\\'")}'`
  }
}

function fakeSession(affected: (sql: string) => number = () => 1) {
  const calls: { sql: string; params?: unknown[] }[] = []
  return {
    calls,
    ...escaper,
    execute: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params })
      if (sql.startsWith('INSERT') && params?.includes('boom')) throw new Error('duplicate')
      return { affectedRows: affected(sql), insertId: sql.startsWith('INSERT') ? 41 : null }
    }
  }
}

describe('buildRowChangeStatement', () => {
  it('builds a parameterised INSERT and a display copy with literals', () => {
    const s = buildRowChangeStatement(
      { kind: 'insert', values: { id: 1, name: "O'Neil", data: null } },
      'app',
      'users',
      escaper
    )
    expect(s.sql).toBe('INSERT INTO `app`.`users` (`id`, `name`, `data`) VALUES (?, ?, ?)')
    expect(s.params).toEqual([1, "O'Neil", null])
    expect(s.display).toBe(
      "INSERT INTO `app`.`users` (`id`, `name`, `data`) VALUES (1, 'O\\'Neil', NULL)"
    )
  })

  it('builds UPDATE with composite key and IS NULL for null key parts', () => {
    const s = buildRowChangeStatement(
      { kind: 'update', key: { a: 1, b: null }, values: { name: 'x' } },
      'app',
      'we`ird',
      escaper
    )
    expect(s.sql).toBe('UPDATE `app`.`we``ird` SET `name` = ? WHERE `a` = ? AND `b` IS NULL')
    expect(s.params).toEqual(['x', 1])
    expect(s.display).toBe("UPDATE `app`.`we``ird` SET `name` = 'x' WHERE `a` = 1 AND `b` IS NULL")
  })

  it('builds DELETE by key', () => {
    const s = buildRowChangeStatement({ kind: 'delete', key: { id: 7 } }, 'app', 'users', escaper)
    expect(s.sql).toBe('DELETE FROM `app`.`users` WHERE `id` = ?')
    expect(s.params).toEqual([7])
    expect(s.display).toBe('DELETE FROM `app`.`users` WHERE `id` = 7')
  })

  it('refuses UPDATE/DELETE with an empty key', () => {
    expect(() =>
      buildRowChangeStatement({ kind: 'update', key: {}, values: { a: 1 } }, 's', 't', escaper)
    ).toThrow(/clave primaria/)
    expect(() => buildRowChangeStatement({ kind: 'delete', key: {} }, 's', 't', escaper)).toThrow(
      /clave primaria/
    )
  })

  it('refuses UPDATE without changed values', () => {
    expect(() =>
      buildRowChangeStatement({ kind: 'update', key: { id: 1 }, values: {} }, 's', 't', escaper)
    ).toThrow(/columnas modificadas/)
  })
})

describe('applyRowChanges', () => {
  it('runs all statements in one transaction and returns display SQL', async () => {
    const session = fakeSession()
    const res = await applyRowChanges(session, 'app', 'users', [
      { kind: 'insert', values: { id: 1 } },
      { kind: 'update', key: { id: 1 }, values: { name: 'n' } },
      { kind: 'delete', key: { id: 2 } }
    ])
    expect(res.applied).toBe(3)
    expect(res.statements).toEqual([
      'INSERT INTO `app`.`users` (`id`) VALUES (1)',
      "UPDATE `app`.`users` SET `name` = 'n' WHERE `id` = 1",
      'DELETE FROM `app`.`users` WHERE `id` = 2'
    ])
    expect(session.calls.map((c) => c.sql.split(' ')[0])).toEqual([
      'START',
      'INSERT',
      'UPDATE',
      'DELETE',
      'COMMIT'
    ])
    expect(session.calls[2].params).toEqual(['n', 1])
    // Generated ids are reported per change so the UI can show new rows' keys.
    expect(res.insertIds).toEqual([41, null, null])
  })

  it('rolls back when a statement fails', async () => {
    const session = fakeSession()
    await expect(
      applyRowChanges(session, 'app', 'users', [
        { kind: 'delete', key: { id: 1 } },
        { kind: 'insert', values: { name: 'boom' } }
      ])
    ).rejects.toThrow('duplicate')
    expect(session.calls.at(-1)?.sql).toBe('ROLLBACK')
  })

  it('rolls back when an update/delete would touch more than one row', async () => {
    const session = fakeSession((sql) => (sql.startsWith('DELETE') ? 3 : 1))
    await expect(
      applyRowChanges(session, 'app', 'users', [{ kind: 'delete', key: { status: 'x' } }])
    ).rejects.toThrow(/3 filas/)
    expect(session.calls.at(-1)?.sql).toBe('ROLLBACK')
  })

  it('validates all statements before touching the database', async () => {
    const session = fakeSession()
    await expect(
      applyRowChanges(session, 'app', 'users', [
        { kind: 'insert', values: { id: 1 } },
        { kind: 'delete', key: {} }
      ])
    ).rejects.toThrow(/clave primaria/)
    expect(session.calls).toEqual([])
  })

  it('is a no-op for an empty change list', async () => {
    const session = fakeSession()
    expect(await applyRowChanges(session, 'app', 'users', [])).toEqual({
      applied: 0,
      statements: []
    })
    expect(session.calls).toEqual([])
  })

  it('accepts null cell values as parameters', () => {
    const values: Record<string, CellValue> = { a: null, b: false }
    const s = buildRowChangeStatement({ kind: 'insert', values }, 's', 't', escaper)
    expect(s.params).toEqual([null, false])
    expect(s.display).toBe('INSERT INTO `s`.`t` (`a`, `b`) VALUES (NULL, false)')
  })

  it('rolls back when an update/delete matches no row', async () => {
    const session = fakeSession((sql) => (sql.startsWith('UPDATE') ? 0 : 1))
    await expect(
      applyRowChanges(session, 'app', 'users', [
        { kind: 'delete', key: { id: 1 } },
        { kind: 'update', key: { id: 2 }, values: { name: 'x' } }
      ])
    ).rejects.toThrow(
      'Falló el cambio 2 de 2 (fila modificada): la fila ya no existe o su clave cambió'
    )
    expect(session.calls.at(-1)?.sql).toBe('ROLLBACK')
  })

  // Regression: a failed apply only showed the raw English server error.
  it('says which change failed, why (in Spanish) and that nothing was written', async () => {
    const serverError = Object.assign(new Error("Column 'city' cannot be null"), {
      code: 'ER_BAD_NULL_ERROR',
      errno: 1048,
      sqlMessage: "Column 'city' cannot be null"
    })
    const session = {
      ...fakeSession(),
      execute: async (sql: string) => {
        if (sql.startsWith('UPDATE')) throw serverError
        return { affectedRows: 1, insertId: null }
      }
    }
    const error = await applyRowChanges(session, 'app', 'users', [
      { kind: 'delete', key: { id: 9 } },
      { kind: 'update', key: { id: 3 }, values: { city: null } },
      { kind: 'insert', values: { name: 'n' } }
    ]).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(RowChangeError)
    const message = (error as Error).message
    expect(message).toBe(
      'Falló el cambio 2 de 3 (fila modificada): la columna «city» no admite NULL. ' +
        'No se aplicó ningún cambio: se deshicieron todos.'
    )
    expect(parseRowChangeFailure(message)).toEqual({
      index: 1,
      column: 'city',
      reason: 'la columna «city» no admite NULL'
    })
    // The IPC log keeps only the class and codes, never the message.
    expect(describeForLog(error)).toBe('RowChangeError ER_BAD_NULL_ERROR errno 1048')
  })

  it('sends 0xHEX cells of binary columns back as bytes', async () => {
    const session = fakeSession()
    const res = await applyRowChanges(
      session,
      'app',
      'blobs',
      [
        { kind: 'update', key: { id: '0x01020304' }, values: { data: '0xdead', label: '0x41' } },
        { kind: 'delete', key: { id: '0xABCD' } }
      ],
      new Set(['id', 'data'])
    )
    expect(session.calls[1].params).toEqual([
      Buffer.from([0xde, 0xad]),
      '0x41',
      Buffer.from([1, 2, 3, 4])
    ])
    expect(session.calls[2].params).toEqual([Buffer.from([0xab, 0xcd])])
    expect(res.statements[0]).toBe(
      "UPDATE `app`.`blobs` SET `data` = X'dead', `label` = '0x41' WHERE `id` = X'01020304'"
    )
  })
})

describe('decodeBinaryValues', () => {
  it('only decodes well-formed hex in binary columns', () => {
    const binary = new Set(['b'])
    expect(decodeBinaryValues({ b: '0x', a: '0xFF' }, binary)).toEqual({
      b: Buffer.alloc(0),
      a: '0xFF'
    })
    expect(decodeBinaryValues({ b: '0xABC' }, binary)).toEqual({ b: '0xABC' })
    expect(decodeBinaryValues({ b: 'plain' }, binary)).toEqual({ b: 'plain' })
    expect(decodeBinaryValues({ b: null }, binary)).toEqual({ b: null })
  })

  it('recognises binary data types', () => {
    expect(['varbinary', 'BLOB', 'bit', 'point', 'geometry'].every(isBinaryDataType)).toBe(true)
    expect(['varchar', 'json', 'int'].some(isBinaryDataType)).toBe(false)
  })
})

describe('explainRowChangeError', () => {
  const server = (errno: number, sqlMessage: string) =>
    Object.assign(new Error(sqlMessage), { errno, sqlMessage, code: 'ER' })

  it('translates the usual row edit errors without quoting values', () => {
    expect(explainRowChangeError(server(1406, "Data too long for column 'name' at row 1"))).toBe(
      'el valor es demasiado largo para la columna «name»'
    )
    expect(
      explainRowChangeError(
        server(1366, "Incorrect integer value: 'secret' for column 'n' at row 1")
      )
    ).toBe('el valor no es válido para la columna «n»')
    const dup = explainRowChangeError(server(1062, "Duplicate entry 'secret' for key 'users.uq'"))
    expect(dup).toBe('ya existe una fila con el mismo valor en la clave única «users.uq»')
    expect(dup).not.toContain('secret')
    expect(explainRowChangeError(server(1364, "Field 'email' doesn't have a default value"))).toBe(
      'la columna «email» es obligatoria y no tiene valor por defecto'
    )
    expect(explainRowChangeError(server(1452, 'Cannot add or update a child row'))).toContain(
      'clave foránea'
    )
  })

  it('keeps unknown server errors with their code', () => {
    expect(explainRowChangeError(server(9999, 'Something odd'))).toBe('Something odd (ER 9999)')
  })
})
