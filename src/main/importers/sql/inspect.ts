import type { SqlDumpInspection, SqlObjectCounts } from '@shared/importers'
import { classifyHead, detectTool, statementHead } from './classify'
import { dumpFileInfo, readDumpChunks } from './reader'

/**
 * Quick scan of a dump for the wizard: one pass over its lines (never loaded
 * whole), looking only at lines that start a statement. Dump tools write one
 * statement head per line and escape newlines inside values, so the counts
 * are good estimates; the import itself uses the real splitter.
 */

const HEADER_LINES = 40

export const NO_DATABASE_WARNING =
  'El archivo no indica base de datos: elige un esquema de destino.'

export function emptyCounts(): SqlObjectCounts {
  return { databases: 0, tables: 0, views: 0, routines: 0, triggers: 0, events: 0, inserts: 0 }
}

export async function inspectSqlDump(path: string): Promise<SqlDumpInspection> {
  const info = await dumpFileInfo(path)
  const databases: string[] = []
  const names: Record<'Table' | 'View' | 'Routine' | 'Trigger' | 'Event', Set<string>> = {
    Table: new Set(),
    View: new Set(),
    Routine: new Set(),
    Trigger: new Set(),
    Event: new Set()
  }
  let inserts = 0
  let hasCreateDatabase = false
  let hasUse = false
  let usesDelimiter = false
  let hasDefiners = false
  let replacementChars = 0
  let header = ''
  let lineNo = 0
  let carry = ''
  let anyText = false
  let delimiter = ';'

  const addDb = (name: string): void => {
    if (!databases.includes(name)) databases.push(name)
  }

  const onLine = (raw: string): void => {
    lineNo++
    if (lineNo <= HEADER_LINES) header += `${raw}\n`
    const trimmed = raw.trimStart()
    if (!trimmed) return
    anyText = true
    const delimiterLine = /^delimiter\s+(\S+)/i.exec(trimmed)
    if (delimiterLine) {
      usesDelimiter = true
      delimiter = delimiterLine[1]
      return
    }
    if (trimmed.startsWith('--') || trimmed.startsWith('#')) return
    if (!hasDefiners && /\bDEFINER\s*=/i.test(trimmed)) hasDefiners = true
    const head = statementHead(trimmed, 400)
    const info = classifyHead(head)
    if (info.kind === 'create') {
      switch (info.object) {
        case 'Database':
          hasCreateDatabase = true
          addDb(info.name)
          break
        case 'Procedure':
        case 'Function':
          names.Routine.add(`${info.object}:${info.name}`)
          break
        default:
          names[info.object].add(info.name)
      }
    } else if (info.kind === 'use') {
      hasUse = true
      addDb(info.name)
    } else if (info.kind === 'write' && delimiter === ';' && /^INSERT\b/i.test(head)) {
      // (an INSERT inside a routine or trigger body is not a data statement)
      inserts++
    }
  }

  // A very long line (an extended INSERT) is only looked at by its start.
  let inLongLine = false
  for await (const chunk of readDumpChunks(info)) {
    if (chunk.text.includes('\uFFFD')) replacementChars++
    let text = chunk.text
    if (inLongLine) {
      const nl = text.indexOf('\n')
      if (nl < 0) continue
      text = text.slice(nl + 1)
      inLongLine = false
    }
    const lines = (carry + text).split('\n')
    carry = lines.pop() ?? ''
    for (const line of lines) onLine(line.replace(/\r$/, ''))
    if (carry.length > 64 * 1024) {
      onLine(carry.slice(0, 4096))
      carry = ''
      inLongLine = true
    }
  }
  if (carry) onLine(carry)

  // mysqldump writes a placeholder table (5.7) or view (8.x) before each view.
  for (const view of names.View) names.Table.delete(view)

  const counts: SqlObjectCounts = {
    databases: databases.length,
    tables: names.Table.size,
    views: names.View.size,
    routines: names.Routine.size,
    triggers: names.Trigger.size,
    events: names.Event.size,
    inserts
  }
  const warnings: string[] = []
  if (!anyText) warnings.push('El archivo está vacío.')
  else if (databases.length === 0) warnings.push(NO_DATABASE_WARNING)
  if (databases.length > 1)
    warnings.push(
      `El archivo contiene ${databases.length} bases de datos (${databases.join(', ')}). «Importar todo en un esquema» las junta en una sola.`
    )
  if (replacementChars > 0)
    warnings.push(
      'El archivo no parece estar en UTF-8: algunos caracteres podrían importarse mal. Conviértelo a UTF-8 antes de importarlo.'
    )

  return {
    path: info.path,
    fileName: info.fileName,
    sizeBytes: info.sizeBytes,
    gzip: info.gzip,
    tool: detectTool(header),
    databases,
    hasCreateDatabase,
    hasUse,
    counts,
    usesDelimiter,
    hasDefiners,
    warnings
  }
}
