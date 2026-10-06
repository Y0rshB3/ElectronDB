import type { ColumnInfo, TableStructure } from '@shared/types'
import { quoteIdent, quoteString } from '@renderer/utils/sql'
import {
  buildAlterTable,
  draftFromStructure,
  type ColumnDraft,
  type TableDraft
} from '@renderer/utils/tableDesigner'

/**
 * Column-aware ALTER TABLE builder for the designer.
 *
 * `utils/tableDesigner.buildAlterTable` rebuilds every touched column from
 * ColumnDraft, which cannot represent expression defaults, ON UPDATE clauses,
 * generated columns, INVISIBLE or SRID. Re-emitting such a column (because it
 * was edited or merely shifted by an insert/move) silently drops those
 * attributes. Here the column clauses are produced from the original
 * SHOW CREATE TABLE definition instead, and the index / foreign key / option /
 * rename parts are still delegated to the shared util.
 */

export interface DesignerAlter {
  statements: string[]
  /** Changes that may lose data or break dependants; the view always asks before applying them. */
  risks: string[]
  /** Changes that cannot be expressed safely; saving is refused while any is present. */
  problems: string[]
  /** Columns, keys and indexes removed for good (a changed index that is re-added is not listed). */
  drops: DesignerDrop[]
}

export interface DesignerDrop {
  kind: 'COLUMN' | 'PRIMARY KEY' | 'INDEX' | 'FOREIGN KEY'
  name: string
}

interface ParsedDefinition {
  /** Everything after the column name, verbatim from SHOW CREATE TABLE. */
  raw: string
  defaultClause: string | null
  onUpdate: string | null
  generated: string | null
  invisible: boolean
  srid: string | null
}

/** Splits a column definition into top-level tokens, keeping quoted text and parenthesised groups whole. */
export function tokenizeDefinition(def: string): string[] {
  const tokens: string[] = []
  let i = 0
  const readQuoted = (): string => {
    const q = def[i]
    let out = q
    i++
    while (i < def.length) {
      const ch = def[i]
      out += ch
      i++
      if (ch === '\\' && i < def.length) {
        out += def[i]
        i++
      } else if (ch === q) {
        if (def[i] === q) {
          out += def[i]
          i++
        } else break
      }
    }
    return out
  }
  const readGroup = (): string => {
    let depth = 0
    let out = ''
    while (i < def.length) {
      const ch = def[i]
      if (ch === "'" || ch === '"' || ch === '`') {
        out += readQuoted()
        continue
      }
      out += ch
      i++
      if (ch === '(') depth++
      else if (ch === ')' && --depth === 0) break
    }
    return out
  }
  while (i < def.length) {
    const ch = def[i]
    if (/\s/.test(ch)) {
      i++
      continue
    }
    let token: string
    if (ch === "'" || ch === '"' || ch === '`') token = readQuoted()
    else if (ch === '(') token = readGroup()
    else {
      token = ''
      while (i < def.length && !/[\s('"`]/.test(def[i])) token += def[i++]
    }
    // Glue adjacent groups/literals: CURRENT_TIMESTAMP(3), _utf8mb4'x', b'01'.
    while (i < def.length && (def[i] === '(' || def[i] === "'" || def[i] === '"')) {
      token += def[i] === '(' ? readGroup() : readQuoted()
    }
    tokens.push(token)
  }
  return tokens
}

function parseDefinition(raw: string): ParsedDefinition {
  const tokens = tokenizeDefinition(raw)
  const upper = tokens.map((t) => t.toUpperCase())
  const after = (index: number): string | null =>
    index >= 0 && index + 1 < tokens.length ? tokens[index + 1] : null

  const def = upper.indexOf('DEFAULT')
  let onUpdate: string | null = null
  for (let k = 0; k + 2 < tokens.length; k++) {
    if (upper[k] === 'ON' && upper[k + 1] === 'UPDATE') onUpdate = tokens[k + 2]
  }
  let generated: string | null = null
  const as = upper.findIndex((t, k) => t === 'AS' && tokens[k + 1]?.startsWith('('))
  if (as >= 0) {
    const kind = upper[as + 2] === 'STORED' ? 'STORED' : 'VIRTUAL'
    generated = `GENERATED ALWAYS AS ${tokens[as + 1]} ${kind}`
  }
  return {
    raw,
    defaultClause: after(def),
    onUpdate,
    generated,
    invisible: upper.includes('INVISIBLE'),
    srid: after(upper.indexOf('SRID'))
  }
}

/** Maps column name -> definition text from a SHOW CREATE TABLE statement. */
export function parseCreateColumns(createSql: string): Map<string, ParsedDefinition> {
  const out = new Map<string, ParsedDefinition>()
  for (const line of createSql.split('\n')) {
    const m = /^\s*`((?:[^`]|``)+)`\s+(.*?)\s*,?\s*$/.exec(line)
    if (m) out.set(m[1].replace(/``/g, '`'), parseDefinition(m[2]))
  }
  return out
}

interface Original {
  info: ColumnInfo
  base: ColumnDraft
  parsed: ParsedDefinition | null
}

const CURRENT_TS = /^(CURRENT_TIMESTAMP|NOW)(\(\d*\))?$/i

function defaultFor(d: ColumnDraft, orig: Original | null): string | null {
  const raw = d.defaultValue
  if (raw === null) return null
  if (orig && raw === orig.base.defaultValue) {
    // Unchanged default: reuse the server's own spelling (handles expressions and charset introducers).
    if (orig.parsed?.defaultClause) return orig.parsed.defaultClause
    if (/DEFAULT_GENERATED/i.test(orig.info.extra) && !CURRENT_TS.test(raw) && !raw.startsWith('('))
      return `(${raw})`
  }
  const isExpression =
    /^(CURRENT_TIMESTAMP|NOW\(\)|NULL|b'|0x|\()/i.test(raw) || /^-?\d+(\.\d+)?$/.test(raw)
  return isExpression ? raw : quoteString(raw)
}

function columnDefinition(d: ColumnDraft, orig: Original | null): string {
  const parts = [quoteIdent(d.name), d.columnType + (d.unsigned ? ' unsigned' : '')]
  if (d.collation) parts.push(`COLLATE ${d.collation}`)
  const generated = orig?.parsed?.generated ?? null
  if (generated) {
    parts.push(generated, d.nullable ? 'NULL' : 'NOT NULL')
  } else {
    parts.push(d.nullable ? 'NULL' : 'NOT NULL')
    const dflt = d.autoIncrement ? null : defaultFor(d, orig)
    if (d.autoIncrement) parts.push('AUTO_INCREMENT')
    else if (dflt !== null) parts.push(`DEFAULT ${dflt}`)
    else if (d.nullable) parts.push('DEFAULT NULL')
    const onUpdate =
      orig?.parsed?.onUpdate ??
      /on update (CURRENT_TIMESTAMP(?:\(\d*\))?)/i.exec(orig?.info.extra ?? '')?.[1] ??
      null
    if (onUpdate) parts.push(`ON UPDATE ${onUpdate}`)
  }
  if (orig?.parsed?.srid) parts.push(`SRID ${orig.parsed.srid}`)
  if (orig?.parsed?.invisible || /\bINVISIBLE\b/i.test(orig?.info.extra ?? ''))
    parts.push('INVISIBLE')
  if (d.comment) parts.push(`COMMENT ${quoteString(d.comment)}`)
  return parts.join(' ')
}

const EDITABLE: (keyof ColumnDraft)[] = [
  'name',
  'columnType',
  'nullable',
  'defaultValue',
  'autoIncrement',
  'unsigned',
  'collation',
  'comment'
]

function sameColumn(a: ColumnDraft, b: ColumnDraft): boolean {
  return EDITABLE.every((k) => a[k] === b[k])
}

/**
 * Existing columns that keep their relative order (a longest increasing
 * subsequence of original positions). Only the others need MODIFY ... AFTER:
 * columns shifted by an inserted or moved neighbour are left untouched, which
 * keeps the ALTER minimal and avoids rebuilding definitions needlessly.
 */
export function stableColumns(base: ColumnDraft[], draft: ColumnDraft[]): Set<string> {
  const kept = draft
    .filter((d) => d.originalName !== null && base.some((b) => b.originalName === d.originalName))
    .map((d) => ({
      name: d.originalName!,
      pos: base.findIndex((b) => b.originalName === d.originalName)
    }))
  // O(n^2) LIS is fine for table-sized inputs.
  const len = kept.map(() => 1)
  const from = kept.map(() => -1)
  let best = -1
  kept.forEach((k, i) => {
    for (let j = 0; j < i; j++) {
      if (kept[j].pos < k.pos && len[j] + 1 > len[i]) {
        len[i] = len[j] + 1
        from[i] = j
      }
    }
    if (best < 0 || len[i] > len[best]) best = i
  })
  const out = new Set<string>()
  for (let i = best; i >= 0; i = from[i]) out.add(kept[i].name)
  return out
}

/** Builds the ALTER TABLE statements that move `original` to `draft`, preserving column attributes the draft cannot express. */
export function buildDesignerAlter(original: TableStructure, draft: TableDraft): DesignerAlter {
  const base = draftFromStructure(original)
  const parsed = parseCreateColumns(original.createSql ?? '')
  const risks: string[] = []
  const problems: string[] = []
  const drops: DesignerDrop[] = []
  const clauses: string[] = []
  const origOf = (name: string): Original | null => {
    const idx = base.columns.findIndex((c) => c.originalName === name)
    if (idx < 0) return null
    return {
      info: original.columns[idx],
      base: base.columns[idx],
      parsed: parsed.get(name) ?? null
    }
  }

  for (const c of base.columns) {
    if (!draft.columns.some((d) => d.originalName === c.originalName)) {
      clauses.push(`DROP COLUMN ${quoteIdent(c.name)}`)
      risks.push(`Se elimina el campo "${c.name}" y todos sus datos`)
      drops.push({ kind: 'COLUMN', name: c.name })
    }
  }

  const stable = stableColumns(base.columns, draft.columns)
  draft.columns.forEach((d, idx) => {
    if (!d.name) return
    const prev = draft.columns[idx - 1]
    const position = idx === 0 ? ' FIRST' : prev?.name ? ` AFTER ${quoteIdent(prev.name)}` : ''
    const orig = d.originalName ? origOf(d.originalName) : null
    if (!orig) {
      clauses.push(`ADD COLUMN ${columnDefinition(d, null)}${position}`)
      return
    }
    const moved = !stable.has(d.originalName!)
    const changed = !sameColumn(d, orig.base)
    if (!changed && !moved) return
    const name = orig.base.name
    if (!changed && orig.parsed) {
      // Only the position changes: keep the server's definition verbatim.
      clauses.push(`MODIFY COLUMN ${quoteIdent(name)} ${orig.parsed.raw}${position}`)
      return
    }
    if (/\b(STORED|VIRTUAL) GENERATED\b/i.test(orig.info.extra) && !orig.parsed?.generated) {
      problems.push(
        `No se puede reconstruir la columna generada "${name}" sin su definición; edítala con SQL`
      )
      return
    }
    const verb = d.name !== name ? `CHANGE COLUMN ${quoteIdent(name)} ` : 'MODIFY COLUMN '
    clauses.push(`${verb}${columnDefinition(d, orig)}${moved ? position : ''}`)
    if (d.name !== name) risks.push(`Se renombra el campo "${name}" a "${d.name}"`)
    const oldType = orig.base.columnType + (orig.base.unsigned ? ' unsigned' : '')
    const newType = d.columnType + (d.unsigned ? ' unsigned' : '')
    if (oldType.toLowerCase() !== newType.toLowerCase())
      risks.push(
        `El campo "${d.name}" cambia de ${oldType} a ${newType}: los valores que no quepan se truncarán o fallará la operación`
      )
    if ((d.collation ?? '') !== (orig.base.collation ?? ''))
      risks.push(
        `El campo "${d.name}" cambia de intercalación; puede convertir o perder caracteres`
      )
    if (orig.base.nullable && !d.nullable)
      risks.push(
        `El campo "${d.name}" pasa a NOT NULL; las filas con NULL fallarán o se convertirán`
      )
  })

  const basePk = base.columns.filter((c) => c.primaryKey).map((c) => c.originalName)
  const draftPk = draft.columns.filter((c) => c.primaryKey && c.name)
  if (basePk.join(',') !== draftPk.map((c) => c.originalName ?? c.name).join(',')) {
    if (basePk.length) {
      clauses.push('DROP PRIMARY KEY')
      risks.push('Se elimina o redefine la clave primaria')
      drops.push({ kind: 'PRIMARY KEY', name: 'PRIMARY' })
    }
    if (draftPk.length)
      clauses.push(`ADD PRIMARY KEY (${draftPk.map((c) => quoteIdent(c.name)).join(', ')})`)
  }

  // Indexes, foreign keys, options and rename come from the shared util, with columns held constant.
  const rest = buildAlterTable(original, { ...draft, columns: base.columns })
  const target = `${quoteIdent(original.schema)}.${quoteIdent(original.name)}`
  const head = `ALTER TABLE ${target}\n  `
  const isFkDrop = (s: string): boolean => s.startsWith(`${head}DROP FOREIGN KEY `)
  const isFkAdd = (s: string): boolean => s.startsWith(`${head}ADD CONSTRAINT `)
  const isMain = (s: string): boolean => s.startsWith(head) && !isFkDrop(s) && !isFkAdd(s)

  for (const s of rest) {
    if (/^\s*RENAME TABLE/.test(s))
      risks.push(
        `Se renombra la tabla a "${draft.name}"; vistas, rutinas y consultas que la usen dejarán de funcionar`
      )
    for (const m of s.matchAll(/(DROP (?:INDEX|FOREIGN KEY) `(?:[^`]|``)+`)/g)) {
      // A changed index/key is dropped and re-added; only flag the ones removed for good.
      const name = /`((?:[^`]|``)+)`$/.exec(m[1])![1].replace(/``/g, '`')
      const kept = m[1].startsWith('DROP INDEX')
        ? draft.indexes.some((i) => i.originalName === name)
        : draft.foreignKeys.some((f) => f.originalName === name)
      if (!kept) {
        const index = m[1].startsWith('DROP INDEX')
        risks.push(`Se elimina ${index ? 'el índice' : 'la clave foránea'} "${name}"`)
        drops.push({ kind: index ? 'INDEX' : 'FOREIGN KEY', name })
      }
    }
  }

  const statements = [...rest]
  if (clauses.length) {
    const mainIdx = statements.findIndex(isMain)
    if (mainIdx >= 0)
      statements[mainIdx] =
        `${head}${clauses.join(',\n  ')},\n  ${statements[mainIdx].slice(head.length)}`
    else
      statements.splice(statements.findIndex(isFkDrop) + 1, 0, `${head}${clauses.join(',\n  ')};`)
  }
  return { statements, risks, problems, drops }
}
