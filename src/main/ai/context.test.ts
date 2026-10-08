import { describe, expect, it } from 'vitest'
import {
  buildConnectionContext,
  buildMemoryBlock,
  buildSchemaContext,
  versionLabel,
  formatTable,
  mentionedNames,
  roughRows
} from './context'
import {
  isMetadataSql,
  MetadataOnlyError,
  MetadataQueryable,
  readSchemaSnapshot,
  type Queryable,
  type SchemaSnapshot,
  type TableMeta
} from './metadata'

/** Fake server answering the information_schema queries of readSchemaSnapshot; records every SQL. */
function fakeServer(): Queryable & { sql: string[] } {
  const sql: string[] = []
  const data: Record<string, Record<string, unknown>[]> = {
    TABLES: [
      {
        TABLE_NAME: 'person',
        TABLE_TYPE: 'BASE TABLE',
        TABLE_ROWS: 1234,
        TABLE_COMMENT: 'Personas'
      },
      { TABLE_NAME: 'users', TABLE_TYPE: 'BASE TABLE', TABLE_ROWS: 87, TABLE_COMMENT: '' },
      { TABLE_NAME: 'active_users', TABLE_TYPE: 'VIEW', TABLE_ROWS: null, TABLE_COMMENT: 'VIEW' }
    ],
    COLUMNS: [
      {
        TABLE_NAME: 'person',
        COLUMN_NAME: 'id',
        COLUMN_TYPE: 'int',
        IS_NULLABLE: 'NO',
        COLUMN_KEY: 'PRI',
        EXTRA: 'auto_increment',
        COLUMN_COMMENT: ''
      },
      {
        TABLE_NAME: 'person',
        COLUMN_NAME: 'name',
        COLUMN_TYPE: 'varchar(100)',
        IS_NULLABLE: 'YES',
        COLUMN_KEY: '',
        EXTRA: '',
        COLUMN_COMMENT: ''
      },
      {
        TABLE_NAME: 'users',
        COLUMN_NAME: 'id',
        COLUMN_TYPE: 'int',
        IS_NULLABLE: 'NO',
        COLUMN_KEY: 'PRI',
        EXTRA: 'auto_increment',
        COLUMN_COMMENT: ''
      },
      {
        TABLE_NAME: 'users',
        COLUMN_NAME: 'email',
        COLUMN_TYPE: 'varchar(255)',
        IS_NULLABLE: 'NO',
        COLUMN_KEY: 'UNI',
        EXTRA: '',
        COLUMN_COMMENT: 'login'
      },
      {
        TABLE_NAME: 'users',
        COLUMN_NAME: 'status',
        COLUMN_TYPE: "enum('a','b')",
        IS_NULLABLE: 'NO',
        COLUMN_KEY: 'MUL',
        EXTRA: '',
        COLUMN_COMMENT: ''
      },
      {
        TABLE_NAME: 'users',
        COLUMN_NAME: 'person_id',
        COLUMN_TYPE: 'int',
        IS_NULLABLE: 'YES',
        COLUMN_KEY: 'MUL',
        EXTRA: '',
        COLUMN_COMMENT: ''
      },
      {
        TABLE_NAME: 'active_users',
        COLUMN_NAME: 'id',
        COLUMN_TYPE: 'int',
        IS_NULLABLE: 'NO',
        COLUMN_KEY: '',
        EXTRA: '',
        COLUMN_COMMENT: ''
      }
    ],
    STATISTICS: [
      { TABLE_NAME: 'person', INDEX_NAME: 'PRIMARY', NON_UNIQUE: 0, COLUMN_NAME: 'id' },
      { TABLE_NAME: 'users', INDEX_NAME: 'PRIMARY', NON_UNIQUE: 0, COLUMN_NAME: 'id' },
      { TABLE_NAME: 'users', INDEX_NAME: 'uq_email', NON_UNIQUE: 0, COLUMN_NAME: 'email' },
      {
        TABLE_NAME: 'users',
        INDEX_NAME: 'idx_status_person',
        NON_UNIQUE: 1,
        COLUMN_NAME: 'status'
      },
      {
        TABLE_NAME: 'users',
        INDEX_NAME: 'idx_status_person',
        NON_UNIQUE: 1,
        COLUMN_NAME: 'person_id'
      }
    ],
    KEY_COLUMN_USAGE: [
      {
        TABLE_NAME: 'users',
        CONSTRAINT_NAME: 'fk_person',
        COLUMN_NAME: 'person_id',
        REFERENCED_TABLE_SCHEMA: 'app',
        REFERENCED_TABLE_NAME: 'person',
        REFERENCED_COLUMN_NAME: 'id'
      }
    ],
    ROUTINES: [
      { ROUTINE_NAME: 'full_name', ROUTINE_TYPE: 'FUNCTION', DTD_IDENTIFIER: 'varchar(200)' }
    ],
    PARAMETERS: [
      {
        SPECIFIC_NAME: 'full_name',
        ROUTINE_TYPE: 'FUNCTION',
        PARAMETER_MODE: null,
        PARAMETER_NAME: 'p_id',
        DTD_IDENTIFIER: 'int'
      }
    ]
  }
  return {
    sql,
    async query<T>(text: string): Promise<T[]> {
      sql.push(text)
      if (/VERSION\(\)/.test(text)) return [{ version: '8.4.3' }] as T[]
      const table = /information_schema\.(\w+)/i.exec(text)?.[1]?.toUpperCase() ?? ''
      return (data[table] ?? []) as T[]
    }
  }
}

describe('metadata guard (structure only)', () => {
  it('accepts information_schema selects and VERSION()', () => {
    expect(
      isMetadataSql('SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?')
    ).toBe(true)
    expect(isMetadataSql('SELECT VERSION() AS version')).toBe(true)
  })

  it.each([
    'SELECT * FROM users',
    'SELECT * FROM app.users',
    'SELECT * FROM information_schema.TABLES JOIN users ON 1',
    'SELECT * FROM information_schema.TABLES; SELECT * FROM users',
    'SELECT TABLE_NAME INTO @x FROM information_schema.TABLES',
    'DELETE FROM information_schema.TABLES',
    'SHOW TABLES',
    'EXPLAIN SELECT * FROM users',
    'SELECT (SELECT email FROM users LIMIT 1) FROM information_schema.TABLES'
  ])('rejects %s', async (sql) => {
    expect(isMetadataSql(sql)).toBe(false)
    const inner = { query: async () => [] }
    await expect(new MetadataQueryable(inner).query(sql)).rejects.toBeInstanceOf(MetadataOnlyError)
  })

  it('readSchemaSnapshot only issues information_schema / VERSION queries', async () => {
    const server = fakeServer()
    const snap = await readSchemaSnapshot(new MetadataQueryable(server), 'app')
    expect(server.sql.length).toBe(7)
    for (const sql of server.sql) expect(isMetadataSql(sql)).toBe(true)
    // no row-data API: no SELECT from a user table, no column defaults, no bodies
    expect(server.sql.join('\n')).not.toMatch(
      /COLUMN_DEFAULT|VIEW_DEFINITION|ROUTINE_DEFINITION|ACTION_STATEMENT/
    )
    expect(snap.serverVersion).toBe('8.4.3')
    expect(snap.tables.map((t) => t.name)).toEqual(['active_users', 'person', 'users'])
    const users = snap.tables.find((t) => t.name === 'users')!
    expect(users.foreignKeys).toEqual([
      {
        name: 'fk_person',
        columns: ['person_id'],
        refSchema: 'app',
        refTable: 'person',
        refColumns: ['id']
      }
    ])
    expect(snap.routines).toEqual([
      { name: 'full_name', type: 'FUNCTION', params: ['p_id int'], returns: 'varchar(200)' }
    ])
    expect(snap.tables.find((t) => t.name === 'active_users')!).toMatchObject({
      kind: 'view',
      rows: null,
      comment: ''
    })
  })

  it('filters by table for the tool', async () => {
    const server = fakeServer()
    await readSchemaSnapshot(new MetadataQueryable(server), 'app', ['users'])
    expect(server.sql.filter((s) => /TABLE_NAME IN \(\?\)/.test(s))).toHaveLength(4)
    expect(server.sql.some((s) => /ROUTINES/.test(s))).toBe(false)
  })
})

describe('schema context', () => {
  async function snapshot(): Promise<SchemaSnapshot> {
    return readSchemaSnapshot(new MetadataQueryable(fakeServer()), 'app')
  }

  it('rounds row estimates', () => {
    expect(roughRows(null)).toBe('')
    expect(roughRows(7)).toBe('~7')
    expect(roughRows(87)).toBe('~90')
    expect(roughRows(1234)).toBe('~1k')
    expect(roughRows(1_560_000)).toBe('~2M')
  })

  it('formats one compact line per table', async () => {
    const snap = await snapshot()
    const users = formatTable(
      snap.tables.find((t) => t.name === 'users')!,
      'app'
    )
    expect(users).toBe(
      "users ~90 filas: id int PK AI, email varchar(255) UQ «login», status enum('a','b'), person_id int? | idx: idx_status_person(status, person_id) | FK person_id→person.id"
    )
    expect(
      formatTable(
        snap.tables.find((t) => t.name === 'person')!,
        'app'
      )
    ).toBe('person ~1k filas: id int PK AI, name varchar(100)? -- Personas')
  })

  it('is deterministic and contains no volatile data', async () => {
    const a = buildSchemaContext(await snapshot(), { hints: ['usuarios'] })
    const b = buildSchemaContext(await snapshot(), { hints: ['otra pregunta'] })
    expect(a.text).toBe(b.text)
    expect(a.truncated).toBe(false)
    expect(a.text).toContain('Base de datos: app (MySQL 8.4.3)')
    expect(a.text).toContain('FUNCTION full_name(p_id int) RETURNS varchar(200)')
    expect(a.text).not.toMatch(/\d{4}-\d{2}-\d{2}/)
  })

  it('prioritises the open table, mentioned tables and FK neighbours when over the cap', () => {
    const table = (name: string, fk?: string): TableMeta => ({
      name,
      kind: 'table',
      rows: 10,
      comment: '',
      columns: Array.from({ length: 12 }, (_, i) => ({
        name: `column_${i}`,
        type: 'varchar(255)',
        nullable: false,
        key: '',
        extra: '',
        comment: ''
      })),
      indexes: [],
      foreignKeys: fk
        ? [
            {
              name: `fk_${name}`,
              columns: ['column_1'],
              refSchema: 'big',
              refTable: fk,
              refColumns: ['column_0']
            }
          ]
        : []
    })
    const tables = Array.from({ length: 200 }, (_, i) => table(`t${String(i).padStart(3, '0')}`))
    tables.push(table('zz_orders', 'zz_customers'), table('zz_customers'), table('zz_open'))
    const snap: SchemaSnapshot = { schema: 'big', serverVersion: '', tables, routines: [] }
    const ctx = buildSchemaContext(snap, {
      cap: 6000,
      hints: ['SELECT * FROM zz_orders'],
      openTable: 'zz_open'
    })
    expect(ctx.truncated).toBe(true)
    expect(ctx.text.length).toBeLessThanOrEqual(6000)
    expect(ctx.detailed.slice(0, 3)).toEqual(['zz_open', 'zz_orders', 'zz_customers'])
    expect(ctx.text).toMatch(/get_table_structure/)
    expect(ctx.tableCount).toBe(203)
  })

  it('handles huge schemas whose name list does not fit', () => {
    const tables: TableMeta[] = Array.from({ length: 5000 }, (_, i) => ({
      name: `a_rather_long_table_name_${i}`,
      kind: 'table',
      rows: 1,
      comment: '',
      columns: [{ name: 'id', type: 'int', nullable: false, key: 'PRI', extra: '', comment: '' }],
      indexes: [],
      foreignKeys: []
    }))
    const ctx = buildSchemaContext(
      { schema: 'huge', serverVersion: '', tables, routines: [] },
      { cap: 60_000 }
    )
    expect(ctx.text.length).toBeLessThanOrEqual(60_000)
    expect(ctx.text).toMatch(/se muestran \d+/)
  })

  it('mentions tolerate quoting and plurals', () => {
    const names = mentionedNames('pedido de `Clientes`')
    expect(names.has('pedidos')).toBe(true)
    expect(names.has('clientes')).toBe(true)
  })

  it('whole-connection context qualifies names and cross-database FKs', () => {
    const t = (name: string, fk?: { refSchema: string; refTable: string }): TableMeta => ({
      name,
      kind: 'table',
      rows: 10,
      comment: '',
      columns: [
        { name: 'id', type: 'int', nullable: false, key: 'PRI', extra: '', comment: '' },
        { name: 'ref_id', type: 'int', nullable: true, key: '', extra: '', comment: '' }
      ],
      indexes: [{ name: 'PRIMARY', unique: true, columns: ['id'] }],
      foreignKeys: fk ? [{ name: 'fk', columns: ['ref_id'], refColumns: ['id'], ...fk }] : []
    })
    const snaps = [
      { schema: 'crm', serverVersion: '8.4.3', tables: [t('clientes')], routines: [] },
      {
        schema: 'ticket',
        serverVersion: '8.4.3',
        tables: [t('tiquetes', { refSchema: 'crm', refTable: 'clientes' })],
        routines: []
      }
    ]
    const ctx = buildConnectionContext(snaps, 'ticket')
    expect(ctx.text).toContain('Conexión completa (MySQL 8.4.3): 2 bases de datos (crm, ticket).')
    expect(ctx.text).toContain('Base de datos seleccionada: ticket.')
    expect(ctx.text).toContain('crm.clientes ~10 filas')
    expect(ctx.text).toContain('FK ref_id→crm.clientes.id')
    expect(ctx.tableCount).toBe(2)

    // Over the cap: the mentioned table first, then the selected database.
    const many = Array.from({ length: 300 }, (_, i) => t(`tabla_${String(i).padStart(3, '0')}`))
    const big = buildConnectionContext(
      [
        { schema: 'aaa', serverVersion: '', tables: many, routines: [] },
        { schema: 'ticket', serverVersion: '', tables: [t('tiquetes')], routines: [] }
      ],
      'ticket',
      { cap: 4000, hints: ['tabla_250'] }
    )
    expect(big.truncated).toBe(true)
    expect(big.detailed.slice(0, 2)).toEqual(['aaa.tabla_250', 'ticket.tiquetes'])
  })

  it('words the whole-connection header per engine', () => {
    const snap = {
      schema: 'ventas',
      serverVersion: 'PostgreSQL 17.2',
      tables: [],
      routines: []
    }
    const pg = buildConnectionContext([snap], 'ventas', {
      wording: {
        whole: 'Base de datos tienda completa',
        plural: 'esquemas',
        selected: 'Esquema seleccionado',
        qualified: 'esquema.tabla',
        others: 'Otros esquemas'
      },
      otherDatabases: ['z']
    })
    expect(pg.text).toContain(
      'Base de datos tienda completa (PostgreSQL 17.2): 1 esquemas (ventas). Esquema seleccionado: ventas.'
    )
    expect(pg.text).toContain('escritas como esquema.tabla')
    expect(pg.text).toContain('Otros esquemas (solo el nombre')
  })

  it('names MariaDB servers by their own version', () => {
    expect(versionLabel('11.8.9-MariaDB-ubu2404')).toBe(' (MariaDB 11.8.9)')
    expect(versionLabel('5.5.5-10.11.6-MariaDB-log')).toBe(' (MariaDB 10.11.6)')
    expect(versionLabel('8.4.3')).toBe(' (MySQL 8.4.3)')
    expect(versionLabel('SQLite 3.53.4')).toBe(' (SQLite 3.53.4)')
    expect(
      versionLabel(
        'PostgreSQL 17.11 (Debian 17.11-1.pgdg13+2) on aarch64-unknown-linux-gnu, compiled by gcc'
      )
    ).toBe(' (PostgreSQL 17.11)')
    expect(versionLabel('')).toBe('')
  })

  it('memory block', () => {
    expect(buildMemoryBlock('', '', 'app')).toBe('')
    expect(buildMemoryBlock('conn note', 'db note', 'app')).toBe(
      'Notas del usuario sobre esta conexión:\nconn note\n\nNotas del usuario sobre la base de datos app:\ndb note'
    )
    expect(buildMemoryBlock('', 'db note', null)).toBe('')
  })
})
