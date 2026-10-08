import { describe, expect, it } from 'vitest'
import {
  MARIADB_SEQUENCES_SQL,
  describeMariaDbSequence,
  describeNb3MariaDbLimits,
  isMariaDbSession,
  isTrxIdVersionedDdl,
  jsonColumnsFromChecks,
  listMariaDbSequences,
  replaceSafetyPlan,
  setSequenceValueSql,
  skippedFromTableTypes,
  systemVersioningColumns,
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

describe('.nb3 warning for MariaDB objects', () => {
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
    expect(describeNb3MariaDbLimits(skipped)).toBe(
      'La copia .nb3 (MariaDB) no incluye las 2 secuencias seq_a, seq_b y guarda solo las filas actuales de la tabla versionada history, sin historial. Elige el formato .vqb para copiarlo todo.'
    )
    expect(describeNb3MariaDbLimits([{ kind: 'sequence', name: 's' }])).toBe(
      'La copia .nb3 (MariaDB) no incluye la secuencia s. Elige el formato .vqb para copiarlo todo.'
    )
    expect(describeNb3MariaDbLimits([])).toBeNull()
  })
})

describe('system-versioned tables and sequences in backups', () => {
  it('finds the period columns (explicit or hidden)', () => {
    expect(
      systemVersioningColumns(
        'CREATE TABLE `t` (\n  `id` int) ENGINE=InnoDB WITH SYSTEM VERSIONING'
      )
    ).toEqual({ start: 'row_start', end: 'row_end', explicit: false })
    expect(
      systemVersioningColumns(
        'CREATE TABLE `t` (\n  `s` timestamp(6) GENERATED ALWAYS AS ROW START,\n  `e``x` timestamp(6) GENERATED ALWAYS AS ROW END,\n  PERIOD FOR SYSTEM_TIME (`s`, `e``x`)\n) WITH SYSTEM VERSIONING'
      )
    ).toEqual({ start: 's', end: 'e`x', explicit: true })
  })

  it('tells transaction-precise versioning apart', () => {
    expect(
      isTrxIdVersionedDdl(
        '  `s` bigint(20) unsigned GENERATED ALWAYS AS ROW START,\n  `e` bigint(20) unsigned GENERATED ALWAYS AS ROW END,'
      )
    ).toBe(true)
    expect(isTrxIdVersionedDdl('  `s` timestamp(6) GENERATED ALWAYS AS ROW START,')).toBe(false)
    expect(isTrxIdVersionedDdl('CREATE TABLE t (id bigint) WITH SYSTEM VERSIONING')).toBe(false)
  })

  it('sets a restored sequence with SETVAL (validated numbers only)', () => {
    expect(setSequenceValueSql('`s`', { lastValue: '510', isCalled: false })).toBe(
      'SELECT SETVAL(`s`, 510, 0, 0)'
    )
    expect(setSequenceValueSql('`s`', { lastValue: '-3', isCalled: true, round: '2' })).toBe(
      'SELECT SETVAL(`s`, -3, 1, 2)'
    )
    expect(setSequenceValueSql('`s`', { lastValue: '1; DROP', isCalled: false, round: 'x' })).toBe(
      'SELECT SETVAL(`s`, 0, 0, 0)'
    )
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

describe('replaceSafetyPlan', () => {
  const session = (
    version: string,
    rows: { name: string; type: string }[],
    ddl = 'CREATE TABLE `h` (`id` int) WITH SYSTEM VERSIONING'
  ) => {
    const calls: string[] = []
    return {
      calls,
      serverVersion: version,
      query: async <T>(sql: string): Promise<T[]> => {
        calls.push(sql)
        return (sql.startsWith('SHOW CREATE') ? [{ 'Create Table': ddl }] : rows) as T[]
      }
    }
  }

  it('asks for a .vqb safety copy when the database has sequences or versioned tables', async () => {
    expect(
      await replaceSafetyPlan(
        session('11.8.9-MariaDB', [
          { name: 'seq', type: 'SEQUENCE' },
          { name: 'h', type: 'SYSTEM VERSIONED' }
        ]),
        'tienda'
      )
    ).toEqual({ vqb: true, refusal: null })
  })

  it('refuses when transaction-precise history would be lost', async () => {
    const plan = await replaceSafetyPlan(
      session(
        '11.8.9-MariaDB',
        [{ name: 'h', type: 'SYSTEM VERSIONED' }],
        '`s` bigint(20) unsigned GENERATED ALWAYS AS ROW START,'
      ),
      'tienda'
    )
    expect(plan.vqb).toBe(true)
    expect(plan.refusal).toContain('No se reemplaza «tienda»')
    expect(plan.refusal).toContain('Desactiva la copia previa')
  })

  it('never queries a MySQL server and changes nothing when there is nothing special', async () => {
    const mysql = session('8.4.3', [{ name: 's', type: 'SEQUENCE' }])
    expect(await replaceSafetyPlan(mysql, 'x')).toEqual({ vqb: false, refusal: null })
    expect(mysql.calls).toEqual([])
    expect(await replaceSafetyPlan(session('11.8.9-MariaDB', []), 'x')).toEqual({
      vqb: false,
      refusal: null
    })
  })
})
