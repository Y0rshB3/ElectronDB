/** Common MySQL column types offered by the designer (free text is still allowed). */
export const COLUMN_TYPES = [
  'tinyint',
  'smallint',
  'mediumint',
  'int',
  'bigint',
  'decimal',
  'float',
  'double',
  'bit',
  'char',
  'varchar',
  'tinytext',
  'text',
  'mediumtext',
  'longtext',
  'binary',
  'varbinary',
  'tinyblob',
  'blob',
  'mediumblob',
  'longblob',
  'date',
  'time',
  'datetime',
  'timestamp',
  'year',
  'enum',
  'set',
  'json',
  'geometry',
  'point'
]

export const ENGINES = ['InnoDB', 'MyISAM', 'MEMORY', 'ARCHIVE', 'CSV', 'BLACKHOLE']

export const FK_ACTIONS = ['RESTRICT', 'CASCADE', 'SET NULL', 'NO ACTION', 'SET DEFAULT']

export const INDEX_TYPES = ['BTREE', 'HASH', 'FULLTEXT', 'SPATIAL']

export interface SplitType {
  base: string
  length: string
  /** Trailing modifiers other than unsigned (e.g. zerofill). */
  suffix: string
}

/** "varchar(255)" -> { base: 'varchar', length: '255' }. Keeps enum lists intact. */
export function splitColumnType(columnType: string): SplitType {
  const m = /^\s*([a-zA-Z]+)\s*(?:\((.*)\))?\s*(.*)$/s.exec(columnType)
  if (!m) return { base: columnType.trim(), length: '', suffix: '' }
  return { base: m[1].toLowerCase(), length: m[2] ?? '', suffix: m[3].trim() }
}

export function joinColumnType(parts: SplitType): string {
  const base = parts.base.trim()
  const length = parts.length.trim()
  return [length ? `${base}(${length})` : base, parts.suffix.trim()].filter(Boolean).join(' ')
}

export function isNumericType(base: string): boolean {
  return /^(tinyint|smallint|mediumint|int|integer|bigint|decimal|numeric|float|double|real)$/i.test(
    base
  )
}

const NO_LENGTH =
  /^(tinytext|text|mediumtext|longtext|tinyblob|blob|mediumblob|longblob|date|year|json|geometry|point|linestring|polygon|multipoint|multilinestring|multipolygon|geometrycollection|boolean|bool|serial)$/
const INTEGER = /^(tinyint|smallint|mediumint|int|integer|bigint)$/

/**
 * Length to keep when the base type changes, so e.g. varchar(255) -> date
 * does not become the invalid date(255). Returns '' when the new type takes
 * no length, or the previous length when it is still valid.
 */
export function lengthForBase(base: string, previous: string): string {
  const b = base.toLowerCase()
  const p = previous.trim()
  const digits = /^\d+$/.test(p) ? Number(p) : null
  if (NO_LENGTH.test(b) || INTEGER.test(b)) return ''
  if (/^(time|datetime|timestamp)$/.test(b)) return digits !== null && digits <= 6 ? p : ''
  if (/^(varchar|varbinary)$/.test(b)) return digits !== null && digits > 0 ? p : '255'
  if (/^(char|binary)$/.test(b)) return digits !== null && digits <= 255 ? p : ''
  if (b === 'bit') return digits !== null && digits >= 1 && digits <= 64 ? p : ''
  if (/^(decimal|numeric)$/.test(b)) return /^\d+(,\d+)?$/.test(p) ? p : '10,2'
  if (/^(float|double|real)$/.test(b)) return /^\d+,\d+$/.test(p) ? p : ''
  if (/^(enum|set)$/.test(b)) return p.startsWith("'") ? p : ''
  return p
}

/** Text shown in the default-value input: '' (empty string default) is spelled as two quotes. */
export const EMPTY_STRING_DEFAULT = "''"

export function defaultToInput(value: string | null): string {
  return value === '' ? EMPTY_STRING_DEFAULT : (value ?? '')
}

export function inputToDefault(text: string | null): string | null {
  if (text === null || text === '') return null
  return text === EMPTY_STRING_DEFAULT ? '' : text
}
