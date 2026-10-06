import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { Job, NavicatJobPreview } from '@shared/types'
import { JOB_FILE_EXTENSION, listJobFiles, navicatPaths } from './paths'

type Dict = Record<string, unknown>
const isDict = (v: unknown): v is Dict => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

export function jobNameFromFile(fileName: string): string {
  const base = basename(fileName)
  return base.toLowerCase().endsWith(JOB_FILE_EXTENSION)
    ? base.slice(0, -JOB_FILE_EXTENSION.length)
    : base
}

export function isJobImportedFromNavicat(job: Job, fileName: string): boolean {
  return job.source?.app === 'navicat' && job.source.fileName === fileName
}

/** Parses a `*.nbatmysql` JSON document. Throws an actionable error on bad input. */
export function parseBatchJob(
  fileName: string,
  json: string
): Omit<NavicatJobPreview, 'alreadyImported'> {
  let doc: unknown
  try {
    doc = JSON.parse(json)
  } catch {
    // JSON.parse messages quote file content: keep it out of the message/log
    throw new Error(`El perfil "${fileName}" no es un JSON válido`)
  }
  if (!isDict(doc)) throw new Error(`El perfil "${fileName}" no tiene el formato esperado`)
  const general = isDict(doc.General) ? doc.General : {}
  const jobs = Array.isArray(doc.Jobs) ? doc.Jobs : []
  return {
    fileName,
    name: jobNameFromFile(fileName),
    continueOnError: general.ContinueOnError !== false,
    tasks: jobs.filter(isDict).map((t) => ({
      type: str(t.TypeName),
      server: str(t.Server),
      schema: str(t.Schema),
      referenceName: str(t.ReferenceName)
    }))
  }
}

/**
 * Reads every batch job under `Navicat for MySQL/Profiles`. A file that cannot
 * be read or parsed is skipped and reported through `warnings` (Spanish,
 * file name only), so one broken profile never hides the others.
 */
export async function readNavicatJobs(
  root: string,
  existing: Job[],
  warnings?: string[]
): Promise<NavicatJobPreview[]> {
  const paths = navicatPaths(root)
  const previews: NavicatJobPreview[] = []
  for (const fileName of await listJobFiles(paths)) {
    let parsed: Omit<NavicatJobPreview, 'alreadyImported'>
    try {
      parsed = parseBatchJob(fileName, await readFile(join(paths.profilesDir, fileName), 'utf8'))
    } catch (err) {
      const reason =
        err instanceof Error && err.message.startsWith('El perfil')
          ? err.message
          : `No se pudo leer el perfil "${fileName}"`
      warnings?.push(`${reason}; se omitió`)
      continue
    }
    previews.push({
      ...parsed,
      alreadyImported: existing.some((j) => isJobImportedFromNavicat(j, fileName))
    })
  }
  return previews
}
