/**
 * Production guard for MongoDB query tabs (docs/multi-engine-design.md, 10).
 *
 * Two functions, like the SQL dialects (D13):
 * - `analyzeMongoWrites` (renderer, allowlist): a statement is a read only
 *   when it is provably read-only; everything else asks, with Spanish reasons.
 * - `isObviousMongoWrite` / `statementIsObviousWrite` (main, denylist): the
 *   write methods plus any aggregate (or explain) that mentions `$out` or
 *   `$merge`. Main never flags what the renderer lets through, and on top of
 *   this main re-checks the parsed pipeline values before running them.
 */
import {
  COLLECTION_READ_METHODS,
  DB_READ_METHODS,
  MongoShellError,
  parseShellScript,
  type MongoArg,
  type MongoStatement
} from './shell'

/** Aggregation stages that write to a collection. */
export const WRITE_STAGES = ['$out', '$merge'] as const

const COLLECTION_READS = new Set<string>(COLLECTION_READ_METHODS)
const DB_READS = new Set<string>(DB_READ_METHODS)

function argsMention(args: MongoArg[], words: readonly string[]): boolean {
  return args.some((a) => a.kind === 'expr' && a.strings.some((s) => words.includes(s)))
}

function argsLiteral(args: MongoArg[]): boolean {
  return args.every((a) => a.kind !== 'expr' || a.literal)
}

/** Main's denylist: true only for statements that surely write. */
export function statementIsObviousWrite(s: MongoStatement): boolean {
  switch (s.type) {
    case 'use':
    case 'show':
    case 'rs':
      return false
    case 'db':
      return !DB_READS.has(s.method)
    case 'collection':
      if (!COLLECTION_READS.has(s.method)) return true
      return s.method === 'aggregate' && argsMention(s.args, WRITE_STAGES)
  }
}

/** Renderer's allowlist: true only for statements that provably only read. */
export function statementIsRead(s: MongoStatement): boolean {
  if (statementIsObviousWrite(s)) return false
  if (s.type === 'collection' && s.method === 'aggregate') return argsLiteral(s.args)
  return true
}

/** Spanish reason of a statement that is not provably read-only. */
export function writeReason(s: MongoStatement): string {
  if (s.type === 'db') {
    if (s.method === 'dropDatabase') return 'dropDatabase() elimina la base de datos'
    return `db.${s.method}() modifica la base de datos`
  }
  if (s.type !== 'collection') return 'Orden que modifica datos'
  const where = `«${s.collection}»`
  if (s.method === 'aggregate') {
    if (argsMention(s.args, WRITE_STAGES))
      return `aggregate con $out o $merge escribe en una colección (${where})`
    return `aggregate con expresiones que no son literales en ${where}: no se puede comprobar que solo lea`
  }
  const filter = s.args[0]
  const emptyFilter = !filter || (filter.kind === 'expr' && filter.empty)
  if (s.method === 'deleteMany' && emptyFilter)
    return `deleteMany sin filtro borra todos los documentos de ${where}`
  if (s.method === 'updateMany' && emptyFilter)
    return `updateMany sin filtro modifica todos los documentos de ${where}`
  if (s.method === 'drop') return `drop() elimina la colección ${where}`
  if (s.method === 'dropIndex' || s.method === 'dropIndexes')
    return `${s.method}() elimina índices de ${where}`
  if (s.method === 'renameCollection') return `renameCollection() renombra ${where}`
  return `${s.method}() en ${where}`
}

export interface MongoWriteAnalysis {
  writes: boolean
  reasons: string[]
  /** The script does not parse (main refuses it before running anything). */
  error: string | null
}

/** Renderer: does the script need the confirmation dialog, and why. */
export function analyzeMongoWrites(script: string): MongoWriteAnalysis {
  let statements: MongoStatement[]
  try {
    statements = parseShellScript(script)
  } catch (err) {
    if (err instanceof MongoShellError) return { writes: false, reasons: [], error: err.message }
    throw err
  }
  const reasons = statements.filter((s) => !statementIsRead(s)).map(writeReason)
  return { writes: reasons.length > 0, reasons: [...new Set(reasons)], error: null }
}

/** Main: true when some statement surely writes. An unparsable script is refused elsewhere. */
export function isObviousMongoWrite(script: string): boolean {
  try {
    return parseShellScript(script).some(statementIsObviousWrite)
  } catch (err) {
    if (err instanceof MongoShellError) return false
    throw err
  }
}

/** True when a parsed value (an aggregate pipeline) has a $out/$merge key at any depth. */
export function valueHasWriteStage(value: unknown, depth = 0): boolean {
  if (depth > 200) return true // fail closed
  if (value === null || typeof value !== 'object') return false
  if (ArrayBuffer.isView(value)) return false
  if (Array.isArray(value)) return value.some((v) => valueHasWriteStage(v, depth + 1))
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if ((WRITE_STAGES as readonly string[]).includes(key)) return true
    if (valueHasWriteStage(v, depth + 1)) return true
  }
  return false
}
