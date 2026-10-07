import { readdir, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import {
  SQL_IMPORT_CANCELLED,
  type SqlFolderImportRequest,
  type SqlFolderImportResult,
  type SqlFolderPreview
} from '@shared/importers'
import { isSystemSchema, systemSchemaRefusal } from '@shared/restoreTask'
import type { ProgressReporter } from '../../backup/index'
import { importSqlDump, type SqlImportDeps } from './execute'

/**
 * A folder of dumps imported as one package: one .sql / .sql.gz file per
 * database, the file name proposing the database name (editable).
 */

const DUMP_RE = /\.sql(\.gz)?$/i

/** Database proposed for a dump file: its name without .sql / .sql.gz. */
export function schemaFromFileName(fileName: string): string {
  return fileName.replace(DUMP_RE, '').trim()
}

export async function previewSqlFolder(dir: string): Promise<SqlFolderPreview> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (err) {
    const code = (err as { code?: string }).code
    if (code === 'ENOENT') throw new Error(`No se encontró la carpeta: ${dir}`)
    if (code === 'ENOTDIR') throw new Error(`La ruta no es una carpeta: ${dir}`)
    if (code === 'EACCES' || code === 'EPERM')
      throw new Error(`Sin permisos para leer la carpeta: ${dir}`)
    throw err
  }
  const warnings: string[] = []
  const items: SqlFolderPreview['items'] = []
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.')) continue
    if (!entry.isFile()) continue
    if (!DUMP_RE.test(entry.name)) {
      warnings.push(`Se ignora ${entry.name}: no es .sql ni .sql.gz`)
      continue
    }
    const path = join(dir, entry.name)
    try {
      const s = await stat(path)
      items.push({
        path,
        fileName: entry.name,
        sizeBytes: s.size,
        schema: schemaFromFileName(entry.name)
      })
    } catch {
      warnings.push(`No se pudo leer ${entry.name}`)
    }
  }
  if (!items.length) throw new Error('La carpeta no contiene archivos .sql ni .sql.gz.')
  return { dir, items, warnings }
}

function validateRequest(request: SqlFolderImportRequest): void {
  if (!request || typeof request !== 'object') throw new Error('Petición no válida.')
  if (!request.connectionId) throw new Error('Selecciona la conexión de destino.')
  if (!Array.isArray(request.items) || !request.items.length)
    throw new Error('Elige al menos un archivo.')
  const dir = resolve(request.dir)
  const seen = new Set<string>()
  for (const item of request.items) {
    const schema = item.schema?.trim()
    const name = basename(item.path ?? '')
    if (!schema) throw new Error(`Indica la base de datos de destino de ${name}.`)
    if (isSystemSchema(schema)) throw new Error(systemSchemaRefusal(schema))
    const key = schema.toLowerCase()
    if (seen.has(key)) throw new Error(`La base de datos ${schema} aparece en más de un archivo.`)
    seen.add(key)
    if (dirname(resolve(item.path)) !== dir || !DUMP_RE.test(name))
      throw new Error(`${name} no es un archivo .sql de la carpeta elegida.`)
  }
}

export async function importSqlFolder(
  deps: SqlImportDeps,
  request: SqlFolderImportRequest,
  progress: ProgressReporter = () => {},
  signal?: AbortSignal
): Promise<SqlFolderImportResult> {
  validateRequest(request)
  const started = performance.now()
  const sizes: number[] = []
  for (const item of request.items) {
    try {
      sizes.push((await stat(item.path)).size)
    } catch {
      sizes.push(0)
    }
  }
  const grandTotal = sizes.reduce((a, b) => a + b, 0)
  const result: SqlFolderImportResult = { items: [], durationMs: 0 }
  let offset = 0
  let stopped = false
  const n = request.items.length
  for (let i = 0; i < n; i++) {
    const item = request.items[i]
    const schema = item.schema.trim()
    if (stopped) {
      result.items.push({
        path: item.path,
        schema,
        result: null,
        error: 'Omitido tras el error anterior'
      })
      continue
    }
    if (signal?.aborted) throw new Error(SQL_IMPORT_CANCELLED)
    progress({
      phase: 'file',
      current: offset,
      total: grandTotal,
      message: `Archivo ${i + 1}/${n}: ${basename(item.path)} → ${schema}`,
      done: false
    })
    try {
      const res = await importSqlDump(
        deps,
        {
          path: item.path,
          connectionId: request.connectionId,
          mode: 'intoSchema',
          targetSchema: schema,
          createSchema: true,
          replaceSchema: request.replaceSchema === true,
          safetyBackup: request.safetyBackup !== false,
          continueOnError: request.continueOnError === true,
          ...(request.confirmProduction ? { confirmProduction: true } : {})
        },
        (event) =>
          progress({
            ...event,
            current: offset + Math.min(event.current, sizes[i]),
            total: grandTotal,
            message: `${schema} · ${event.message}`
          }),
        signal
      )
      result.items.push({ path: item.path, schema, result: res, error: null })
      if (res.errors.length && !request.continueOnError) stopped = true
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message === SQL_IMPORT_CANCELLED || signal?.aborted) throw new Error(SQL_IMPORT_CANCELLED)
      result.items.push({ path: item.path, schema, result: null, error: message })
      if (!request.continueOnError) stopped = true
    }
    offset += sizes[i]
  }
  result.durationMs = Math.round(performance.now() - started)
  return result
}
