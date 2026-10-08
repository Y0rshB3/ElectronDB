import type { RoutineMeta, SchemaSnapshot, TableMeta } from './metadata'

/**
 * Compact, deterministic text of a schema for the model. Byte-stable for the
 * same structure (sorted, no timestamps, row counts rounded) so follow-up
 * questions reuse the provider's prompt cache. Built only from a
 * SchemaSnapshot, which holds structure, never rows.
 */

/** Default cap of the schema part of the context, in characters. */
export const DEFAULT_CONTEXT_CAP = 60_000

/** Rounds a row estimate to one significant digit ("~1k", "~30k") so stats churn keeps the text stable. */
export function roughRows(rows: number | null): string {
  if (rows === null || rows < 0) return ''
  if (rows < 10) return `~${rows}`
  const magnitude = 10 ** Math.floor(Math.log10(rows))
  const rounded = Math.round(rows / magnitude) * magnitude
  if (rounded >= 1_000_000_000) return `~${+(rounded / 1_000_000_000).toFixed(1)}G`
  if (rounded >= 1_000_000) return `~${+(rounded / 1_000_000).toFixed(1)}M`
  if (rounded >= 1_000) return `~${+(rounded / 1_000).toFixed(1)}k`
  return `~${rounded}`
}

const oneLine = (text: string, max = 120): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** `users ~1k filas: id int PK AI, email varchar(255) UQ, … | idx: … | FK person_id→person.id` */
export function formatTable(t: TableMeta, schema: string): string {
  const uniqueSingle = new Set(
    t.indexes
      .filter((i) => i.unique && i.name !== 'PRIMARY' && i.columns.length === 1)
      .map((i) => i.columns[0])
  )
  const cols = t.columns.map((c) => {
    const parts = [c.name, c.type]
    if (c.key === 'PRI') parts.push('PK')
    else if (uniqueSingle.has(c.name)) parts.push('UQ')
    if (/auto_increment/i.test(c.extra)) parts.push('AI')
    if (/generated/i.test(c.extra)) parts.push('GEN')
    let text = parts.join(' ') + (c.nullable ? '?' : '')
    if (c.comment) text += ` «${oneLine(c.comment, 80)}»`
    return text
  })
  const head =
    t.kind === 'view'
      ? `${t.name} (vista)`
      : `${t.name}${t.rows !== null ? ` ${roughRows(t.rows)} filas` : ''}`
  let line = `${head}: ${cols.join(', ')}`
  const pkCols = t.indexes.find((i) => i.name === 'PRIMARY')?.columns ?? []
  if (pkCols.length > 1) line += ` | PK(${pkCols.join(', ')})`
  const extraIdx = t.indexes.filter(
    (i) => i.name !== 'PRIMARY' && !(i.unique && i.columns.length === 1)
  )
  if (extraIdx.length)
    line += ` | idx: ${extraIdx.map((i) => `${i.unique ? 'UQ ' : ''}${i.name}(${i.columns.join(', ')})`).join('; ')}`
  if (t.foreignKeys.length)
    line += ` | FK ${t.foreignKeys
      .map((f) => {
        const ref =
          f.refSchema && f.refSchema !== schema ? `${f.refSchema}.${f.refTable}` : f.refTable
        return `${f.columns.join(',')}→${ref}.${f.refColumns.join(',')}`
      })
      .join('; ')}`
  if (t.comment) line += ` -- ${oneLine(t.comment)}`
  return line
}

export function formatRoutine(r: RoutineMeta): string {
  const sig = `${r.name}(${r.params.join(', ')})`
  return r.type === 'FUNCTION' ? `FUNCTION ${sig} RETURNS ${r.returns ?? '?'}` : `PROCEDURE ${sig}`
}

/** Identifiers mentioned in free text or SQL (words, `quoted`, schema.table). */
export function mentionedNames(...texts: (string | null | undefined)[]): Set<string> {
  const out = new Set<string>()
  for (const text of texts) {
    if (!text) continue
    for (const m of text.matchAll(/`([^`]+)`|([A-Za-z_][A-Za-z0-9_$]*)/g)) {
      const word = (m[1] ?? m[2]).toLowerCase()
      out.add(word)
      // singular/plural tolerance: "pedido" mentions "pedidos" and vice versa
      if (word.endsWith('s')) out.add(word.slice(0, -1))
      else out.add(`${word}s`)
    }
  }
  return out
}

export interface SchemaContextOptions {
  /** Max characters of the schema part. */
  cap?: number
  /** Text used to prioritise tables when the schema does not fit (question, editor SQL). */
  hints?: (string | null | undefined)[]
  /** Table of the open tab: always first when prioritising. */
  openTable?: string | null
}

export interface SchemaContext {
  text: string
  truncated: boolean
  tableCount: number
  /** Tables written with full structure. */
  detailed: string[]
}

/**
 * "(MySQL 8.4.3)", "(MariaDB 11.8.9)", "(PostgreSQL 17.2 …)": MySQL-family
 * snapshots carry a bare VERSION(); other engines name themselves.
 */
export function versionLabel(serverVersion: string): string {
  if (!serverVersion) return ''
  const maria = /^(?:5\.5\.5-)?(\d+\.\d+\.\d+)[^\s]*-MariaDB/i.exec(serverVersion)
  if (maria) return ` (MariaDB ${maria[1]})`
  // PostgreSQL's version() also names the build ("… on aarch64-unknown-linux-gnu, compiled by …").
  const pg = /^PostgreSQL \S+/.exec(serverVersion)
  if (pg) return ` (${pg[0]})`
  return ` (${/^\d/.test(serverVersion) ? 'MySQL ' : ''}${serverVersion})`
}

const LEGEND =
  'Leyenda: PK clave primaria, UQ única, AI auto_increment, GEN generada, ? admite NULL, ~N filas estimadas, «comentario».'

/**
 * Schema text. When everything fits under the cap it is the plain alphabetical
 * listing (stable across questions). Otherwise tables are ordered by priority
 * (open tab, tables named in the hints, their FK neighbours, then the rest
 * alphabetically) and the ones that do not fit are listed by name only, with a
 * pointer to the get_table_structure tool.
 */
export function buildSchemaContext(
  snap: SchemaSnapshot,
  options: SchemaContextOptions = {}
): SchemaContext {
  const header = [
    `Base de datos: ${snap.schema}${versionLabel(snap.serverVersion)}`,
    `Tablas y vistas: ${snap.tables.length}. ${LEGEND}`
  ]
  return layout(header, snap.tables, snap.routines.map(formatRoutine), snap.schema, options)
}

/** Max namespaces written with structure in a whole-connection context; the rest go by name. */
export const MAX_CONTEXT_DATABASES = 40

/**
 * Words of a whole-connection context, per engine: what the namespaces are
 * (MySQL/MariaDB/MongoDB databases, PostgreSQL schemas of one database, SQLite
 * main and its attachments) and how names are qualified.
 */
export interface ScopeWording {
  /** Start of the header: «Conexión completa», «Base de datos tienda completa»… */
  whole: string
  /** «bases de datos», «esquemas». */
  plural: string
  /** «Base de datos seleccionada», «Esquema seleccionado». */
  selected: string
  /** «base.tabla», «esquema.tabla», «base.colección». */
  qualified: string
  /** «Otras bases de datos», «Otros esquemas». */
  others: string
}

export const DATABASES_WORDING: ScopeWording = {
  whole: 'Conexión completa',
  plural: 'bases de datos',
  selected: 'Base de datos seleccionada',
  qualified: 'base.tabla',
  others: 'Otras bases de datos'
}

/**
 * Whole-connection text: every namespace's tables as `namespace.table` (FKs
 * too), so the model can write queries that cross them. Prioritised like
 * buildSchemaContext when over the cap, with the selected namespace's tables
 * ahead of the others'. `snaps` must be sorted by name.
 */
export function buildConnectionContext(
  snaps: SchemaSnapshot[],
  selected: string | null,
  options: SchemaContextOptions & { otherDatabases?: string[]; wording?: ScopeWording } = {}
): SchemaContext {
  const wording = options.wording ?? DATABASES_WORDING
  const version = snaps.find((s) => s.serverVersion)?.serverVersion ?? ''
  const tables: TableMeta[] = []
  const routines: string[] = []
  for (const snap of snaps) {
    for (const t of snap.tables)
      tables.push({
        ...t,
        name: `${snap.schema}.${t.name}`,
        foreignKeys: t.foreignKeys.map((f) => ({
          ...f,
          refTable: `${f.refSchema || snap.schema}.${f.refTable}`,
          refSchema: ''
        }))
      })
    for (const r of snap.routines)
      routines.push(formatRoutine({ ...r, name: `${snap.schema}.${r.name}` }))
  }
  const names = snaps.map((s) => s.schema)
  const header = [
    `${wording.whole}${versionLabel(version)}: ${names.length} ${wording.plural} (${names.join(', ') || '—'}).${selected ? ` ${wording.selected}: ${selected}.` : ''}`,
    `Tablas y vistas: ${tables.length}, escritas como ${wording.qualified}. ${LEGEND}`
  ]
  if (options.otherDatabases?.length)
    header.push(
      `${wording.others} (solo el nombre; pide su estructura con get_table_structure): ${options.otherDatabases.join(', ')}`
    )
  return layout(header, tables, routines, '', {
    ...options,
    openTable: options.openTable && selected ? `${selected}.${options.openTable}` : null,
    preferred: selected ? `${selected.toLowerCase()}.` : null
  })
}

/** Lower-case name and, for `database.table`, the database and the bare table name. */
function nameParts(name: string): { full: string; db: string | null; bare: string } {
  const full = name.toLowerCase()
  const dot = full.indexOf('.')
  return dot < 0
    ? { full, db: null, bare: full }
    : { full, db: full.slice(0, dot), bare: full.slice(dot + 1) }
}

function layout(
  header: string[],
  tables: TableMeta[],
  routines: string[],
  schema: string,
  options: SchemaContextOptions & { preferred?: string | null }
): SchemaContext {
  const cap = options.cap ?? DEFAULT_CONTEXT_CAP
  const lines = tables.map((t) => ({ name: t.name, line: formatTable(t, schema) }))
  const routineBlock = routines.length ? ['', 'Rutinas:', ...routines] : []
  const full = [...header, '', ...lines.map((l) => l.line), ...routineBlock].join('\n')
  if (full.length <= cap)
    return {
      text: full,
      truncated: false,
      tableCount: tables.length,
      detailed: lines.map((l) => l.name)
    }

  // Does not fit: prioritise.
  const mentioned = mentionedNames(...(options.hints ?? []))
  const open = options.openTable?.toLowerCase() ?? null
  const rank = new Map<string, number>()
  for (const t of tables) {
    const { full: lower, db, bare } = nameParts(t.name)
    if (open && lower === open) rank.set(t.name, 0)
    else if (mentioned.has(lower) || mentioned.has(bare)) rank.set(t.name, 1)
    else if (db && mentioned.has(db)) rank.set(t.name, 2)
  }
  for (const t of tables) {
    if (rank.has(t.name)) continue
    const linked =
      t.foreignKeys.some((f) => (rank.get(f.refTable) ?? 9) <= 1) ||
      tables.some(
        (o) => (rank.get(o.name) ?? 9) <= 1 && o.foreignKeys.some((f) => f.refTable === t.name)
      )
    if (linked) rank.set(t.name, 2)
  }
  const preferred = options.preferred ?? null
  const fallback = (name: string): number =>
    preferred && name.toLowerCase().startsWith(preferred) ? 3 : 4
  const ordered = [...lines].sort((a, b) => {
    const ra = rank.get(a.name) ?? fallback(a.name)
    const rb = rank.get(b.name) ?? fallback(b.name)
    return ra - rb || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  })

  const tail = (rest: string[]): string[] =>
    rest.length
      ? [
          '',
          `Otras ${rest.length} tablas (solo el nombre; pide su estructura con la herramienta get_table_structure):`,
          rest.join(', ')
        ]
      : []
  const budget = cap - header.join('\n').length - 400
  const detailed: string[] = []
  const rest: string[] = []
  let used = 0
  for (const l of ordered) {
    if (used + l.line.length + 1 <= budget * 0.85) {
      detailed.push(l.line)
      used += l.line.length + 1
    } else rest.push(l.name)
  }
  let restText = tail(rest)
  // Even the name list can be too long for huge schemas: cut it and say so.
  const restBudget = Math.max(0, cap - header.join('\n').length - used - 200)
  if (restText.join('\n').length > restBudget) {
    const kept: string[] = []
    let len = 0
    for (const name of rest) {
      if (len + name.length + 2 > restBudget - 120) break
      kept.push(name)
      len += name.length + 2
    }
    restText = [
      '',
      `Otras ${rest.length} tablas (se muestran ${kept.length}; pide su estructura con get_table_structure):`,
      kept.join(', ')
    ]
  }
  const text = [...header, '', ...detailed, ...restText].join('\n')
  return {
    text,
    truncated: true,
    tableCount: tables.length,
    detailed: ordered.slice(0, detailed.length).map((l) => l.name)
  }
}

/**
 * Memory notes block (connection, then each database in order). Empty notes
 * are omitted. `databaseNotes` is a single database's notes or a list of them.
 */
export function buildMemoryBlock(
  connectionNotes: string,
  databaseNotes: string | { schema: string; notes: string }[],
  schema: string | null = null
): string {
  const perDatabase =
    typeof databaseNotes === 'string'
      ? schema
        ? [{ schema, notes: databaseNotes }]
        : []
      : databaseNotes
  const parts: string[] = []
  if (connectionNotes.trim())
    parts.push(`Notas del usuario sobre esta conexión:\n${connectionNotes.trim()}`)
  for (const d of perDatabase)
    if (d.notes.trim())
      parts.push(`Notas del usuario sobre la base de datos ${d.schema}:\n${d.notes.trim()}`)
  return parts.join('\n\n')
}
