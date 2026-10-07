import type { ForeignKeyInfo, IndexInfo, TableStructure } from '@shared/types'
import { quoteIdent, quoteString } from './sql'
import { isAutoIncrementColumn, isPrimaryKeyColumn } from './columnMeta'

export interface ColumnDraft {
  /** Stable id for the row while editing. */
  id: string
  /** Name in the database, null when the column is new. */
  originalName: string | null
  name: string
  columnType: string
  nullable: boolean
  defaultValue: string | null
  autoIncrement: boolean
  primaryKey: boolean
  unsigned: boolean
  collation: string | null
  comment: string
  /** PostgreSQL-only column attributes (absent for MySQL). */
  pg?: PgColumnDraft
}

/** PostgreSQL column attributes the MySQL draft cannot express. */
export interface PgColumnDraft {
  /** Identity column (autoIncrement on PostgreSQL means identity unless `serial`). */
  identity: 'always' | 'by-default' | null
  /** Existing serial column: its default is nextval('…'); never converted to identity silently. */
  serial: boolean
  /** Expression of a GENERATED ALWAYS AS (…) STORED column, null otherwise. */
  generated: string | null
  /** USING expression for a type change; empty/absent = `"col"::<new type>`. */
  using?: string
}

/** PostgreSQL unique / check / exclusion constraint of the draft (definition as SQL text). */
export interface ConstraintDraft {
  id: string
  originalName: string | null
  name: string
  type: 'unique' | 'check' | 'exclusion'
  /** pg_get_constraintdef text, e.g. `UNIQUE (email)` or `CHECK ((price > 0))`. */
  definition: string
}

export interface IndexDraft {
  id: string
  originalName: string | null
  name: string
  unique: boolean
  type: string
  columns: string[]
  comment: string
}

export interface ForeignKeyDraft {
  id: string
  originalName: string | null
  name: string
  columns: string[]
  referencedSchema: string
  referencedTable: string
  referencedColumns: string[]
  onUpdate: string
  onDelete: string
}

export interface TableDraft {
  name: string
  engine: string
  collation: string
  comment: string
  autoIncrement: number | null
  columns: ColumnDraft[]
  indexes: IndexDraft[]
  foreignKeys: ForeignKeyDraft[]
  /** PostgreSQL table options: unlogged (boolean); owner, tablespace, partitionKey (read-only). */
  options?: Record<string, string | number | boolean>
  /** PostgreSQL unique / check / exclusion constraints (absent for MySQL). */
  constraints?: ConstraintDraft[]
  /** PostgreSQL: enum labels to add, keyed by type ('schema.type' or 'type'). */
  enumAdditions?: Record<string, string[]>
}

let seq = 0
export const nextId = (): string => `d${++seq}-${Date.now().toString(36)}`

export function emptyColumn(): ColumnDraft {
  return {
    id: nextId(),
    originalName: null,
    name: '',
    columnType: 'varchar(255)',
    nullable: true,
    defaultValue: null,
    autoIncrement: false,
    primaryKey: false,
    unsigned: false,
    collation: null,
    comment: ''
  }
}

export function emptyIndex(): IndexDraft {
  return {
    id: nextId(),
    originalName: null,
    name: '',
    unique: false,
    type: 'BTREE',
    columns: [],
    comment: ''
  }
}

export function emptyForeignKey(): ForeignKeyDraft {
  return {
    id: nextId(),
    originalName: null,
    name: '',
    columns: [],
    referencedSchema: '',
    referencedTable: '',
    referencedColumns: [],
    onUpdate: 'RESTRICT',
    onDelete: 'RESTRICT'
  }
}

export function emptyTable(): TableDraft {
  return {
    name: '',
    engine: 'InnoDB',
    collation: 'utf8mb4_0900_ai_ci',
    comment: '',
    autoIncrement: null,
    columns: [],
    indexes: [],
    foreignKeys: []
  }
}

/** IndexInfo.primary when the driver sets it; otherwise MySQL's index name. */
const isPrimaryIndex = (i: IndexInfo): boolean => i.primary ?? i.name.toUpperCase() === 'PRIMARY'

export function draftFromStructure(structure: TableStructure): TableDraft {
  const primary = new Set(structure.indexes.find(isPrimaryIndex)?.columns ?? [])
  return {
    name: structure.name,
    engine: structure.engine ?? 'InnoDB',
    collation: structure.collation ?? '',
    comment: structure.comment,
    autoIncrement: structure.autoIncrement,
    columns: structure.columns.map((c) => ({
      id: nextId(),
      originalName: c.name,
      name: c.name,
      columnType: c.columnType.replace(/\s+unsigned/i, ''),
      nullable: c.nullable,
      defaultValue: c.defaultValue,
      autoIncrement: isAutoIncrementColumn(c),
      primaryKey: primary.has(c.name) || isPrimaryKeyColumn(c),
      unsigned: /unsigned/i.test(c.columnType),
      collation: c.collation,
      comment: c.comment
    })),
    indexes: structure.indexes
      .filter((i) => !isPrimaryIndex(i))
      .map((i) => ({ id: nextId(), originalName: i.name, ...i })),
    foreignKeys: structure.foreignKeys.map((f) => ({ id: nextId(), originalName: f.name, ...f }))
  }
}

function columnDefinition(c: ColumnDraft): string {
  const parts = [quoteIdent(c.name), c.columnType + (c.unsigned ? ' unsigned' : '')]
  if (c.collation) parts.push(`COLLATE ${c.collation}`)
  parts.push(c.nullable ? 'NULL' : 'NOT NULL')
  if (c.autoIncrement) parts.push('AUTO_INCREMENT')
  else if (c.defaultValue !== null) {
    const raw = c.defaultValue
    const isExpression =
      /^(CURRENT_TIMESTAMP|NOW\(\)|NULL|b'|0x|\()/i.test(raw) || /^-?\d+(\.\d+)?$/.test(raw)
    parts.push(`DEFAULT ${isExpression ? raw : quoteString(raw)}`)
  } else if (c.nullable) parts.push('DEFAULT NULL')
  if (c.comment) parts.push(`COMMENT ${quoteString(c.comment)}`)
  return parts.join(' ')
}

function indexDefinition(i: IndexDraft | IndexInfo): string {
  const cols = i.columns.map(quoteIdent).join(', ')
  const kind =
    i.type.toUpperCase() === 'FULLTEXT'
      ? 'FULLTEXT INDEX'
      : i.type.toUpperCase() === 'SPATIAL'
        ? 'SPATIAL INDEX'
        : i.unique
          ? 'UNIQUE INDEX'
          : 'INDEX'
  const using = ['BTREE', 'HASH'].includes(i.type.toUpperCase())
    ? ` USING ${i.type.toUpperCase()}`
    : ''
  const comment = i.comment ? ` COMMENT ${quoteString(i.comment)}` : ''
  return `${kind} ${quoteIdent(i.name)} (${cols})${using}${comment}`
}

function foreignKeyDefinition(f: ForeignKeyDraft | ForeignKeyInfo): string {
  const cols = f.columns.map(quoteIdent).join(', ')
  const ref = f.referencedSchema
    ? `${quoteIdent(f.referencedSchema)}.${quoteIdent(f.referencedTable)}`
    : quoteIdent(f.referencedTable)
  const refCols = f.referencedColumns.map(quoteIdent).join(', ')
  return `CONSTRAINT ${quoteIdent(f.name)} FOREIGN KEY (${cols}) REFERENCES ${ref} (${refCols}) ON DELETE ${f.onDelete || 'RESTRICT'} ON UPDATE ${f.onUpdate || 'RESTRICT'}`
}

function tableOptions(d: TableDraft): string[] {
  const opts: string[] = []
  if (d.engine) opts.push(`ENGINE=${d.engine}`)
  if (d.autoIncrement !== null && d.autoIncrement !== undefined)
    opts.push(`AUTO_INCREMENT=${d.autoIncrement}`)
  if (d.collation) opts.push(`COLLATE=${d.collation}`)
  if (d.comment) opts.push(`COMMENT=${quoteString(d.comment)}`)
  return opts
}

export function buildCreateTable(schema: string, d: TableDraft): string {
  const lines = d.columns.filter((c) => c.name).map(columnDefinition)
  const pk = d.columns.filter((c) => c.primaryKey && c.name).map((c) => quoteIdent(c.name))
  if (pk.length) lines.push(`PRIMARY KEY (${pk.join(', ')})`)
  for (const i of d.indexes.filter((i) => i.name && i.columns.length))
    lines.push(indexDefinition(i))
  for (const f of d.foreignKeys.filter((f) => f.name && f.columns.length))
    lines.push(foreignKeyDefinition(f))
  const body = lines.map((l) => `  ${l}`).join(',\n')
  const opts = tableOptions(d)
  return `CREATE TABLE ${quoteIdent(schema)}.${quoteIdent(d.name)} (\n${body}\n)${opts.length ? ' ' + opts.join(' ') : ''};`
}

function sameIndex(a: IndexDraft, b: IndexInfo): boolean {
  return (
    a.name === b.name &&
    a.unique === b.unique &&
    a.type.toUpperCase() === b.type.toUpperCase() &&
    a.columns.join(',') === b.columns.join(',') &&
    a.comment === b.comment
  )
}

function sameForeignKey(a: ForeignKeyDraft, b: ForeignKeyInfo): boolean {
  return (
    a.name === b.name &&
    a.columns.join(',') === b.columns.join(',') &&
    a.referencedSchema === b.referencedSchema &&
    a.referencedTable === b.referencedTable &&
    a.referencedColumns.join(',') === b.referencedColumns.join(',') &&
    a.onUpdate === b.onUpdate &&
    a.onDelete === b.onDelete
  )
}

/**
 * Builds the ALTER TABLE statements needed to move `original` to `draft`. Empty array = no changes.
 * Column clauses are rebuilt from the draft only, so expression defaults, ON UPDATE and generated
 * columns of touched columns are lost: UI code must use components/designer/alterTable.ts
 * (buildDesignerAlter), which reuses this function only for indexes, keys and table options.
 */
export function buildAlterTable(original: TableStructure, draft: TableDraft): string[] {
  const base = draftFromStructure(original)
  const target = `${quoteIdent(original.schema)}.${quoteIdent(original.name)}`
  const clauses: string[] = []

  // Foreign keys are dropped first so that index/column changes are allowed.
  const fkDrop: string[] = []
  const fkAdd: string[] = []
  for (const f of original.foreignKeys) {
    const kept = draft.foreignKeys.find((d) => d.originalName === f.name)
    if (!kept || !sameForeignKey(kept, f)) fkDrop.push(`DROP FOREIGN KEY ${quoteIdent(f.name)}`)
  }
  for (const d of draft.foreignKeys.filter((f) => f.name && f.columns.length)) {
    const orig = d.originalName
      ? original.foreignKeys.find((f) => f.name === d.originalName)
      : undefined
    if (!orig || !sameForeignKey(d, orig)) fkAdd.push(`ADD ${foreignKeyDefinition(d)}`)
  }

  for (const c of base.columns) {
    if (!draft.columns.some((d) => d.originalName === c.originalName))
      clauses.push(`DROP COLUMN ${quoteIdent(c.name)}`)
  }
  draft.columns.forEach((d, idx) => {
    if (!d.name) return
    const orig = d.originalName
      ? base.columns.find((c) => c.originalName === d.originalName)
      : undefined
    const position =
      idx === 0
        ? ' FIRST'
        : draft.columns[idx - 1]?.name
          ? ` AFTER ${quoteIdent(draft.columns[idx - 1].name)}`
          : ''
    if (!orig) {
      clauses.push(`ADD COLUMN ${columnDefinition(d)}${position}`)
      return
    }
    const origIdx = base.columns.indexOf(orig)
    const moved = origIdx !== idx
    const { id: _a, primaryKey: _pa, originalName: _oa, ...da } = d
    const { id: _b, primaryKey: _pb, originalName: _ob, ...db } = orig
    const changed = JSON.stringify(da) !== JSON.stringify(db)
    if (changed || moved) {
      const verb =
        d.name !== orig.name ? `CHANGE COLUMN ${quoteIdent(orig.name)} ` : 'MODIFY COLUMN '
      clauses.push(`${verb}${columnDefinition(d)}${moved ? position : ''}`)
    }
  })

  const basePk = base.columns.filter((c) => c.primaryKey).map((c) => c.originalName)
  const draftPk = draft.columns.filter((c) => c.primaryKey && c.name)
  const pkChanged = basePk.join(',') !== draftPk.map((c) => c.originalName ?? c.name).join(',')
  if (pkChanged) {
    if (basePk.length) clauses.push('DROP PRIMARY KEY')
    if (draftPk.length)
      clauses.push(`ADD PRIMARY KEY (${draftPk.map((c) => quoteIdent(c.name)).join(', ')})`)
  }

  const origIndexes = original.indexes.filter((i) => !isPrimaryIndex(i))
  for (const i of origIndexes) {
    const kept = draft.indexes.find((d) => d.originalName === i.name)
    if (!kept || !sameIndex(kept, i)) clauses.push(`DROP INDEX ${quoteIdent(i.name)}`)
  }
  for (const d of draft.indexes.filter((i) => i.name && i.columns.length)) {
    const orig = d.originalName ? origIndexes.find((i) => i.name === d.originalName) : undefined
    if (!orig || !sameIndex(d, orig)) clauses.push(`ADD ${indexDefinition(d)}`)
  }

  const optionClauses: string[] = []
  if (draft.engine !== base.engine) optionClauses.push(`ENGINE=${draft.engine}`)
  if (draft.collation !== base.collation && draft.collation)
    optionClauses.push(`COLLATE=${draft.collation}`)
  if (draft.comment !== base.comment) optionClauses.push(`COMMENT=${quoteString(draft.comment)}`)
  if (draft.autoIncrement !== base.autoIncrement && draft.autoIncrement !== null)
    optionClauses.push(`AUTO_INCREMENT=${draft.autoIncrement}`)

  const statements: string[] = []
  if (fkDrop.length) statements.push(`ALTER TABLE ${target}\n  ${fkDrop.join(',\n  ')};`)
  if (clauses.length || optionClauses.length)
    statements.push(`ALTER TABLE ${target}\n  ${[...clauses, ...optionClauses].join(',\n  ')};`)
  if (fkAdd.length) statements.push(`ALTER TABLE ${target}\n  ${fkAdd.join(',\n  ')};`)
  if (draft.name !== original.name && draft.name)
    statements.push(
      `RENAME TABLE ${target} TO ${quoteIdent(original.schema)}.${quoteIdent(draft.name)};`
    )
  return statements
}
