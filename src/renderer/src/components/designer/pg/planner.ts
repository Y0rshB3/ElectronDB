/**
 * PostgreSQL table designer planner (docs/multi-engine-design.md, section 8.1).
 *
 * Builds CREATE TABLE and ALTER plans from the shared TableDraft model. Every
 * statement is a separate `ALTER TABLE …;` so the whole plan runs in one
 * transaction (PostgreSQL DDL is transactional); `ALTER TYPE … ADD VALUE`
 * goes to `preStatements`, run before the transaction, because a value added
 * in a transaction cannot be used in it.
 *
 * Defaults are raw SQL expressions exactly as PostgreSQL shows them
 * (`'x'::character varying`, `now()`, `0`). Existing serial columns are
 * recognised by their nextval() default and are never turned into identity
 * columns silently. Existing columns cannot be reordered.
 */
import type { ConstraintInfo, ForeignKeyInfo, IndexInfo, TableStructure } from '@shared/types'
import type { DesignerAlter, DesignerDrop } from '@renderer/components/designer/alterTable'
import {
  emptyColumn,
  nextId,
  type ColumnDraft,
  type ConstraintDraft,
  type ForeignKeyDraft,
  type IndexDraft,
  type PgColumnDraft,
  type TableDraft
} from '@renderer/utils/tableDesigner'
import { IDENTITY_TYPES, isNextvalDefault, pgQualified, pgQuote, pgString } from './types'

const NO_PG: PgColumnDraft = { identity: null, serial: false, generated: null }

const pgOf = (c: ColumnDraft): PgColumnDraft => c.pg ?? NO_PG

/** Empty draft of a new PostgreSQL table (no MySQL engine or collation). */
export function pgEmptyTable(): TableDraft {
  return {
    name: '',
    engine: '',
    collation: '',
    comment: '',
    autoIncrement: null,
    columns: [],
    indexes: [],
    foreignKeys: [],
    options: { unlogged: false },
    constraints: [],
    enumAdditions: {}
  }
}

/** A new table with an `id bigint` identity primary key, ready to edit. */
export function pgNewTableDraft(): TableDraft {
  const id: ColumnDraft = {
    ...emptyColumn(),
    name: 'id',
    columnType: 'bigint',
    nullable: false,
    autoIncrement: true,
    primaryKey: true,
    pg: { identity: 'by-default', serial: false, generated: null }
  }
  return { ...pgEmptyTable(), columns: [id] }
}

/** A new PostgreSQL column (text, nullable). */
export function pgEmptyColumn(): ColumnDraft {
  return { ...emptyColumn(), columnType: 'text', pg: { ...NO_PG } }
}

const isPrimaryIndex = (i: IndexInfo): boolean => i.primary ?? false

function primaryColumns(structure: TableStructure): Set<string> {
  const fromConstraint = structure.constraints?.find((c) => c.type === 'primary')?.columns
  const fromIndex = structure.indexes.find(isPrimaryIndex)?.columns
  return new Set([
    ...(fromConstraint ?? fromIndex ?? []),
    ...structure.columns.filter((c) => c.primaryKey).map((c) => c.name)
  ])
}

const optionText = (v: unknown): string => (v === null || v === undefined ? '' : String(v))

export function pgDraftFromStructure(structure: TableStructure): TableDraft {
  const primary = primaryColumns(structure)
  return {
    name: structure.name,
    engine: '',
    collation: '',
    comment: structure.comment ?? '',
    autoIncrement: null,
    columns: structure.columns.map((c): ColumnDraft => {
      const generated = c.generated === 'stored' ? (c.defaultValue ?? '') : null
      const identity = c.identity ?? null
      const serial = !identity && !generated && isNextvalDefault(c.defaultValue)
      return {
        id: nextId(),
        originalName: c.name,
        name: c.name,
        columnType: c.columnType,
        nullable: c.nullable,
        defaultValue: generated !== null || identity ? null : c.defaultValue,
        autoIncrement: !!identity || serial,
        primaryKey: primary.has(c.name),
        unsigned: false,
        collation: c.collation,
        comment: c.comment ?? '',
        pg: { identity, serial, generated }
      }
    }),
    // Indexes that back a constraint change through the constraint (or the primary key).
    indexes: structure.indexes
      .filter((i) => !isPrimaryIndex(i) && !i.constraint)
      .map((i) => ({
        id: nextId(),
        originalName: i.name,
        name: i.name,
        unique: i.unique,
        type: i.type,
        columns: [...i.columns],
        comment: i.comment ?? ''
      })),
    foreignKeys: structure.foreignKeys.map((f) => ({
      id: nextId(),
      originalName: f.name,
      ...f,
      columns: [...f.columns],
      referencedColumns: [...f.referencedColumns]
    })),
    options: {
      unlogged: structure.options?.unlogged === true,
      owner: optionText(structure.options?.owner),
      tablespace: optionText(structure.options?.tablespace),
      partitionKey: optionText(structure.options?.partitionKey)
    },
    constraints: (structure.constraints ?? [])
      .filter((c): c is ConstraintInfo & { type: ConstraintDraft['type'] } => c.type !== 'primary')
      .map((c) => ({
        id: nextId(),
        originalName: c.name,
        name: c.name,
        type: c.type,
        definition: c.definition
      })),
    enumAdditions: {}
  }
}

/* ---------- SQL fragments ---------- */

const ACTIONS = new Set(['NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL', 'SET DEFAULT'])

function fkAction(value: string): string {
  const v = (value || 'NO ACTION').trim().toUpperCase()
  return ACTIONS.has(v) ? v : 'NO ACTION'
}

function identityClause(kind: 'always' | 'by-default'): string {
  return kind === 'always' ? 'GENERATED ALWAYS AS IDENTITY' : 'GENERATED BY DEFAULT AS IDENTITY'
}

const typeWithCollation = (c: ColumnDraft): string =>
  c.collation ? `${c.columnType} COLLATE ${pgQuote(c.collation)}` : c.columnType

/** Identity kind a column should have: the explicit one, or by-default for a new auto increment. */
function wantedIdentity(c: ColumnDraft): 'always' | 'by-default' | null {
  const pg = pgOf(c)
  if (!c.autoIncrement || pg.serial) return null
  return pg.identity ?? 'by-default'
}

function columnDefinition(c: ColumnDraft): string {
  const parts = [pgQuote(c.name), typeWithCollation(c)]
  const pg = pgOf(c)
  const identity = wantedIdentity(c)
  if (pg.generated !== null) parts.push(`GENERATED ALWAYS AS (${pg.generated}) STORED`)
  else if (identity) parts.push(identityClause(identity))
  else if (c.defaultValue !== null && c.defaultValue !== '') parts.push(`DEFAULT ${c.defaultValue}`)
  if (!c.nullable || identity) parts.push('NOT NULL')
  return parts.join(' ')
}

function fkDefinition(f: ForeignKeyDraft, schema: string): string {
  const cols = f.columns.map(pgQuote).join(', ')
  const ref = pgQualified(f.referencedSchema || schema, f.referencedTable)
  const refCols = f.referencedColumns.map(pgQuote).join(', ')
  return `CONSTRAINT ${pgQuote(f.name)} FOREIGN KEY (${cols}) REFERENCES ${ref} (${refCols}) ON DELETE ${fkAction(f.onDelete)} ON UPDATE ${fkAction(f.onUpdate)}`
}

/** Index column: a table column (quoted) or an expression as written (parenthesised). */
function indexPart(part: string, columnNames: Set<string>): string {
  if (columnNames.has(part)) return pgQuote(part)
  const trimmed = part.trim()
  if (/^"(?:[^"]|"")+"$/.test(trimmed) || /^[a-z_][a-z0-9_$]*$/.test(trimmed)) return trimmed
  return trimmed.startsWith('(') && trimmed.endsWith(')') ? trimmed : `(${trimmed})`
}

/** `WHERE …` tail of a partial index definition (pg_get_indexdef), or ''. */
function indexPredicate(definition: string | undefined): string {
  const m = definition ? /\sWHERE\s([\s\S]+)$/i.exec(definition) : null
  return m ? ` WHERE ${m[1].trim()}` : ''
}

function createIndex(
  i: IndexDraft,
  table: string,
  columnNames: Set<string>,
  predicate = ''
): string {
  const am = (i.type || 'btree').trim().toLowerCase()
  const cols = i.columns.map((c) => indexPart(c, columnNames)).join(', ')
  return `CREATE ${i.unique ? 'UNIQUE ' : ''}INDEX ${pgQuote(i.name)} ON ${table} USING ${am} (${cols})${predicate};`
}

function commentOn(target: string, comment: string): string {
  return `COMMENT ON ${target} IS ${comment ? pgString(comment) : 'NULL'};`
}

/** 'schema.type' / 'type' key of enumAdditions as a qualified type name. */
function enumTypeName(key: string): string {
  const trimmed = key.trim()
  if (trimmed.startsWith('"')) return trimmed
  const dot = trimmed.indexOf('.')
  return dot > 0 ? pgQualified(trimmed.slice(0, dot), trimmed.slice(dot + 1)) : pgQuote(trimmed)
}

function enumPreStatements(draft: TableDraft): string[] {
  const out: string[] = []
  for (const [type, labels] of Object.entries(draft.enumAdditions ?? {}))
    for (const label of labels)
      if (label !== '')
        out.push(`ALTER TYPE ${enumTypeName(type)} ADD VALUE IF NOT EXISTS ${pgString(label)};`)
  return out
}

/** Problems with a column that PostgreSQL cannot create as drafted. */
function columnProblems(c: ColumnDraft, problems: string[]): void {
  const identity = wantedIdentity(c)
  if (identity && !IDENTITY_TYPES.has(c.columnType.trim().toLowerCase()))
    problems.push(
      `El campo "${c.name}" es autoincremental: la identidad solo admite smallint, integer o bigint`
    )
  if (pgOf(c).generated !== null && !pgOf(c).generated!.trim())
    problems.push(`El campo generado "${c.name}" necesita una expresión`)
}

/* ---------- CREATE ---------- */

/**
 * The whole CREATE plan as one script (TablePlanner.buildCreate). Enum labels to add
 * come first, as their own statements; prefer pgBuildCreatePlan to run them outside
 * the transaction.
 */
export function pgBuildCreate(schema: string, draft: TableDraft): string {
  const plan = pgBuildCreatePlan(schema, draft)
  return [...(plan.preStatements ?? []), ...plan.statements].join('\n')
}

/** CREATE TABLE plus its indexes and comments, as separate statements. */
export function pgBuildCreatePlan(schema: string, draft: TableDraft): DesignerAlter {
  const table = pgQualified(schema, draft.name)
  const problems: string[] = []
  const columns = draft.columns.filter((c) => c.name)
  const names = new Set(columns.map((c) => c.name))
  const lines = columns.map((c) => {
    columnProblems(c, problems)
    return columnDefinition(c)
  })
  const pk = columns.filter((c) => c.primaryKey).map((c) => pgQuote(c.name))
  if (pk.length) lines.push(`PRIMARY KEY (${pk.join(', ')})`)
  for (const c of (draft.constraints ?? []).filter((c) => c.definition.trim()))
    lines.push(c.name ? `CONSTRAINT ${pgQuote(c.name)} ${c.definition}` : c.definition)
  for (const f of draft.foreignKeys.filter((f) => f.name && f.columns.length))
    lines.push(fkDefinition(f, schema))
  const unlogged = draft.options?.unlogged === true ? 'UNLOGGED ' : ''
  const statements = [
    `CREATE ${unlogged}TABLE ${table} (\n${lines.map((l) => `  ${l}`).join(',\n')}\n);`
  ]
  for (const i of draft.indexes.filter((i) => i.name && i.columns.length)) {
    statements.push(createIndex(i, table, names))
    if (i.comment) statements.push(commentOn(`INDEX ${pgQualified(schema, i.name)}`, i.comment))
  }
  if (draft.comment) statements.push(commentOn(`TABLE ${table}`, draft.comment))
  for (const c of columns.filter((c) => c.comment))
    statements.push(commentOn(`COLUMN ${table}.${pgQuote(c.name)}`, c.comment))
  const pre = enumPreStatements(draft)
  return {
    statements,
    risks: [],
    problems,
    drops: [],
    transactional: true,
    ...(pre.length ? { preStatements: pre } : {})
  }
}

/* ---------- ALTER ---------- */

const sameList = (a: string[], b: string[]): boolean => a.join('\u0000') === b.join('\u0000')

function sameForeignKey(a: ForeignKeyDraft, b: ForeignKeyInfo, schema: string): boolean {
  return (
    a.name === b.name &&
    sameList(a.columns, b.columns) &&
    (a.referencedSchema || schema) === (b.referencedSchema || schema) &&
    a.referencedTable === b.referencedTable &&
    sameList(a.referencedColumns, b.referencedColumns) &&
    fkAction(a.onUpdate) === fkAction(b.onUpdate) &&
    fkAction(a.onDelete) === fkAction(b.onDelete)
  )
}

const sameIndexShape = (a: IndexDraft, b: IndexDraft): boolean =>
  a.unique === b.unique &&
  (a.type || 'btree').toLowerCase() === (b.type || 'btree').toLowerCase() &&
  sameList(a.columns, b.columns)

const norm = (v: string | null | undefined): string => (v ?? '').trim()

/** Existing columns kept by the draft appear in their original order. */
function reordered(base: ColumnDraft[], draft: ColumnDraft[]): boolean {
  const kept = new Set(draft.map((d) => d.originalName).filter(Boolean))
  const before = base.map((c) => c.originalName).filter((n) => kept.has(n))
  const after = draft.map((d) => d.originalName).filter((n): n is string => !!n)
  return !sameList(before as string[], after)
}

function primaryConstraintName(original: TableStructure): string {
  return (
    original.constraints?.find((c) => c.type === 'primary')?.name ??
    original.indexes.find(isPrimaryIndex)?.constraint ??
    original.indexes.find(isPrimaryIndex)?.name ??
    `${original.name}_pkey`
  )
}

export function pgBuildAlter(original: TableStructure, draft: TableDraft): DesignerAlter {
  const base = pgDraftFromStructure(original)
  const schema = original.schema
  const table = pgQualified(schema, original.name)
  const alter = (clause: string): string => `ALTER TABLE ${table} ${clause};`
  const risks: string[] = []
  const problems: string[] = []
  const drops: DesignerDrop[] = []

  const dropFks: string[] = []
  const dropIndexes: string[] = []
  const dropConstraints: string[] = []
  const dropColumns: string[] = []
  const renames: string[] = []
  const columnChanges: string[] = []
  const addColumns: string[] = []
  const addConstraints: string[] = []
  const indexChanges: string[] = []
  const addFks: string[] = []
  const comments: string[] = []
  const options: string[] = []

  const draftColumns = draft.columns.filter((c) => c.name)
  const finalNames = new Set(draftColumns.map((c) => c.name))

  /* Columns */
  for (const c of base.columns) {
    if (draft.columns.some((d) => d.originalName === c.originalName)) continue
    dropColumns.push(alter(`DROP COLUMN ${pgQuote(c.name)}`))
    risks.push(`Se elimina el campo "${c.name}" y todos sus datos`)
    drops.push({ kind: 'COLUMN', name: c.name })
  }
  if (reordered(base.columns, draft.columns))
    problems.push('PostgreSQL no permite reordenar columnas existentes')

  const lastExisting = draftColumns.reduce((at, d, i) => (d.originalName ? i : at), -1)
  draftColumns.forEach((d, idx) => {
    const orig = d.originalName ? base.columns.find((c) => c.originalName === d.originalName) : null
    if (!orig) {
      columnProblems(d, problems)
      addColumns.push(alter(`ADD COLUMN ${columnDefinition(d)}`))
      if (idx < lastExisting)
        risks.push(
          `El campo nuevo "${d.name}" se añade al final de la tabla: PostgreSQL no inserta columnas entre otras`
        )
      if (d.comment) comments.push(commentOn(`COLUMN ${table}.${pgQuote(d.name)}`, d.comment))
      return
    }
    const col = `ALTER COLUMN ${pgQuote(d.name)}`
    if (d.name !== orig.name) {
      renames.push(alter(`RENAME COLUMN ${pgQuote(orig.name)} TO ${pgQuote(d.name)}`))
      risks.push(`Se renombra el campo "${orig.name}" a "${d.name}"`)
    }
    const op = pgOf(orig)
    const dp = pgOf(d)
    const typeChanged = norm(d.columnType).toLowerCase() !== norm(orig.columnType).toLowerCase()
    const collationChanged = norm(d.collation) !== norm(orig.collation)
    if (typeChanged || collationChanged) {
      const using = norm(dp.using) || `${pgQuote(d.name)}::${d.columnType}`
      columnChanges.push(alter(`${col} TYPE ${typeWithCollation(d)} USING ${using}`))
      if (typeChanged)
        risks.push(
          `El campo "${d.name}" cambia de ${orig.columnType} a ${d.columnType}: los valores que no se puedan convertir harán fallar la operación`
        )
      if (collationChanged)
        risks.push(`El campo "${d.name}" cambia de intercalación; cambia el orden de los textos`)
    }
    if (norm(dp.generated ?? '') !== norm(op.generated ?? ''))
      problems.push(
        `No se puede cambiar la expresión del campo generado "${d.name}" desde el diseñador; edítala con SQL`
      )

    // Auto increment: identity or serial.
    const origIdentity = op.identity
    const newIdentity = d.autoIncrement
      ? op.serial
        ? null
        : (dp.identity ?? origIdentity ?? 'by-default')
      : null
    let defaultDropped = false
    if (op.serial && !d.autoIncrement) {
      columnChanges.push(alter(`${col} DROP DEFAULT`))
      defaultDropped = true
      risks.push(
        `El campo "${d.name}" deja de ser serial: se quita su valor por defecto (la secuencia no se borra)`
      )
    }
    if (origIdentity && !newIdentity) {
      columnChanges.push(alter(`${col} DROP IDENTITY IF EXISTS`))
      risks.push(`El campo "${d.name}" deja de ser una columna de identidad`)
    } else if (!origIdentity && newIdentity) {
      if (!IDENTITY_TYPES.has(norm(d.columnType).toLowerCase()))
        problems.push(
          `El campo "${d.name}" es autoincremental: la identidad solo admite smallint, integer o bigint`
        )
      if (orig.defaultValue !== null) {
        columnChanges.push(alter(`${col} DROP DEFAULT`))
        defaultDropped = true
      }
      if (orig.nullable) columnChanges.push(alter(`${col} SET NOT NULL`))
      columnChanges.push(alter(`${col} ADD ${identityClause(newIdentity)}`))
      risks.push(
        `El campo "${d.name}" pasa a ser una columna de identidad (${newIdentity === 'always' ? 'GENERATED ALWAYS' : 'GENERATED BY DEFAULT'})`
      )
    } else if (origIdentity && newIdentity && origIdentity !== newIdentity) {
      columnChanges.push(
        alter(`${col} SET GENERATED ${newIdentity === 'always' ? 'ALWAYS' : 'BY DEFAULT'}`)
      )
    }

    // Default (not for identity or generated columns, nor a serial's own nextval).
    if (!newIdentity && dp.generated === null && !defaultDropped) {
      const was = norm(orig.defaultValue)
      const now = norm(d.defaultValue)
      if (was !== now)
        columnChanges.push(alter(now ? `${col} SET DEFAULT ${now}` : `${col} DROP DEFAULT`))
    }

    // Nullability (an identity column is NOT NULL by itself).
    const wasNullable = orig.nullable
    const nowNullable = newIdentity ? false : d.nullable
    if (wasNullable !== nowNullable && !(!origIdentity && newIdentity)) {
      if (nowNullable) columnChanges.push(alter(`${col} DROP NOT NULL`))
      else {
        columnChanges.push(alter(`${col} SET NOT NULL`))
        risks.push(`El campo "${d.name}" pasa a NOT NULL; fallará si alguna fila tiene NULL`)
      }
    }
    if (norm(d.comment) !== norm(orig.comment))
      comments.push(commentOn(`COLUMN ${table}.${pgQuote(d.name)}`, d.comment))
  })

  /* Primary key */
  const basePk = base.columns.filter((c) => c.primaryKey).map((c) => c.originalName)
  const draftPk = draftColumns.filter((c) => c.primaryKey)
  if (
    !sameList(
      basePk as string[],
      draftPk.map((c) => c.originalName ?? c.name)
    )
  ) {
    if (basePk.length) {
      const name = primaryConstraintName(original)
      dropConstraints.push(alter(`DROP CONSTRAINT ${pgQuote(name)}`))
      risks.push('Se elimina o redefine la clave primaria')
      drops.push({ kind: 'PRIMARY KEY', name })
    }
    if (draftPk.length)
      addConstraints.push(
        alter(`ADD PRIMARY KEY (${draftPk.map((c) => pgQuote(c.name)).join(', ')})`)
      )
  }

  /* Unique / check / exclusion constraints */
  const baseConstraints = base.constraints ?? []
  const draftConstraints = (draft.constraints ?? []).filter((c) => c.definition.trim())
  for (const c of baseConstraints) {
    const kept = draftConstraints.find((d) => d.originalName === c.originalName)
    if (kept && norm(kept.definition) === norm(c.definition)) {
      if (kept.name && kept.name !== c.name)
        renames.push(alter(`RENAME CONSTRAINT ${pgQuote(c.name)} TO ${pgQuote(kept.name)}`))
      continue
    }
    dropConstraints.push(alter(`DROP CONSTRAINT ${pgQuote(c.name)}`))
    if (!kept) {
      risks.push(`Se elimina la restricción "${c.name}"`)
      drops.push({ kind: 'CONSTRAINT', name: c.name })
    }
  }
  for (const d of draftConstraints) {
    const orig = d.originalName
      ? baseConstraints.find((c) => c.originalName === d.originalName)
      : undefined
    if (orig && norm(orig.definition) === norm(d.definition)) continue
    addConstraints.push(
      alter(`ADD ${d.name ? `CONSTRAINT ${pgQuote(d.name)} ` : ''}${d.definition.trim()}`)
    )
  }

  /* Indexes (never the ones that back a constraint: base.indexes already excludes them) */
  for (const i of base.indexes) {
    const kept = draft.indexes.find((d) => d.originalName === i.originalName)
    if (kept && kept.name && kept.columns.length && sameIndexShape(kept, i)) {
      if (kept.name !== i.name)
        indexChanges.push(
          `ALTER INDEX ${pgQualified(schema, i.name)} RENAME TO ${pgQuote(kept.name)};`
        )
      if (norm(kept.comment) !== norm(i.comment))
        comments.push(commentOn(`INDEX ${pgQualified(schema, kept.name)}`, kept.comment))
      continue
    }
    dropIndexes.push(`DROP INDEX ${pgQualified(schema, i.name)};`)
    if (!kept) {
      risks.push(`Se elimina el índice "${i.name}"`)
      drops.push({ kind: 'INDEX', name: i.name })
    }
  }
  for (const d of draft.indexes.filter((i) => i.name && i.columns.length)) {
    const orig = d.originalName ? base.indexes.find((i) => i.originalName === d.originalName) : null
    if (orig && sameIndexShape(d, orig)) continue
    const info = orig ? original.indexes.find((i) => i.name === orig.name) : undefined
    const predicate = indexPredicate(info?.definition)
    if (predicate) risks.push(`El índice "${d.name}" se recrea con su condición${predicate}`)
    indexChanges.push(createIndex(d, table, finalNames, predicate))
    if (d.comment) comments.push(commentOn(`INDEX ${pgQualified(schema, d.name)}`, d.comment))
  }

  /* Foreign keys */
  for (const f of original.foreignKeys) {
    const kept = draft.foreignKeys.find((d) => d.originalName === f.name)
    if (kept && sameForeignKey(kept, f, schema)) continue
    dropFks.push(alter(`DROP CONSTRAINT ${pgQuote(f.name)}`))
    if (!kept) {
      risks.push(`Se elimina la clave foránea "${f.name}"`)
      drops.push({ kind: 'FOREIGN KEY', name: f.name })
    }
  }
  for (const d of draft.foreignKeys.filter((f) => f.name && f.columns.length)) {
    const orig = d.originalName
      ? original.foreignKeys.find((f) => f.name === d.originalName)
      : undefined
    if (orig && sameForeignKey(d, orig, schema)) continue
    addFks.push(alter(`ADD ${fkDefinition(d, schema)}`))
  }

  /* Table options */
  const baseOptions = base.options ?? {}
  const draftOptions = draft.options ?? {}
  if ((draftOptions.unlogged === true) !== (baseOptions.unlogged === true))
    options.push(alter(draftOptions.unlogged === true ? 'SET UNLOGGED' : 'SET LOGGED'))
  for (const [key, label] of [
    ['owner', 'el propietario'],
    ['tablespace', 'el tablespace'],
    ['partitionKey', 'la clave de partición']
  ] as const)
    if (
      key in draftOptions &&
      norm(optionText(draftOptions[key])) !== norm(optionText(baseOptions[key]))
    )
      problems.push(`No se puede cambiar ${label} desde el diseñador; usa SQL`)
  if (norm(draft.comment) !== norm(base.comment))
    comments.push(commentOn(`TABLE ${table}`, draft.comment))

  const statements = [
    ...dropFks,
    ...dropIndexes,
    ...dropConstraints,
    ...dropColumns,
    ...renames,
    ...columnChanges,
    ...addColumns,
    ...addConstraints,
    ...indexChanges,
    ...addFks,
    ...comments,
    ...options
  ]
  if (draft.name && draft.name !== original.name) {
    statements.push(alter(`RENAME TO ${pgQuote(draft.name)}`))
    risks.push(
      `Se renombra la tabla a "${draft.name}"; vistas, funciones y consultas que la usen por su nombre dejarán de funcionar`
    )
  }
  const pre = enumPreStatements(draft)
  return {
    statements,
    risks,
    problems,
    drops,
    transactional: true,
    ...(pre.length ? { preStatements: pre } : {})
  }
}

/**
 * PostgreSQL designer for the engine UI registry (`EngineUi.designer`, typed
 * there so this file stays free of view imports and the node tests can load it).
 */
export const pgTablePlanner = {
  emptyTable: pgEmptyTable,
  draftFromStructure: pgDraftFromStructure,
  buildCreate: pgBuildCreate,
  buildAlter: pgBuildAlter
}
