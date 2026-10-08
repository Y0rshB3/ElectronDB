/**
 * Renderer model of a page of MongoDB documents (docs/multi-engine-design.md,
 * 9.1 and 9.2): parsed canonical EJSON, the grid's columns, and the inline
 * edits staged until «Aplicar», turned into `$set`/`$unset` changes by `_id`
 * with the original value of every edited path (the optimistic check).
 *
 * Rules kept here (pure, tested):
 * - an edit inside an array sets the whole array (never `tags.2`, whose
 *   `$unset` would leave a null behind);
 * - a field whose name contains `.` or starts with `$` is not edited by path:
 *   «Edita el documento completo»;
 * - `_id` is never edited.
 */
import type { MongoDocumentChange, MongoFieldStat } from '@shared/types'
import {
  bsonTypeOf,
  ejsonText,
  isUnaddressableKey,
  largeValue,
  parseEjson,
  plainValue,
  valueAt,
  type EjsonObject,
  type EjsonValue
} from '@shared/mongo/shellFormat'

export type PathSegment = string | number

/** Display mode of a documents view (remembered per tab). */
export type DocumentMode = 'table' | 'tree' | 'json'

export interface DocRow {
  /** Parsed canonical EJSON as loaded. */
  original: EjsonObject
  /** Canonical text as loaded (compared by main before a replace). */
  text: string
  /** Fetched whole: no projection, no left-out large values. */
  whole: boolean
}

export interface StagedEdit {
  /** Top-level-or-array-root path (dotted) → new value; undefined value = $unset. */
  set: Map<string, EjsonValue>
  unset: Set<string>
  deleted: boolean
}

export function parseRows(docs: string[], whole: boolean[]): DocRow[] {
  return docs.map((text, i) => ({
    original: parseEjson(text) as EjsonObject,
    text,
    whole: whole[i] ?? false
  }))
}

/** Grid columns: the page's top-level fields, `_id` first, then by frequency (main's order). */
export function columnsOf(fields: MongoFieldStat[], rows: DocRow[]): string[] {
  const out = fields.map((f) => f.path)
  for (const r of rows) for (const k of Object.keys(r.original)) if (!out.includes(k)) out.push(k)
  if (out.includes('_id')) return ['_id', ...out.filter((k) => k !== '_id')]
  return out
}

/** Several BSON types in one column («mixto»). */
export function mixedTypes(field: MongoFieldStat | undefined): boolean {
  return !!field && Object.keys(field.types).length > 1
}

/** Why a path cannot be edited inline, or null. */
export function pathProblem(path: PathSegment[]): string | null {
  if (!path.length) return 'Ruta vacía.'
  if (path[0] === '_id') return 'El _id no se edita: duplica el documento para crear otro.'
  for (const seg of path)
    if (typeof seg === 'string' && isUnaddressableKey(seg))
      return `El campo «${seg}» no se puede editar por ruta: edita el documento completo.`
  return null
}

/**
 * Where an edit at `path` lands: the path itself, or the nearest array that
 * contains it (arrays are always set whole).
 */
export function editTarget(doc: EjsonObject, path: PathSegment[]): PathSegment[] {
  for (let i = 0; i < path.length - 1; i++) {
    const v = valueAt(doc, path.slice(0, i + 1))
    if (Array.isArray(v)) return path.slice(0, i + 1)
  }
  return path
}

export const dotted = (path: PathSegment[]): string => path.map(String).join('.')

function clone<T extends EjsonValue>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}

/** Returns a copy of `root` with `value` written at `path` (undefined removes it). */
export function withValue(
  root: EjsonValue,
  path: PathSegment[],
  value: EjsonValue | undefined
): EjsonValue {
  if (!path.length) return value === undefined ? null : clone(value)
  const copy = clone(root)
  let cur: EjsonValue = copy
  for (let i = 0; i < path.length - 1; i++) {
    const seg = path[i]
    cur = Array.isArray(cur) ? cur[seg as number] : (cur as EjsonObject)[String(seg)]
  }
  const last = path[path.length - 1]
  if (Array.isArray(cur)) {
    if (value === undefined) cur.splice(last as number, 1)
    else cur[last as number] = clone(value)
  } else if (cur && typeof cur === 'object') {
    const obj = cur as EjsonObject
    if (value === undefined) delete obj[String(last)]
    else obj[String(last)] = clone(value)
  }
  return copy
}

/** The document as currently edited (staged edits applied to the loaded copy). */
export function currentDoc(row: DocRow, edit: StagedEdit | undefined): EjsonObject {
  if (!edit) return row.original
  let doc: EjsonValue = row.original
  for (const [path, value] of edit.set) doc = withValue(doc, path.split('.').map(seg), value)
  for (const path of edit.unset) doc = withValue(doc, path.split('.').map(seg), undefined)
  return doc as EjsonObject
}

/** Dotted segment back to an index where the loaded value is an array. */
function seg(s: string): PathSegment {
  return /^\d+$/.test(s) ? Number(s) : s
}

export function emptyEdit(): StagedEdit {
  return { set: new Map(), unset: new Set(), deleted: false }
}

/**
 * Stages a new value (or a removal) at `path` of a row. Returns the problem
 * when the path cannot be edited inline. Edits inside arrays become a whole
 * array value.
 */
export function stageValue(
  row: DocRow,
  edit: StagedEdit,
  path: PathSegment[],
  value: EjsonValue | undefined
): string | null {
  const problem = pathProblem(path)
  if (problem) return problem
  const doc = currentDoc(row, edit)
  const target = editTarget(doc, path)
  if (target.length !== path.length) {
    // Inside an array: write the element, then set the whole array.
    const updated = withValue(doc, path, value)
    const arr = valueAt(updated, target)
    if (arr === undefined) return 'No se encontró el array.'
    const key = dotted(target)
    edit.unset.delete(key)
    edit.set.set(key, arr)
    clearNested(edit, key)
    return null
  }
  const key = dotted(path)
  if (value === undefined) {
    edit.set.delete(key)
    clearNested(edit, key)
    if (valueAt(row.original, path) !== undefined) edit.unset.add(key)
  } else {
    edit.unset.delete(key)
    clearNested(edit, key)
    edit.set.set(key, value)
  }
  return null
}

/** Drops staged paths below `key` (a parent's new value replaces them). */
function clearNested(edit: StagedEdit, key: string): void {
  for (const p of [...edit.set.keys()]) if (p.startsWith(`${key}.`)) edit.set.delete(p)
  for (const p of [...edit.unset]) if (p.startsWith(`${key}.`)) edit.unset.delete(p)
}

/** A path whose staged value equals what was loaded needs no change. */
function unchanged(row: DocRow, path: string, value: EjsonValue): boolean {
  const original = valueAt(row.original, path.split('.').map(seg))
  return original !== undefined && ejsonText(original) === ejsonText(value)
}

export function editCount(edit: StagedEdit | undefined, row?: DocRow): number {
  if (!edit) return 0
  if (edit.deleted) return 1
  const set = [...edit.set.entries()].filter(([p, v]) => !row || !unchanged(row, p, v))
  return set.length + edit.unset.size
}

/**
 * The `mongo:applyChanges` request for staged edits. `expected` repeats the
 * original value of each edited path (null when it did not exist, which
 * matches a missing field).
 */
export function changesFor(rows: DocRow[], edits: Map<number, StagedEdit>): MongoDocumentChange[] {
  const out: MongoDocumentChange[] = []
  for (const [index, edit] of edits) {
    const row = rows[index]
    if (!row) continue
    const id = row.original._id
    if (id === undefined) continue
    const idText = ejsonText(id)
    if (edit.deleted) {
      out.push({ kind: 'delete', id: idText })
      continue
    }
    const set: Record<string, string> = {}
    const expected: Record<string, string> = {}
    for (const [path, value] of edit.set) {
      if (unchanged(row, path, value)) continue
      set[path] = ejsonText(value)
      const before = valueAt(row.original, path.split('.').map(seg))
      expected[path] = ejsonText(before === undefined ? null : before)
    }
    const unset: string[] = []
    for (const path of edit.unset) {
      unset.push(path)
      const before = valueAt(row.original, path.split('.').map(seg))
      expected[path] = ejsonText(before === undefined ? null : before)
    }
    if (Object.keys(set).length || unset.length)
      out.push({ kind: 'update', id: idText, set, unset, expected })
  }
  return out
}

/** True when a staged path is at or under `path` (changed cell marker). */
export function isChanged(edit: StagedEdit | undefined, path: PathSegment[]): boolean {
  if (!edit) return false
  const key = dotted(path)
  const hit = (p: string): boolean =>
    p === key || p.startsWith(`${key}.`) || key.startsWith(`${p}.`)
  return [...edit.set.keys()].some(hit) || [...edit.unset].some(hit)
}

/** Field names and typed placeholders for «Insertar documento» (section 9.2). */
export function insertTemplate(fields: MongoFieldStat[]): string {
  const PLACEHOLDER: Record<string, string> = {
    objectId: 'ObjectId()',
    date: 'new Date()',
    int: 'NumberInt(0)',
    long: "NumberLong('0')",
    double: 'Double(0)',
    decimal: "NumberDecimal('0')",
    bool: 'false',
    string: "''",
    array: '[]',
    object: '{}',
    binData: "UUID('00000000-0000-4000-8000-000000000000')",
    null: 'null'
  }
  const lines = fields
    .filter((f) => f.path !== '_id' && !f.path.includes('.'))
    .slice(0, 40)
    .map((f) => {
      const top = Object.entries(f.types).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'string'
      const key = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(f.path) ? f.path : JSON.stringify(f.path)
      return `  ${key}: ${PLACEHOLDER[top] ?? 'null'}`
    })
  return lines.length ? `{\n${lines.join(',\n')}\n}` : '{\n  \n}'
}

/** A document without `_id`, for «Duplicar documento». */
export function withoutId(doc: EjsonObject): EjsonObject {
  const { _id: _ignored, ...rest } = doc
  void _ignored
  return rest
}

/** Short type label of a value for the grid's tooltip and the tree. */
export function typeOfCell(v: EjsonValue | undefined): string {
  if (v === undefined) return ''
  const large = largeValue(v)
  if (large) return large.type
  return bsonTypeOf(v)
}

/** Icon per BSON type (grid cells and tree rows). */
export const TYPE_ICONS: Partial<Record<string, string>> = {
  objectId: 'mdi-identifier',
  string: 'mdi-format-quote-close',
  int: 'mdi-numeric',
  long: 'mdi-numeric',
  double: 'mdi-decimal',
  decimal: 'mdi-decimal',
  bool: 'mdi-toggle-switch-outline',
  date: 'mdi-calendar-clock',
  object: 'mdi-code-braces',
  array: 'mdi-code-brackets',
  binData: 'mdi-file-code-outline',
  null: 'mdi-null',
  regex: 'mdi-regex',
  timestamp: 'mdi-timer-outline'
}

/** `email: 1, createdAt: -1` of an index's canonical key document. */
export function keysSummaryOf(keysText: string): string {
  try {
    const keys = parseEjson(keysText) as EjsonObject
    return Object.entries(keys)
      .map(([k, v]) => `${k}: ${plainValue(v)}`)
      .join(', ')
  } catch {
    return keysText
  }
}
