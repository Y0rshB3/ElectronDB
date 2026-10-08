import { describe, expect, it } from 'vitest'
import {
  MARIADB_SEQUENCES_SQL,
  describeMariaDbSequence,
  describeSkippedObjects,
  isMariaDbSession,
  jsonColumnsFromChecks,
  listMariaDbSequences,
  replaceSafetyRefusal,
  skippedFromTableTypes,
  unquoteMariaDbDefault
} from './mariadb'
import { buildCountSql, buildSelectSql } from './tableData'
import { extendedTypeLabel, toQueryColumn } from './values'

describe('MariaDB COLUMN_DEFAULT unquoting', () => {
  it.each([
    [null, null],
    ['NULL', null],
    ["'NULL'", 'NULL'],
    ["''", ''],
    ["'x''y'", "x'y"],
    ["'a\\\\b'", 'a\\b'],
    ["'y'", 'y'],
    ['1.50', '1.50'],
    ['current_timestamp()', 'current_timestamp()'],
    ['uuid()', 'uuid()']
  ])('%j -> %j', (raw, expected) => {
    expect(unquoteMariaDbDefault(raw)).toBe(expected)
  })
})

describe('MariaDB session detection', () => {
  it('reads the server version a session carries', () => {
    expect(isMariaDbSession({ serverVersion: '11.8.9-MariaDB' })).toBe(true)
    expect(isMariaDbSession({ serverVersion: '8.4.7' })).toBe(false)
    expect(isMariaDbSession({})).toBe(false)
    expect(isMariaDbSession(null)).toBe(false)
  })
})

describe('backup warning for skipped MariaDB objects', () => {
  it('lists system-versioned tables and sequences by name only', () => {
    const skipped = skippedFromTableTypes([
      { name: 'orders', type: 'BASE TABLE' },
      { name: 'history', type: 'SYSTEM VERSIONED' },
      { name: 'seq_a', type: 'SEQUENCE' },
      { name: 'seq_b', type: 'sequence' },
      { name: 'v', type: 'VIEW' }
    ])
    expect(skipped).toEqual([
      { kind: 'system-versioned', name: 'history' },
      { kind: 'sequence', name: 'seq_a' },
      { kind: 'sequence', name: 'seq_b' }
    ])
    expect(describeSkippedObjects(skipped)).toBe(
      'La copia no incluye 1 tabla versionada y 2 secuencias (MariaDB): history, seq_a, seq_b. Copia esos objetos con otra herramienta si los necesitas.'
    )
    expect(describeSkippedObjects([])).toBeNull()
  })
})

describe('table data SQL per flavour', () => {
  const req = { schema: 'db', table: 't', limit: 10, offset: 0 }
  it('MySQL keeps the v0.1.x text', () => {
    expect(buildCountSql(req)).toBe(
      'SELECT /*+ MAX_EXECUTION_TIME(3000) */ COUNT(*) AS total FROM `db`.`t`'
    )
    expect(buildSelectSql(req)).toBe('SELECT * FROM `db`.`t` LIMIT 10 OFFSET 0')
  })
  it('MariaDB counts with SET STATEMENT max_statement_time and names INVISIBLE columns', () => {
    expect(buildCountSql(req, [], 'mariadb')).toBe(
      'SET STATEMENT max_statement_time=3 FOR SELECT COUNT(*) AS total FROM `db`.`t`'
    )
    expect(buildSelectSql(req, [], ['id', 'secret'])).toBe(
      'SELECT `id`, `secret` FROM `db`.`t` LIMIT 10 OFFSET 0'
    )
  })
})

describe('MariaDB extended type labels', () => {
  it('uses extendedFormat/extendedTypeName and falls back to the MySQL name', () => {
    expect(extendedTypeLabel({ name: 'j', columnType: 0xfc, extendedFormat: 'json' })).toBe('JSON')
    expect(extendedTypeLabel({ name: 'u', columnType: 0xfe, extendedTypeName: 'uuid' })).toBe(
      'UUID'
    )
    expect(extendedTypeLabel({ name: 'i', columnType: 0xfe, extendedTypeName: 'inet6' })).toBe(
      'INET6'
    )
    expect(extendedTypeLabel({ name: 'n', columnType: 0x03 })).toBe('INT')
    expect(toQueryColumn({ name: 'j', columnType: 0xfc, extendedFormat: 'json' }).type).toBe('JSON')
  })
})

describe('MariaDB engine helpers (P5)', () => {
  it('recognises JSON columns from their json_valid column check', () => {
    expect(
      jsonColumnsFromChecks([
        { name: 'doc', clause: 'json_valid(`doc`)' },
        { name: 'a`b', clause: 'json_valid(`a``b`)' },
        { name: 'other', clause: 'json_valid(`doc`)' },
        { name: 'price', clause: '`price` > 0' }
      ])
    ).toEqual(new Set(['doc', 'a`b']))
  })

  it('describes a sequence from information_schema.SEQUENCES', () => {
    expect(
      describeMariaDbSequence({
        seqStart: '500',
        seqStep: 1,
        seqMin: '1',
        seqMax: '9223372036854775806',
        seqCycle: 0
      })
    ).toBe('inicio 500 · incremento 1 · 1…9223372036854775806 · sin ciclo')
    expect(describeMariaDbSequence({ seqCycle: 1 })).toContain('cíclica')
  })

  it('lists sequences, falling back to information_schema.TABLES on older servers', async () => {
    const calls: string[] = []
    const modern = {
      query: async <T>(sql: string): Promise<T[]> => {
        calls.push(sql)
        return [
          {
            name: 's1',
            dataType: 'bigint',
            seqStart: 1,
            seqStep: 1,
            seqMin: 1,
            seqMax: 9,
            seqCycle: 0
          }
        ] as T[]
      }
    }
    expect(await listMariaDbSequences(modern, 'db')).toEqual([
      {
        name: 's1',
        type: 'sequence',
        schema: 'db',
        kind: 'bigint',
        detail: 'inicio 1 · incremento 1 · 1…9 · sin ciclo'
      }
    ])
    const old = {
      query: async <T>(sql: string): Promise<T[]> => {
        if (sql.includes('SEQUENCES')) throw new Error("Unknown table 'SEQUENCES'")
        return [{ name: 's2', comment: '' }] as T[]
      }
    }
    expect(await listMariaDbSequences(old, 'db')).toEqual([
      { name: 's2', type: 'sequence', schema: 'db', detail: null, comment: undefined }
    ])
    expect(calls[0]).toBe(MARIADB_SEQUENCES_SQL)
  })
})

describe('replaceSafetyRefusal', () => {
  const session = (version: string, rows: { name: string; type: string }[]) => ({
    serverVersion: version,
    query: async <T>(): Promise<T[]> => rows as T[]
  })

  it('refuses a REPLACE whose safety copy would leave MariaDB objects out', async () => {
    const refusal = await replaceSafetyRefusal(
      session('11.8.9-MariaDB', [{ name: 'seq', type: 'SEQUENCE' }]),
      'tienda'
    )
    expect(refusal).toContain('No se reemplaza «tienda»')
    expect(refusal).toContain('1 secuencia')
    expect(refusal).toContain('Desactiva la copia previa')
  })

  it('allows it on MySQL servers and when nothing would be left out', async () => {
    expect(
      await replaceSafetyRefusal(session('8.4.3', [{ name: 's', type: 'SEQUENCE' }]), 'x')
    ).toBeNull()
    expect(await replaceSafetyRefusal(session('11.8.9-MariaDB', []), 'x')).toBeNull()
  })
})
