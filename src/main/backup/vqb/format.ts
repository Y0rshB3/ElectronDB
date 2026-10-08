import { createHash } from 'node:crypto'
import { validateKdf, type KdfDescriptor } from './crypto'
import { VqbFormatError } from './errors'

/**
 * JSON shapes of the .vqb format, version 1 (docs/vqb-format.md is the
 * public specification; keep both in sync). Every field the reader relies on
 * is validated here, so a damaged or hostile file fails with a clear message.
 */

export const VQB_EXTENSION = '.vqb'
export const VQB_FORMAT = 'vortaq-backup'
export const VQB_FORMAT_VERSION = 1
export const HEADER_PATH = 'header.json'
export const MANIFEST_PATH = 'manifest.json'
/** Uncompressed bytes per data file before a new one is started. */
export const DATA_CHUNK_BYTES = 5 * 1024 * 1024
export const VQB_ALGORITHM = 'AES-256-GCM'

export type VqbEngine = 'mysql' | 'postgresql' | 'sqlite' | 'mongodb'

export interface VqbHeader {
  format: typeof VQB_FORMAT
  formatVersion: number
  encrypted: boolean
  /** Present when `encrypted`. */
  encryption?: {
    alg: typeof VQB_ALGORITHM
    chunkSize: number
    kdf: KdfDescriptor
    keyCheck: string
  }
}

export interface VqbFileRef {
  path: string
  /** SHA-256 (hex) of the entry bytes exactly as stored in the ZIP. */
  sha256: string
  bytes: number
}

/**
 * Object types. MySQL/MariaDB: table, view, function, procedure, event (MariaDB: sequence).
 * PostgreSQL: extension, type, sequence, table, function, procedure, view,
 * materialized_view. SQLite: table, view. MongoDB: collection, view.
 */
export type VqbObjectType =
  | 'table'
  | 'view'
  | 'materialized_view'
  | 'function'
  | 'procedure'
  | 'event'
  | 'type'
  | 'sequence'
  | 'extension'
  | 'collection'

export const VQB_OBJECT_TYPES: readonly VqbObjectType[] = [
  'table',
  'view',
  'materialized_view',
  'function',
  'procedure',
  'event',
  'type',
  'sequence',
  'extension',
  'collection'
]

export interface VqbManifestObject {
  /** Folder number under objects/ ("000001"). */
  id: string
  type: VqbObjectType
  name: string
  /** PostgreSQL schema of the object (absent for MySQL). */
  schema?: string
  /** Rows written (tables), null otherwise. */
  rows: number | null
  files: VqbFileRef[]
}

export interface VqbManifest {
  format: typeof VQB_FORMAT
  formatVersion: number
  app: { name: string; version: string }
  engine: { id: VqbEngine; flavor: string; serverVersion: string }
  source: {
    /** Omitted when the user chose not to record it. */
    connectionName?: string
    /** MySQL: the schema (database). PostgreSQL: the database. SQLite: the attached alias ('main'). */
    database: string
    /** PostgreSQL: schemas included. */
    schemas?: string[]
    /** MySQL: default character set and collation of the schema. */
    charset?: string | null
    collation?: string | null
    /** PostgreSQL: server_encoding of the database. */
    encoding?: string | null
    /** MySQL: session time_zone the TIMESTAMP values were read in ("+00:00"). */
    timeZone?: string | null
  }
  createdAt: string
  finishedAt: string
  comment?: string
  options: {
    includeData: boolean
    structureOnly: boolean
    /** Only some objects were selected. */
    partial: boolean
  }
  /** Same algorithm as the header; null when the archive is not encrypted. */
  encryption: { alg: typeof VQB_ALGORITHM; kdf: 'scrypt' } | null
  objects: VqbManifestObject[]
  /** Things the backup left out, in the user's language (MariaDB system-versioned tables…). */
  warnings?: string[]
}

export interface VqbColumn {
  name: string
  /** Column type in the source dialect (COLUMN_TYPE / format_type). */
  type: string
  /** PostgreSQL arrays: element delimiter when it is not ',' (box[] uses ';'). */
  delimiter?: string
}

export interface VqbDataFile {
  path: string
  rows: number
}

export interface VqbSequenceState {
  schema: string
  name: string
  /** last_value as text (bigint). */
  lastValue: string
  isCalled: boolean
  /** Table column the sequence belongs to (serial / identity), if any. */
  ownedBy?: { table: string; column: string } | null
  /** 'identity' sequences are created by the column itself. */
  kind?: 'identity' | 'serial' | 'standalone'
  /** MariaDB: cycle_count of the sequence (SETVAL's round), integer text. */
  round?: string
}

/**
 * MariaDB system-versioned table: the last two columns of the data are its
 * period columns and the rows include the history (FOR SYSTEM_TIME ALL).
 */
export interface VqbSystemVersioning {
  /** Period start/end column names (MariaDB's hidden ones are row_start/row_end). */
  start: string
  end: string
  /** End value (as stored in the data) of the current rows; null = no current rows. */
  currentEnd: string | null
}

export interface VqbObjectMeta {
  name: string
  type: VqbObjectType
  schema?: string
  /** Path of ddl.sql (one statement). */
  ddl: string
  /** Tables: columns in data order (generated columns are not stored). */
  columns?: VqbColumn[]
  primaryKey?: string[]
  rows?: number
  /** MySQL: AUTO_INCREMENT counter of the table. SQLite: its sqlite_sequence value. */
  autoIncrement?: string | null
  /**
   * PostgreSQL / SQLite: index DDL to run after the data (not backing a constraint).
   * MongoDB: canonical Extended JSON of each index spec ({key, name, unique…}), `_id_` excluded.
   */
  indexes?: string[]
  /** PostgreSQL: ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY, run after every table's data. */
  foreignKeys?: string[]
  /** Trigger DDL, run after the data. */
  triggers?: string[]
  /** PostgreSQL: COMMENT ON statements. */
  comments?: string[]
  /** PostgreSQL: sequences to set after the data (serial/identity of a table, or the sequence itself). */
  sequences?: VqbSequenceState[]
  /** Statements to run right after the main DDL (PostgreSQL ALTER … OWNED BY…). */
  postDdl?: string[]
  /** MariaDB: the table is system-versioned and its data carries the history. */
  systemVersioning?: VqbSystemVersioning
  data?: VqbDataFile[]
}

export const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex')

export const objectDir = (id: string): string => `objects/${id}`
export const objectId = (index: number): string => String(index).padStart(6, '0')
export const dataPath = (id: string, chunk: number): string =>
  `${objectDir(id)}/data-${String(chunk).padStart(6, '0')}.jsonl.gz`

/* ---------- validation ---------- */

const bad = (what: string): never => {
  throw new VqbFormatError(`La copia .vqb no es válida: ${what}.`)
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

const str = (v: unknown, what: string): string => (typeof v === 'string' ? v : bad(what))
const strList = (v: unknown, what: string): string[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : bad(what)
const optStrList = (v: unknown, what: string): string[] | undefined =>
  v === undefined ? undefined : strList(v, what)

const PATH_RE = /^[A-Za-z0-9._\-/]+$/
const checkPath = (p: unknown): string => {
  const path = str(p, 'ruta de archivo')
  if (!PATH_RE.test(path) || path.startsWith('/') || path.split('/').includes('..'))
    bad(`ruta ${path}`)
  return path
}

function checkVersion(raw: Record<string, unknown>): void {
  if (raw.format !== VQB_FORMAT) bad('no es una copia de Vortaq')
  const v = raw.formatVersion
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) bad('versión de formato')
  if ((v as number) > VQB_FORMAT_VERSION)
    throw new VqbFormatError(
      `La copia usa la versión ${String(v)} del formato .vqb y esta versión de Vortaq solo lee hasta la ${VQB_FORMAT_VERSION}: actualiza Vortaq.`
    )
}

export function parseJson(data: Buffer, what: string): unknown {
  try {
    return JSON.parse(data.toString('utf8'))
  } catch {
    return bad(`${what} no es JSON`)
  }
}

export function validateHeader(raw: unknown): VqbHeader {
  if (!isObj(raw)) return bad('cabecera')
  checkVersion(raw)
  if (typeof raw.encrypted !== 'boolean') bad('cabecera sin «encrypted»')
  if (!raw.encrypted)
    return { format: VQB_FORMAT, formatVersion: raw.formatVersion as number, encrypted: false }
  const e = raw.encryption
  if (!isObj(e) || e.alg !== VQB_ALGORITHM) return bad('algoritmo de cifrado desconocido')
  if (typeof e.chunkSize !== 'number' || !Number.isInteger(e.chunkSize)) bad('cabecera de cifrado')
  return {
    format: VQB_FORMAT,
    formatVersion: raw.formatVersion as number,
    encrypted: true,
    encryption: {
      alg: VQB_ALGORITHM,
      chunkSize: e.chunkSize as number,
      kdf: validateKdf(e.kdf),
      keyCheck: str(e.keyCheck, 'keyCheck')
    }
  }
}

const OBJECT_TYPES = new Set<string>(VQB_OBJECT_TYPES)

export function validateManifest(raw: unknown): VqbManifest {
  if (!isObj(raw)) return bad('manifiesto')
  checkVersion(raw)
  const engine = raw.engine
  if (
    !isObj(engine) ||
    (engine.id !== 'mysql' &&
      engine.id !== 'postgresql' &&
      engine.id !== 'sqlite' &&
      engine.id !== 'mongodb')
  )
    bad('motor de base de datos')
  const source = raw.source
  if (!isObj(source)) bad('origen')
  str((source as Record<string, unknown>).database, 'base de datos de origen')
  const options = raw.options
  if (!isObj(options) || typeof options.includeData !== 'boolean') bad('opciones')
  if (!Array.isArray(raw.objects)) bad('lista de objetos')
  const ids = new Set<string>()
  for (const o of raw.objects as unknown[]) {
    if (!isObj(o)) bad('objeto')
    const obj = o as Record<string, unknown>
    const id = str(obj.id, 'id de objeto')
    if (!/^\d{1,9}$/.test(id) || ids.has(id)) bad(`id de objeto ${id}`)
    ids.add(id)
    if (!OBJECT_TYPES.has(String(obj.type))) bad(`tipo de objeto ${String(obj.type)}`)
    str(obj.name, 'nombre de objeto')
    if (obj.schema !== undefined) str(obj.schema, 'esquema de objeto')
    if (obj.rows !== null && (typeof obj.rows !== 'number' || obj.rows < 0)) bad('filas de objeto')
    if (!Array.isArray(obj.files)) bad('archivos de objeto')
    for (const f of obj.files as unknown[]) {
      if (!isObj(f)) bad('archivo de objeto')
      const file = f as Record<string, unknown>
      checkPath(file.path)
      if (typeof file.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(file.sha256)) bad('sha256')
      if (typeof file.bytes !== 'number' || file.bytes < 0) bad('tamaño de archivo')
    }
  }
  return raw as unknown as VqbManifest
}

export function validateObjectMeta(raw: unknown, expected: VqbManifestObject): VqbObjectMeta {
  if (!isObj(raw)) return bad(`meta.json de ${expected.name}`)
  if (raw.type !== expected.type || raw.name !== expected.name)
    bad(`meta.json de ${expected.name} no coincide con el manifiesto`)
  checkPath(raw.ddl)
  if (raw.columns !== undefined) {
    if (!Array.isArray(raw.columns)) bad('columnas')
    for (const c of raw.columns as unknown[]) {
      if (!isObj(c)) bad('columna')
      str((c as Record<string, unknown>).name, 'nombre de columna')
      str((c as Record<string, unknown>).type, 'tipo de columna')
      const d = (c as Record<string, unknown>).delimiter
      if (d !== undefined && (typeof d !== 'string' || d.length !== 1)) bad('delimitador')
    }
  }
  for (const key of ['indexes', 'foreignKeys', 'triggers', 'comments', 'postDdl', 'primaryKey'])
    optStrList(raw[key], key)
  if (raw.data !== undefined) {
    if (!Array.isArray(raw.data)) bad('datos')
    for (const d of raw.data as unknown[]) {
      if (!isObj(d)) bad('archivo de datos')
      checkPath((d as Record<string, unknown>).path)
      const rows = (d as Record<string, unknown>).rows
      if (typeof rows !== 'number' || rows < 0) bad('filas de un archivo de datos')
    }
  }
  if (raw.sequences !== undefined) {
    if (!Array.isArray(raw.sequences)) bad('secuencias')
    for (const s of raw.sequences as unknown[]) {
      if (!isObj(s)) bad('secuencia')
      const seq = s as Record<string, unknown>
      str(seq.schema, 'esquema de secuencia')
      str(seq.name, 'nombre de secuencia')
      if (typeof seq.lastValue !== 'string' || !/^-?\d+$/.test(seq.lastValue))
        bad('valor de secuencia')
      if (typeof seq.isCalled !== 'boolean') bad('estado de secuencia')
      if (seq.round !== undefined && (typeof seq.round !== 'string' || !/^\d+$/.test(seq.round)))
        bad('ciclo de secuencia')
    }
  }
  if (raw.systemVersioning !== undefined) {
    const v = raw.systemVersioning
    if (!isObj(v)) return bad('versionado de sistema')
    str(v.start, 'columna de inicio del periodo')
    str(v.end, 'columna de fin del periodo')
    if (v.currentEnd !== null) str(v.currentEnd, 'fin del periodo actual')
    const cols = Array.isArray(raw.columns) ? (raw.columns as { name: string }[]) : []
    if (
      cols.length < 2 ||
      cols[cols.length - 2].name !== v.start ||
      cols[cols.length - 1].name !== v.end
    )
      bad('columnas del periodo de una tabla versionada')
  }
  return raw as unknown as VqbObjectMeta
}
