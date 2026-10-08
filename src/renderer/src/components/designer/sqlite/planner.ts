/**
 * SQLite table designer planner (docs/multi-engine-design.md, section 8.1).
 *
 * In place when SQLite's ALTER TABLE can do it (RENAME TO, RENAME COLUMN,
 * ADD COLUMN, DROP COLUMN) plus CREATE/DROP INDEX; everything else rebuilds the
 * table (src/shared/sqlite/rebuild.ts), and the plan says why.
 *
 * The new CREATE TABLE keeps what the draft does not model: each column is
 * rebuilt from its ORIGINAL definition (parseCreateTable), regenerating only
 * what the draft changed (type, NOT NULL, DEFAULT, PRIMARY KEY) and carrying
 * COLLATE, CHECK, UNIQUE and GENERATED clauses verbatim; table CHECK/UNIQUE
 * constraints are kept as written. Renamed columns are renamed inside the
 * carried text (token level). Foreign keys are regenerated from the draft as
 * table constraints. A carried constraint that uses a dropped column blocks
 * the plan.
 *
 * Defaults are SQL expressions, as SQLite reports them ('x', 0, CURRENT_TIMESTAMP).
 */
import { SQLITE_KEYWORDS, quoteIdent } from '@shared/dialects/sqlite'
import { sqliteCodeTokens, tokenizeSqlite } from '@shared/dialects/sqliteLexer'
import {
  collationOf,
  parseCreateTable,
  type ParsedColumn,
  type ParsedCreateTable
} from '@shared/sqlite/createTable'
import type {
  ForeignKeyInfo,
  IndexInfo,
  SqliteAlterRequest,
  SqliteRebuildDefinition,
  TableStructure
} from '@shared/types'
import type { DesignerAlter, DesignerDrop } from '@renderer/components/designer/alterTable'
import {
  emptyColumn,
  nextId,
  type ColumnDraft,
  type ForeignKeyDraft,
  type IndexDraft,
  type TableDraft
} from '@renderer/utils/tableDesigner'

/** Plan of a SQLite designer change: what the view previews and sends to sqlite:alterTable. */
export interface SqliteDesignerAlter extends DesignerAlter {
  /** Request for sqlite:alterTable (null when nothing changes or the plan has problems). */
  request: SqliteAlterRequest | null
  /** The table is rebuilt (12-step procedure): why. */
  rebuild?: { reason: string }
}

/** Types offered in the designer (free text: SQLite accepts any declared type). */
export const SQLITE_TYPES = [
  'INTEGER',
  'TEXT',
  'REAL',
  'BLOB',
  'NUMERIC',
  'BOOLEAN',
  'DATE',
  'DATETIME',
  'VARCHAR(255)',
  'DECIMAL(10,2)',
  'JSON',
  'ANY'
]

const q = (name: string): string => quoteIdent(name)
const qq = (schema: string, name: string): string =>
  `${quoteIdent(schema, true)}.${quoteIdent(name)}`

/* ---------- draft ---------- */

export function sqliteEmptyTable(): TableDraft {
  return {
    name: '',
    engine: '',
    collation: '',
    comment: '',
    autoIncrement: null,
    columns: [],
    indexes: [],
    foreignKeys: [],
    options: { withoutRowid: false, strict: false }
  }
}

/** A new table with an `id INTEGER PRIMARY KEY` (the rowid), ready to edit. */
export function sqliteNewTableDraft(): TableDraft {
  const id: ColumnDraft = {
    ...emptyColumn(),
    name: 'id',
    columnType: 'INTEGER',
    nullable: false,
    primaryKey: true
  }
  return { ...sqliteEmptyTable(), columns: [id] }
}

export function sqliteEmptyColumn(): ColumnDraft {
  return { ...emptyColumn(), columnType: 'TEXT' }
}

const isPrimaryIndex = (i: IndexInfo): boolean => i.primary === true

export function sqliteDraftFromStructure(structure: TableStructure): TableDraft {
  const parsed = parseCreateTable(structure.createSql)
  const primary = new Set(structure.indexes.find(isPrimaryIndex)?.columns ?? [])
  const parsedOf = (name: string): ParsedColumn | undefined =>
    parsed.columns.find((c) => c.name.toLowerCase() === name.toLowerCase())
  return {
    name: structure.name,
    engine: '',
    collation: '',
    comment: '',
    autoIncrement: null,
    columns: structure.columns.map((c): ColumnDraft => ({
      id: nextId(),
      originalName: c.name,
      name: c.name,
      columnType: c.columnType,
      nullable: c.nullable,
      defaultValue: c.generated ? null : c.defaultValue,
      // On SQLite the checkbox means the AUTOINCREMENT keyword (any INTEGER PRIMARY KEY is the rowid).
      autoIncrement: c.extra === 'AUTOINCREMENT',
      primaryKey: primary.has(c.name) || c.primaryKey === true,
      unsigned: false,
      collation: collationOf(parsedOf(c.name)) || null,
      comment: ''
    })),
    // Indexes of UNIQUE / PRIMARY KEY constraints belong to the table definition.
    indexes: structure.indexes
      .filter((i) => !isPrimaryIndex(i) && !i.constraint)
      .map((i) => ({
        id: nextId(),
        originalName: i.name,
        name: i.name,
        unique: i.unique,
        type: 'INDEX',
        columns: [...i.columns],
        comment: ''
      })),
    foreignKeys: structure.foreignKeys.map((f) => ({
      id: nextId(),
      originalName: f.name,
      ...f,
      columns: [...f.columns],
      referencedColumns: [...f.referencedColumns]
    })),
    options: {
      withoutRowid: structure.options?.withoutRowid === true,
      strict: structure.options?.strict === true
    }
  }
}

/* ---------- pieces ---------- */

const flag = (d: TableDraft, key: 'withoutRowid' | 'strict'): boolean => d.options?.[key] === true

function tableTail(d: TableDraft): string {
  const opts = [flag(d, 'withoutRowid') ? 'WITHOUT ROWID' : '', flag(d, 'strict') ? 'STRICT' : '']
  const list = opts.filter(Boolean)
  return list.length ? ` ${list.join(', ')}` : ''
}

const isIntegerPk = (d: TableDraft, c: ColumnDraft): boolean =>
  !flag(d, 'withoutRowid') &&
  c.primaryKey &&
  d.columns.filter((x) => x.primaryKey).length === 1 &&
  c.columnType.trim().toUpperCase() === 'INTEGER'

const fkAction = (a: string | null | undefined): string => (a || 'NO ACTION').toUpperCase().trim()

function fkDefinition(f: ForeignKeyDraft, named: boolean): string {
  const parts = [
    named && f.name ? `CONSTRAINT ${q(f.name)} ` : '',
    `FOREIGN KEY (${f.columns.map(q).join(', ')}) REFERENCES ${q(f.referencedTable)}`,
    f.referencedColumns.length ? ` (${f.referencedColumns.map(q).join(', ')})` : ''
  ]
  if (fkAction(f.onUpdate) !== 'NO ACTION') parts.push(` ON UPDATE ${fkAction(f.onUpdate)}`)
  if (fkAction(f.onDelete) !== 'NO ACTION') parts.push(` ON DELETE ${fkAction(f.onDelete)}`)
  return parts.join('')
}

/** `PRIMARY KEY [AUTOINCREMENT]` clause of a single-column key. */
function pkClauseOf(d: TableDraft, c: ColumnDraft): string {
  return `PRIMARY KEY${c.autoIncrement && isIntegerPk(d, c) ? ' AUTOINCREMENT' : ''}`
}

/**
 * Column definition from the draft: name, type, the given PRIMARY KEY clause,
 * NOT NULL, DEFAULT, COLLATE, then `carried` clauses (kept as written).
 */
function generatedDefinition(
  d: TableDraft,
  c: ColumnDraft,
  pkClause: string | null,
  carried: string[] = []
): string {
  const parts = [q(c.name)]
  if (c.columnType.trim()) parts.push(c.columnType.trim())
  if (pkClause) parts.push(pkClause)
  if (!c.nullable && !(pkClause && isIntegerPk(d, c))) parts.push('NOT NULL')
  if (c.defaultValue !== null && c.defaultValue !== '')
    parts.push(`DEFAULT ${defaultSql(c.defaultValue)}`)
  if (c.collation && !carried.some((x) => /^COLLATE\b/i.test(x)))
    parts.push(`COLLATE ${c.collation}`)
  parts.push(...carried)
  return parts.join(' ')
}

/**
 * DEFAULT expression: literals and keywords as written; anything else that is
 * not a single token gets parentheses (SQLite requires them for expressions).
 */
export function defaultSql(value: string): string {
  const v = value.trim()
  if (/^\(.*\)$/s.test(v)) return v
  if (/^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(v)) return v
  if (/^'([^']|'')*'$/.test(v) || /^[xX]'[0-9a-fA-F]*'$/.test(v)) return v
  if (/^(NULL|TRUE|FALSE|CURRENT_TIME|CURRENT_DATE|CURRENT_TIMESTAMP)$/i.test(v)) return v
  return `(${v})`
}

/** Replaces identifiers (renamed columns, the table) inside carried SQL text, token by token. */
export function renameIdentifiers(sql: string, renames: Map<string, string>): string {
  if (!renames.size) return sql
  const tokens = sqliteCodeTokens(tokenizeSqlite(sql))
  let out = ''
  let pos = 0
  for (const t of tokens) {
    if (t.kind !== 'word' && t.kind !== 'ident') continue
    const to = renames.get(t.value.toLowerCase())
    if (to === undefined) continue
    if (t.kind === 'word' && SQLITE_KEYWORDS.has(t.value.toLowerCase())) continue
    out += sql.slice(pos, t.start) + q(to)
    pos = t.end
  }
  return out + sql.slice(pos)
}

/** Identifiers of `sql` (lower-case) that name one of `columns`. */
function usedColumns(sql: string, columns: Set<string>): string[] {
  const found = new Set<string>()
  for (const t of sqliteCodeTokens(tokenizeSqlite(sql)))
    if ((t.kind === 'word' || t.kind === 'ident') && columns.has(t.value.toLowerCase()))
      found.add(t.value)
  return [...found]
}

function createIndexSql(schema: string, table: string, i: IndexDraft): string {
  return `CREATE ${i.unique ? 'UNIQUE ' : ''}INDEX ${qq(schema, i.name)} ON ${q(table)} (${i.columns.map(q).join(', ')})`
}

const sameList = (a: string[], b: string[]): boolean =>
  a.map((x) => x.toLowerCase()).join('\u0000') === b.map((x) => x.toLowerCase()).join('\u0000')

function sameIndex(a: IndexDraft, b: IndexDraft): boolean {
  return a.name === b.name && a.unique === b.unique && sameList(a.columns, b.columns)
}

function sameFk(a: ForeignKeyDraft, b: ForeignKeyDraft): boolean {
  return (
    sameList(a.columns, b.columns) &&
    a.referencedTable.toLowerCase() === b.referencedTable.toLowerCase() &&
    sameList(a.referencedColumns, b.referencedColumns) &&
    fkAction(a.onUpdate) === fkAction(b.onUpdate) &&
    fkAction(a.onDelete) === fkAction(b.onDelete)
  )
}

const norm = (v: string | null | undefined): string => (v ?? '').trim()

/** The column's definition changed (type, NULL, default, key, AUTOINCREMENT, collation). */
function columnChanged(a: ColumnDraft, b: ColumnDraft): boolean {
  return (
    norm(a.columnType) !== norm(b.columnType) ||
    a.nullable !== b.nullable ||
    norm(a.defaultValue) !== norm(b.defaultValue) ||
    a.primaryKey !== b.primaryKey ||
    a.autoIncrement !== b.autoIncrement ||
    norm(a.collation) !== norm(b.collation)
  )
}

function columnProblems(d: TableDraft, problems: string[]): void {
  for (const c of d.columns)
    if (c.autoIncrement && !isIntegerPk(d, c))
      problems.push(
        `AUTOINCREMENT solo se puede usar en una única clave primaria INTEGER de una tabla con rowid («${c.name}»).`
      )
}

/* ---------- CREATE ---------- */

export function sqliteBuildCreatePlan(schema: string, draft: TableDraft): SqliteDesignerAlter {
  const problems: string[] = []
  columnProblems(draft, problems)
  const columns = draft.columns.filter((c) => c.name)
  const pk = columns.filter((c) => c.primaryKey)
  const inline = pk.length === 1
  const lines = columns.map((c) =>
    generatedDefinition(draft, c, inline && c.primaryKey ? pkClauseOf(draft, c) : null)
  )
  if (pk.length > 1) lines.push(`PRIMARY KEY (${pk.map((c) => q(c.name)).join(', ')})`)
  for (const f of draft.foreignKeys.filter((f) => f.columns.length && f.referencedTable))
    lines.push(fkDefinition(f, true))
  if (flag(draft, 'withoutRowid') && !pk.length)
    problems.push('Una tabla WITHOUT ROWID necesita una clave primaria.')
  const statements = [
    `CREATE TABLE ${qq(schema, draft.name)} (\n${lines.map((l) => `  ${l}`).join(',\n')}\n)${tableTail(draft)}`
  ]
  for (const i of draft.indexes.filter((i) => i.name && i.columns.length))
    statements.push(createIndexSql(schema, draft.name, i))
  return {
    statements,
    risks: [],
    problems,
    drops: [],
    transactional: true,
    request: problems.length
      ? null
      : { table: null, newName: draft.name, statements, rebuild: null }
  }
}

export function sqliteBuildCreate(schema: string, draft: TableDraft): string {
  return sqliteBuildCreatePlan(schema, draft)
    .statements.map((s) => `${s};`)
    .join('\n')
}

/* ---------- ALTER ---------- */

interface Diff {
  base: TableDraft
  parsed: ParsedCreateTable
  dropped: ColumnDraft[]
  added: ColumnDraft[]
  renamed: Map<string, string>
  changed: ColumnDraft[]
  reordered: boolean
  pkChanged: boolean
  autoIncrementChanged: boolean
  fkChanged: boolean
  optionsChanged: boolean
}

/** ADD COLUMN appends: new columns placed before existing ones need a rebuild. */
function newColumnsAtEnd(draft: TableDraft): boolean {
  const first = draft.columns.findIndex((c) => !c.originalName)
  return first < 0 || draft.columns.slice(first).every((c) => !c.originalName)
}

function diff(original: TableStructure, draft: TableDraft): Diff {
  const base = sqliteDraftFromStructure(original)
  const byOrig = new Map(base.columns.map((c) => [c.originalName!, c]))
  const kept = draft.columns.filter((c) => c.originalName && byOrig.has(c.originalName))
  const renamed = new Map<string, string>()
  for (const c of kept)
    if (c.name !== c.originalName) renamed.set(c.originalName!.toLowerCase(), c.name)
  const keptNames = new Set(kept.map((c) => c.originalName))
  const before = base.columns.map((c) => c.originalName!).filter((n) => keptNames.has(n))
  const after = kept.map((c) => c.originalName!)
  const basePk = base.columns.filter((c) => c.primaryKey).map((c) => c.originalName!)
  const draftPk = draft.columns
    .filter((c) => c.primaryKey)
    .map((c) => c.originalName ?? `\u0000${c.name}`)
  const fkChanged =
    base.foreignKeys.length !== draft.foreignKeys.length ||
    draft.foreignKeys.some((f) => {
      const orig = base.foreignKeys.find((b) => b.originalName === f.originalName && f.originalName)
      return !orig || !sameFk(f, orig) || f.name !== orig.name
    })
  return {
    base,
    parsed: parseCreateTable(original.createSql),
    dropped: base.columns.filter(
      (c) => !draft.columns.some((d) => d.originalName === c.originalName)
    ),
    added: draft.columns.filter((c) => !c.originalName || !byOrig.has(c.originalName)),
    renamed,
    changed: kept.filter((c) => columnChanged(c, byOrig.get(c.originalName!)!)),
    reordered: !sameList(before, after) || !newColumnsAtEnd(draft),
    pkChanged: !sameList(basePk, draftPk),
    autoIncrementChanged: kept.some(
      (c) => c.autoIncrement !== byOrig.get(c.originalName!)!.autoIncrement
    ),
    fkChanged,
    optionsChanged:
      flag(base, 'withoutRowid') !== flag(draft, 'withoutRowid') ||
      flag(base, 'strict') !== flag(draft, 'strict')
  }
}

/** Why the change cannot be done in place, or null. */
function rebuildReason(dd: Diff, original: TableStructure): string | null {
  if (dd.optionsChanged) return 'cambia WITHOUT ROWID o STRICT'
  if (dd.pkChanged || dd.autoIncrementChanged) return 'cambia la clave primaria'
  if (dd.fkChanged) return 'cambian las claves foráneas'
  if (dd.changed.length)
    return `cambia la definición de ${dd.changed.map((c) => `«${c.name}»`).join(', ')}: tipo, nulos o valor predeterminado`
  if (dd.reordered) return 'cambia el orden de las columnas'
  for (const c of dd.added) {
    if (c.primaryKey) return `la columna nueva «${c.name}» es clave primaria`
    if (!c.nullable && (c.defaultValue === null || /^null$/i.test(norm(c.defaultValue))))
      return `la columna nueva «${c.name}» es NOT NULL sin valor predeterminado`
    if (c.defaultValue !== null && defaultSql(c.defaultValue).startsWith('('))
      return `el valor predeterminado de «${c.name}» no es constante`
  }
  const indexed = new Set(original.indexes.flatMap((i) => i.columns.map((n) => n.toLowerCase())))
  const inFk = new Set(original.foreignKeys.flatMap((f) => f.columns.map((n) => n.toLowerCase())))
  const constraintText = [
    ...dd.parsed.constraints.map((t) => t.text),
    ...dd.parsed.columns.flatMap((c) => c.clauses.map((x) => x.text))
  ].join(' ')
  for (const c of dd.dropped) {
    const n = c.originalName!.toLowerCase()
    if (c.primaryKey) return `se elimina la clave primaria «${c.name}»`
    if (indexed.has(n)) return `«${c.name}» está en un índice o una restricción UNIQUE`
    if (inFk.has(n)) return `«${c.name}» está en una clave foránea`
    if (usedColumns(constraintText, new Set([n])).length)
      return `«${c.name}» se usa en una restricción o columna generada`
  }
  return null
}

export function sqliteBuildAlter(original: TableStructure, draft: TableDraft): SqliteDesignerAlter {
  const schema = original.schema
  const dd = diff(original, draft)
  const risks: string[] = []
  const problems: string[] = []
  const drops: DesignerDrop[] = []
  columnProblems(draft, problems)
  if (original.options?.virtual === true)
    problems.push('Las tablas virtuales no se pueden modificar con el diseñador.')
  if (flag(draft, 'withoutRowid') && !draft.columns.some((c) => c.primaryKey))
    problems.push('Una tabla WITHOUT ROWID necesita una clave primaria.')

  for (const c of dd.dropped) {
    drops.push({ kind: 'COLUMN', name: c.name })
    risks.push(`Se elimina la columna «${c.name}» y sus datos`)
  }
  for (const [from, to] of dd.renamed) risks.push(`Se renombra la columna «${from}» a «${to}»`)

  // Index changes are always separate statements (also after a rebuild).
  const baseIdx = dd.base.indexes
  const dropIndexes: string[] = []
  const createIndexes: IndexDraft[] = []
  const droppedNames = new Set(dd.dropped.map((c) => c.originalName!.toLowerCase()))
  for (const i of baseIdx) {
    const kept = draft.indexes.find((d) => d.originalName === i.originalName)
    if (!kept || !sameIndex(kept, i)) {
      dropIndexes.push(`DROP INDEX ${qq(schema, i.name)}`)
      if (!kept) drops.push({ kind: 'INDEX', name: i.name })
    }
  }
  for (const i of draft.indexes.filter((i) => i.name && i.columns.length)) {
    const orig = i.originalName ? baseIdx.find((b) => b.originalName === i.originalName) : undefined
    if (!orig || !sameIndex(i, orig)) createIndexes.push(i)
    for (const col of i.columns)
      if (droppedNames.has(col.toLowerCase()))
        problems.push(
          `El índice «${i.name}» usa la columna eliminada «${col}»: quítala del índice.`
        )
  }
  for (const f of draft.foreignKeys)
    for (const col of f.columns)
      if (droppedNames.has(col.toLowerCase()))
        problems.push(`La clave foránea «${f.name}» usa la columna eliminada «${col}».`)
  for (const f of dd.base.foreignKeys)
    if (!draft.foreignKeys.some((d) => d.originalName === f.originalName))
      drops.push({ kind: 'FOREIGN KEY', name: f.name })

  const tableRenamed = draft.name !== original.name && !!draft.name
  const finalName = draft.name || original.name
  const reason = rebuildReason(dd, original)

  const empty: SqliteDesignerAlter = {
    statements: [],
    risks,
    problems,
    drops,
    transactional: true,
    request: null
  }

  if (!reason) {
    const statements: string[] = []
    if (tableRenamed) {
      statements.push(`ALTER TABLE ${qq(schema, original.name)} RENAME TO ${q(draft.name)}`)
      risks.push(`Se renombra la tabla a «${draft.name}»`)
    }
    const target = qq(schema, finalName)
    for (const [from, to] of dd.renamed)
      statements.push(`ALTER TABLE ${target} RENAME COLUMN ${q(from)} TO ${q(to)}`)
    statements.push(...dropIndexes)
    for (const c of dd.dropped)
      statements.push(`ALTER TABLE ${target} DROP COLUMN ${q(c.originalName!)}`)
    for (const c of dd.added)
      statements.push(`ALTER TABLE ${target} ADD COLUMN ${generatedDefinition(draft, c, null)}`)
    for (const i of createIndexes) statements.push(createIndexSql(schema, finalName, i))
    if (!statements.length) return empty
    return {
      ...empty,
      statements,
      request: problems.length
        ? null
        : { table: original.name, newName: finalName, statements, rebuild: null }
    }
  }

  // ---------- rebuild ----------
  if (!dd.parsed.parsed)
    problems.push(
      'No se pudo leer la definición original de la tabla (CREATE TABLE): no se puede reconstruir.'
    )
  risks.unshift(
    `La tabla se reconstruirá: ${reason}. Se copian los datos, los índices, los triggers y las vistas que dependen de ella`
  )
  const definition = rebuildDefinition(original, draft, dd, finalName, problems)
  const inPlace = tableRenamed
    ? [`ALTER TABLE ${qq(schema, original.name)} RENAME TO ${q(draft.name)}`]
    : []
  if (tableRenamed) risks.push(`Se renombra la tabla a «${draft.name}»`)
  for (const c of dd.changed) {
    const before = dd.base.columns.find((b) => b.originalName === c.originalName)!
    if (before.nullable && !c.nullable)
      risks.push(`«${c.name}» pasa a NOT NULL: la reconstrucción falla si hay filas con NULL`)
    if (norm(before.columnType) !== norm(c.columnType))
      risks.push(
        `«${c.name}» cambia de tipo (${before.columnType || 'sin tipo'} → ${c.columnType || 'sin tipo'})`
      )
  }
  return {
    statements: [...inPlace, '-- reconstrucción', `CREATE TABLE … ${definition.createBody}`],
    risks,
    problems,
    drops,
    transactional: true,
    rebuild: { reason },
    request: problems.length
      ? null
      : { table: original.name, newName: finalName, statements: inPlace, rebuild: definition }
  }
}

function rebuildDefinition(
  original: TableStructure,
  draft: TableDraft,
  dd: Diff,
  finalName: string,
  problems: string[]
): SqliteRebuildDefinition {
  const schema = original.schema
  const renames = dd.renamed
  const droppedNames = new Set(dd.dropped.map((c) => c.originalName!.toLowerCase()))
  const pkRegen = dd.pkChanged || dd.autoIncrementChanged
  const draftPk = draft.columns.filter((c) => c.primaryKey)
  const inlinePk = draftPk.length === 1
  const parsedOf = (name: string): ParsedColumn | undefined =>
    dd.parsed.columns.find((c) => c.name.toLowerCase() === name.toLowerCase())
  const baseOf = (name: string): ColumnDraft | undefined =>
    dd.base.columns.find((c) => c.originalName === name)
  const carriedCheck = (text: string, where: string): string => {
    const used = usedColumns(text, droppedNames)
    if (used.length)
      problems.push(`${where} usa la columna eliminada «${used[0]}»: no se puede conservar.`)
    return renameIdentifiers(text, renames)
  }

  const lines: string[] = []
  const columnMap: { target: string; source: string }[] = []
  for (const c of draft.columns.filter((x) => x.name)) {
    const parsed = c.originalName ? parsedOf(c.originalName) : undefined
    const before = c.originalName ? baseOf(c.originalName) : undefined
    const regenPk = inlinePk && c.primaryKey ? pkClauseOf(draft, c) : null
    if (!parsed || !before) {
      lines.push(generatedDefinition(draft, c, regenPk))
      continue
    }
    const modified = columnChanged(c, before)
    const isGenerated = parsed.clauses.some((x) => x.kind === 'generated')
    if (!isGenerated) columnMap.push({ target: c.name, source: c.originalName! })
    const keep = parsed.clauses.filter((x) => {
      if (x.kind === 'references') return false
      if (x.kind === 'primary') return !pkRegen
      if (modified && (x.kind === 'notnull' || x.kind === 'null' || x.kind === 'default'))
        return false
      if (modified && x.kind === 'collate' && norm(c.collation) !== norm(before.collation))
        return false
      return true
    })
    const carried = keep.map((x) => carriedCheck(x.text, `Una restricción de «${c.name}»`))
    if (!modified) {
      // Unchanged column: its original text; a regenerated key clause after the type.
      const pk = pkRegen && regenPk ? [regenPk] : []
      lines.push([q(c.name), parsed.type, ...pk, ...carried].filter(Boolean).join(' '))
      continue
    }
    // Changed column: draft's type/NULL/DEFAULT; the original key clause stays as written.
    const pkAt = keep.findIndex((x) => x.kind === 'primary')
    const pkClause = pkAt >= 0 ? carried[pkAt] : pkRegen ? regenPk : null
    lines.push(
      generatedDefinition(
        draft,
        c,
        pkClause,
        carried.filter((_, i) => i !== pkAt)
      )
    )
  }
  if (pkRegen && draftPk.length > 1)
    lines.push(`PRIMARY KEY (${draftPk.map((c) => q(c.name)).join(', ')})`)
  for (const t of dd.parsed.constraints) {
    if (t.kind === 'foreign') continue
    if (t.kind === 'primary' && pkRegen) continue
    lines.push(
      carriedCheck(t.text, `La restricción ${t.name ? `«${t.name}»` : t.kind.toUpperCase()}`)
    )
  }
  const realFkNames = new Set<string>()
  for (const c of dd.parsed.columns)
    for (const x of c.clauses) if (x.kind === 'references' && x.name) realFkNames.add(x.name)
  for (const t of dd.parsed.constraints) if (t.kind === 'foreign' && t.name) realFkNames.add(t.name)
  for (const f of draft.foreignKeys.filter((f) => f.columns.length && f.referencedTable)) {
    const named = !f.originalName || realFkNames.has(f.name) || f.name !== f.originalName
    lines.push(fkDefinition(f, named))
  }

  // Indexes of the final table: unchanged ones keep their original SQL (partial, expressions).
  const indexes: string[] = []
  const tableRenames = new Map(renames)
  tableRenames.set(original.name.toLowerCase(), finalName)
  for (const i of draft.indexes.filter((x) => x.name && x.columns.length)) {
    const orig = original.indexes.find((o) => o.name === i.originalName)
    const base = dd.base.indexes.find((b) => b.originalName === i.originalName)
    if (orig?.definition && base && sameIndex(i, base))
      indexes.push(renameIdentifiers(orig.definition, tableRenames))
    else indexes.push(createIndexSql(schema, finalName, i))
  }
  const newIntegerPk = draft.columns.some((c) => isIntegerPk(draft, c))
  return {
    createBody: `(\n${lines.map((l) => `  ${l}`).join(',\n')}\n)${tableTail(draft)}`,
    columnMap,
    keepRowid:
      original.options?.withoutRowid !== true && !flag(draft, 'withoutRowid') && !newIntegerPk,
    indexes,
    autoincrement: draft.columns.some((c) => c.autoIncrement && isIntegerPk(draft, c))
  }
}

/** Foreign keys of a structure as drafts (tests). */
export function fkDrafts(list: ForeignKeyInfo[]): ForeignKeyDraft[] {
  return list.map((f) => ({ id: nextId(), originalName: f.name, ...f }))
}

/**
 * SQLite designer for the engine UI registry (`EngineUi.designer`). buildCreate
 * returns the statements as one script; the view sends the plan's `request`.
 */
export const sqliteTablePlanner = {
  emptyTable: sqliteEmptyTable,
  draftFromStructure: sqliteDraftFromStructure,
  buildCreate: sqliteBuildCreate,
  buildAlter: sqliteBuildAlter
}
