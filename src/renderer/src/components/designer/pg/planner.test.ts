import { describe, expect, it } from 'vitest'
import type { ColumnInfo, TableStructure } from '@shared/types'
import {
  pgBuildAlter,
  pgBuildCreate,
  pgBuildCreatePlan,
  pgDraftFromStructure,
  pgEmptyColumn,
  pgNewTableDraft,
  pgTablePlanner
} from './planner'
import { pgQualified, pgQuote, splitArrayType, withArray } from './types'
import type { TableDraft } from '@renderer/utils/tableDesigner'

function col(name: string, columnType: string, extra: Partial<ColumnInfo> = {}): ColumnInfo {
  return {
    name,
    ordinal: 0,
    columnType,
    dataType: columnType.replace(/\(.*\)/, ''),
    nullable: true,
    key: '',
    defaultValue: null,
    extra: '',
    characterSet: null,
    collation: null,
    comment: '',
    primaryKey: false,
    autoIncrement: false,
    identity: null,
    generated: null,
    hasDefault: false,
    ...extra
  }
}

/** A realistic table covering every column/constraint/index shape the planner reads. */
function structure(): TableStructure {
  return {
    schema: 'public',
    database: 'app',
    name: 'items',
    kind: 'table',
    tableType: 'BASE TABLE',
    engine: null,
    collation: null,
    comment: 'Artículos',
    autoIncrement: null,
    createSql: '',
    options: { unlogged: false, owner: 'postgres', tablespace: '', partitionKey: '' },
    columns: [
      col('id', 'integer', {
        nullable: false,
        primaryKey: true,
        autoIncrement: true,
        defaultValue: "nextval('items_id_seq'::regclass)",
        hasDefault: true
      }),
      col('code', 'bigint', {
        nullable: false,
        autoIncrement: true,
        identity: 'always',
        hasDefault: true
      }),
      col('name', 'character varying(40)', {
        nullable: false,
        defaultValue: "'x'::character varying",
        comment: 'Nombre'
      }),
      col('price', 'numeric(10,2)', { defaultValue: '0' }),
      col('total', 'numeric(12,2)', {
        generated: 'stored',
        defaultValue: '(price * (2)::numeric)'
      }),
      col('mood', 'mood', { defaultValue: "'ok'::mood", enumValues: ['ok', 'sad'] }),
      col('tags', 'text[]', { defaultValue: "'{}'::text[]" }),
      col('meta', 'jsonb'),
      col('created', 'timestamp with time zone', { nullable: false, defaultValue: 'now()' }),
      col('Owner', 'other.mood[]', { collation: null }),
      col('ref', 'integer')
    ],
    indexes: [
      {
        name: 'items_pkey',
        unique: true,
        type: 'btree',
        columns: ['id'],
        comment: '',
        primary: true,
        constraint: 'items_pkey',
        definition: 'CREATE UNIQUE INDEX items_pkey ON public.items USING btree (id)'
      },
      {
        name: 'items_name_key',
        unique: true,
        type: 'btree',
        columns: ['name'],
        comment: '',
        primary: false,
        constraint: 'items_name_key',
        definition: 'CREATE UNIQUE INDEX items_name_key ON public.items USING btree (name)'
      },
      {
        name: 'ix_lower_name',
        unique: false,
        type: 'btree',
        columns: ['lower((name)::text)'],
        comment: '',
        primary: false,
        constraint: null,
        definition: 'CREATE INDEX ix_lower_name ON public.items USING btree (lower((name)::text))'
      },
      {
        name: 'ix_cheap',
        unique: false,
        type: 'btree',
        columns: ['price'],
        comment: 'baratos',
        primary: false,
        constraint: null,
        definition:
          'CREATE INDEX ix_cheap ON public.items USING btree (price) WHERE (price < (10)::numeric)'
      },
      {
        name: 'ix_tags',
        unique: false,
        type: 'gin',
        columns: ['tags'],
        comment: '',
        primary: false,
        constraint: null,
        definition: 'CREATE INDEX ix_tags ON public.items USING gin (tags)'
      }
    ],
    foreignKeys: [
      {
        name: 'items_ref_fkey',
        columns: ['ref'],
        referencedSchema: 'public',
        referencedTable: 'refs',
        referencedColumns: ['id'],
        onUpdate: 'NO ACTION',
        onDelete: 'CASCADE'
      }
    ],
    constraints: [
      { name: 'items_pkey', type: 'primary', definition: 'PRIMARY KEY (id)', columns: ['id'] },
      {
        name: 'items_name_key',
        type: 'unique',
        definition: 'UNIQUE (name)',
        columns: ['name']
      },
      {
        name: 'items_price_check',
        type: 'check',
        definition: 'CHECK ((price >= (0)::numeric))',
        columns: ['price']
      }
    ]
  }
}

const alterOf = (s: TableStructure, edit: (d: TableDraft) => void) => {
  const d = pgDraftFromStructure(s)
  edit(d)
  return pgBuildAlter(s, d)
}

const byName = (d: TableDraft, name: string) => d.columns.find((c) => c.name === name)!

describe('pg quoting helpers', () => {
  it('quotes only when PostgreSQL needs it', () => {
    expect(pgQuote('users')).toBe('users')
    expect(pgQuote('Users')).toBe('"Users"')
    expect(pgQuote('user')).toBe('"user"')
    expect(pgQuote('a"b')).toBe('"a""b"')
    expect(pgQualified('public', 'Owner')).toBe('public."Owner"')
  })
  it('toggles array types', () => {
    expect(splitArrayType('text[]')).toEqual({ base: 'text', array: true })
    expect(splitArrayType('integer[][]')).toEqual({ base: 'integer', array: true })
    expect(withArray('mood', true)).toBe('mood[]')
    expect(withArray('mood[]', false)).toBe('mood')
  })
})

describe('pgDraftFromStructure', () => {
  it('recognises serial, identity and generated columns', () => {
    const d = pgDraftFromStructure(structure())
    expect(byName(d, 'id')).toMatchObject({
      autoIncrement: true,
      primaryKey: true,
      defaultValue: "nextval('items_id_seq'::regclass)",
      pg: { serial: true, identity: null, generated: null }
    })
    expect(byName(d, 'code')).toMatchObject({
      autoIncrement: true,
      defaultValue: null,
      pg: { identity: 'always', serial: false }
    })
    expect(byName(d, 'total')).toMatchObject({
      defaultValue: null,
      pg: { generated: '(price * (2)::numeric)' }
    })
    // Indexes that back constraints are managed through the constraints.
    expect(d.indexes.map((i) => i.name)).toEqual(['ix_lower_name', 'ix_cheap', 'ix_tags'])
    expect(d.constraints?.map((c) => c.name)).toEqual(['items_name_key', 'items_price_check'])
    expect(d.options).toMatchObject({ unlogged: false, owner: 'postgres' })
  })

  it('round-trips: an untouched draft plans nothing', () => {
    const s = structure()
    const plan = pgBuildAlter(s, pgDraftFromStructure(s))
    expect(plan).toMatchObject({ statements: [], risks: [], problems: [], drops: [] })
    expect(plan.transactional).toBe(true)
    expect(plan.preStatements).toBeUndefined()
    expect(pgTablePlanner.buildAlter(s, pgTablePlanner.draftFromStructure(s)).statements).toEqual(
      []
    )
  })
})

describe('pgBuildCreate', () => {
  it('creates a table with identity, keys, constraints, indexes and comments', () => {
    const d = pgNewTableDraft()
    d.name = 'Orders'
    d.comment = "Pedidos d'hoy"
    d.options = { unlogged: true }
    d.columns.push(
      { ...pgEmptyColumn(), name: 'status', columnType: 'mood', defaultValue: "'ok'::mood" },
      {
        ...pgEmptyColumn(),
        name: 'user',
        columnType: 'integer',
        nullable: false,
        comment: 'Cliente'
      },
      { ...pgEmptyColumn(), name: 'tags', columnType: 'text[]' }
    )
    d.constraints = [
      {
        id: 'c1',
        originalName: null,
        name: 'orders_user_check',
        type: 'check',
        definition: 'CHECK ("user" > 0)'
      }
    ]
    d.indexes = [
      {
        id: 'i1',
        originalName: null,
        name: 'ix_tags',
        unique: false,
        type: 'GIN',
        columns: ['tags'],
        comment: ''
      },
      {
        id: 'i2',
        originalName: null,
        name: 'ix_status_lower',
        unique: true,
        type: 'btree',
        columns: ['status', 'lower(status::text)'],
        comment: 'único'
      }
    ]
    d.foreignKeys = [
      {
        id: 'f1',
        originalName: null,
        name: 'orders_user_fkey',
        columns: ['user'],
        referencedSchema: '',
        referencedTable: 'users',
        referencedColumns: ['id'],
        onUpdate: 'NO ACTION',
        onDelete: 'SET NULL'
      }
    ]
    const plan = pgBuildCreatePlan('sales', d)
    expect(plan.problems).toEqual([])
    expect(plan.transactional).toBe(true)
    expect(plan.statements).toEqual([
      [
        'CREATE UNLOGGED TABLE sales."Orders" (',
        '  id bigint GENERATED BY DEFAULT AS IDENTITY NOT NULL,',
        "  status mood DEFAULT 'ok'::mood,",
        '  "user" integer NOT NULL,',
        '  tags text[],',
        '  PRIMARY KEY (id),',
        '  CONSTRAINT orders_user_check CHECK ("user" > 0),',
        '  CONSTRAINT orders_user_fkey FOREIGN KEY ("user") REFERENCES sales.users (id) ON DELETE SET NULL ON UPDATE NO ACTION',
        ');'
      ].join('\n'),
      'CREATE INDEX ix_tags ON sales."Orders" USING gin (tags);',
      'CREATE UNIQUE INDEX ix_status_lower ON sales."Orders" USING btree (status, (lower(status::text)));',
      "COMMENT ON INDEX sales.ix_status_lower IS 'único';",
      `COMMENT ON TABLE sales."Orders" IS 'Pedidos d''hoy';`,
      `COMMENT ON COLUMN sales."Orders"."user" IS 'Cliente';`
    ])
    expect(pgBuildCreate('sales', d)).toBe(plan.statements.join('\n'))
  })

  it('refuses identity on a non-integer column and puts enum additions first', () => {
    const d = pgNewTableDraft()
    d.name = 't'
    d.columns[0].columnType = 'text'
    d.enumAdditions = { 'public.mood': ['meh'] }
    const plan = pgBuildCreatePlan('public', d)
    expect(plan.problems[0]).toMatch(/identidad solo admite/)
    expect(plan.preStatements).toEqual(["ALTER TYPE public.mood ADD VALUE IF NOT EXISTS 'meh';"])
    expect(pgBuildCreate('public', d).startsWith('ALTER TYPE public.mood')).toBe(true)
  })

  it('supports GENERATED ALWAYS identities and stored generated columns', () => {
    const d = pgNewTableDraft()
    d.name = 't'
    d.columns[0].pg = { identity: 'always', serial: false, generated: null }
    d.columns.push({
      ...pgEmptyColumn(),
      name: 'twice',
      columnType: 'bigint',
      pg: { identity: null, serial: false, generated: 'id * 2' }
    })
    expect(pgBuildCreatePlan('public', d).statements[0]).toContain(
      'id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,\n  twice bigint GENERATED ALWAYS AS (id * 2) STORED'
    )
  })
})

describe('pgBuildAlter', () => {
  it('renames, retypes (USING), changes defaults and nullability in a valid order', () => {
    const plan = alterOf(structure(), (d) => {
      const name = byName(d, 'name')
      name.name = 'title'
      name.columnType = 'text'
      name.defaultValue = null
      const price = byName(d, 'price')
      price.nullable = false
      price.defaultValue = '1'
      const meta = byName(d, 'meta')
      meta.columnType = 'json'
      meta.pg = { ...meta.pg!, using: 'meta::text::json' }
      byName(d, 'created').nullable = true
    })
    expect(plan.problems).toEqual([])
    expect(plan.statements).toEqual([
      'ALTER TABLE public.items RENAME COLUMN name TO title;',
      'ALTER TABLE public.items ALTER COLUMN title TYPE text USING title::text;',
      'ALTER TABLE public.items ALTER COLUMN title DROP DEFAULT;',
      'ALTER TABLE public.items ALTER COLUMN price SET DEFAULT 1;',
      'ALTER TABLE public.items ALTER COLUMN price SET NOT NULL;',
      'ALTER TABLE public.items ALTER COLUMN meta TYPE json USING meta::text::json;',
      'ALTER TABLE public.items ALTER COLUMN created DROP NOT NULL;'
    ])
    expect(plan.risks).toEqual([
      'Se renombra el campo "name" a "title"',
      'El campo "title" cambia de character varying(40) a text: los valores que no se puedan convertir harán fallar la operación',
      'El campo "price" pasa a NOT NULL; fallará si alguna fila tiene NULL',
      'El campo "meta" cambia de jsonb a json: los valores que no se puedan convertir harán fallar la operación'
    ])
  })

  it('adds and drops columns, with drops listed', () => {
    const plan = alterOf(structure(), (d) => {
      d.columns = d.columns.filter((c) => c.name !== 'meta')
      d.columns.push({
        ...pgEmptyColumn(),
        name: 'note',
        columnType: 'character varying(10)',
        nullable: false,
        defaultValue: "''::character varying",
        comment: 'Nota'
      })
    })
    expect(plan.statements).toEqual([
      'ALTER TABLE public.items DROP COLUMN meta;',
      "ALTER TABLE public.items ADD COLUMN note character varying(10) DEFAULT ''::character varying NOT NULL;",
      "COMMENT ON COLUMN public.items.note IS 'Nota';"
    ])
    expect(plan.drops).toEqual([{ kind: 'COLUMN', name: 'meta' }])
    expect(plan.risks).toEqual(['Se elimina el campo "meta" y todos sus datos'])
  })

  it('adds a new identity column and refuses reordering existing ones', () => {
    const s = structure()
    const added = alterOf(s, (d) => {
      d.columns.push({
        ...pgEmptyColumn(),
        name: 'seq',
        columnType: 'bigint',
        autoIncrement: true
      })
    })
    expect(added.statements).toEqual([
      'ALTER TABLE public.items ADD COLUMN seq bigint GENERATED BY DEFAULT AS IDENTITY NOT NULL;'
    ])
    const moved = alterOf(s, (d) => {
      const [first, second, ...rest] = d.columns
      d.columns = [second, first, ...rest]
    })
    expect(moved.problems).toContain('PostgreSQL no permite reordenar columnas existentes')
    const inserted = alterOf(s, (d) => {
      d.columns.splice(1, 0, { ...pgEmptyColumn(), name: 'early' })
    })
    expect(inserted.problems).toEqual([])
    expect(inserted.risks[0]).toMatch(/se añade al final/)
  })

  it('never turns a serial into an identity silently', () => {
    const s = structure()
    const off = alterOf(s, (d) => {
      byName(d, 'id').autoIncrement = false
    })
    expect(off.statements).toEqual(['ALTER TABLE public.items ALTER COLUMN id DROP DEFAULT;'])
    expect(off.risks[0]).toMatch(/deja de ser serial/)

    const on = alterOf(s, (d) => {
      byName(d, 'ref').autoIncrement = true
    })
    expect(on.statements).toEqual([
      'ALTER TABLE public.items ALTER COLUMN ref SET NOT NULL;',
      'ALTER TABLE public.items ALTER COLUMN ref ADD GENERATED BY DEFAULT AS IDENTITY;'
    ])
    expect(on.risks[0]).toMatch(/pasa a ser una columna de identidad/)

    const kind = alterOf(s, (d) => {
      byName(d, 'code').pg!.identity = 'by-default'
    })
    expect(kind.statements).toEqual([
      'ALTER TABLE public.items ALTER COLUMN code SET GENERATED BY DEFAULT;'
    ])
    const drop = alterOf(s, (d) => {
      byName(d, 'code').autoIncrement = false
    })
    expect(drop.statements).toEqual([
      'ALTER TABLE public.items ALTER COLUMN code DROP IDENTITY IF EXISTS;'
    ])
  })

  it('changes the primary key by its real constraint name', () => {
    const plan = alterOf(structure(), (d) => {
      byName(d, 'code').primaryKey = true
    })
    expect(plan.statements).toEqual([
      'ALTER TABLE public.items DROP CONSTRAINT items_pkey;',
      'ALTER TABLE public.items ADD PRIMARY KEY (id, code);'
    ])
    expect(plan.drops).toEqual([{ kind: 'PRIMARY KEY', name: 'items_pkey' }])
  })

  it('edits constraints, indexes and foreign keys (constraint-backed indexes untouched)', () => {
    const plan = alterOf(structure(), (d) => {
      d.constraints = d.constraints!.filter((c) => c.name !== 'items_price_check')
      d.constraints[0].name = 'items_name_uq'
      d.constraints.push({
        id: 'n',
        originalName: null,
        name: 'items_ref_check',
        type: 'check',
        definition: 'CHECK (ref > 0)'
      })
      d.indexes = d.indexes.filter((i) => i.name !== 'ix_tags')
      d.indexes[0].name = 'ix_name_lower'
      d.indexes[1].columns = ['price', 'ref']
      d.foreignKeys[0].onDelete = 'RESTRICT'
    })
    expect(plan.problems).toEqual([])
    expect(plan.statements).toEqual([
      'ALTER TABLE public.items DROP CONSTRAINT items_ref_fkey;',
      'DROP INDEX public.ix_cheap;',
      'DROP INDEX public.ix_tags;',
      'ALTER TABLE public.items DROP CONSTRAINT items_price_check;',
      'ALTER TABLE public.items RENAME CONSTRAINT items_name_key TO items_name_uq;',
      'ALTER TABLE public.items ADD CONSTRAINT items_ref_check CHECK (ref > 0);',
      'ALTER INDEX public.ix_lower_name RENAME TO ix_name_lower;',
      'CREATE INDEX ix_cheap ON public.items USING btree (price, ref) WHERE (price < (10)::numeric);',
      'ALTER TABLE public.items ADD CONSTRAINT items_ref_fkey FOREIGN KEY (ref) REFERENCES public.refs (id) ON DELETE RESTRICT ON UPDATE NO ACTION;',
      "COMMENT ON INDEX public.ix_cheap IS 'baratos';"
    ])
    expect(plan.drops).toEqual([
      { kind: 'CONSTRAINT', name: 'items_price_check' },
      { kind: 'INDEX', name: 'ix_tags' }
    ])
  })

  it('table options, comments and rename (rename last)', () => {
    const plan = alterOf(structure(), (d) => {
      d.name = 'Products'
      d.comment = ''
      d.options = { ...d.options, unlogged: true }
      byName(d, 'name').comment = 'Título'
    })
    expect(plan.statements).toEqual([
      "COMMENT ON COLUMN public.items.name IS 'Título';",
      'COMMENT ON TABLE public.items IS NULL;',
      'ALTER TABLE public.items SET UNLOGGED;',
      'ALTER TABLE public.items RENAME TO "Products";'
    ])
    const owner = alterOf(structure(), (d) => {
      d.options = { ...d.options, owner: 'someone' }
    })
    expect(owner.problems).toEqual([
      'No se puede cambiar el propietario desde el diseñador; usa SQL'
    ])
  })

  it('adding an enum value used as a default: ADD VALUE before the transaction', () => {
    const plan = alterOf(structure(), (d) => {
      d.enumAdditions = { mood: ['meh'] }
      byName(d, 'mood').defaultValue = "'meh'::mood"
    })
    expect(plan.preStatements).toEqual(["ALTER TYPE mood ADD VALUE IF NOT EXISTS 'meh';"])
    expect(plan.statements).toEqual([
      "ALTER TABLE public.items ALTER COLUMN mood SET DEFAULT 'meh'::mood;"
    ])
    expect(plan.transactional).toBe(true)
  })

  it('keeps array types and refuses generated-expression edits', () => {
    const plan = alterOf(structure(), (d) => {
      byName(d, 'Owner').columnType = 'other.mood'
      byName(d, 'total').pg!.generated = 'price * 3'
    })
    expect(plan.statements).toEqual([
      'ALTER TABLE public.items ALTER COLUMN "Owner" TYPE other.mood USING "Owner"::other.mood;'
    ])
    expect(plan.problems[0]).toMatch(/campo generado "total"/)
  })
})
