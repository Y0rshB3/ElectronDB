import type { BackupFile } from './types'

/**
 * Backup «packages»: the files one batch produced together, so the backups
 * list can show and restore them as a unit. Pure (names, dates and the run
 * reference main attached while listing; no archive is opened).
 *
 *   1. Files written by an Vortaq automation run (`file.run`) belong to
 *      that run: «<job name> · <run date>».
 *   2. Any other file (Navicat batch jobs, older copies) is grouped with the
 *      files of the same connection and label whose timestamps follow each
 *      other within PACKAGE_GAP_MS: «<label or Sin etiqueta> · <first date>».
 *      A batch copies each database once, so a database that shows up again
 *      starts a new package.
 *
 * A package needs at least two files; single files stay plain files.
 */

/** Max distance between consecutive files of a label package. */
export const PACKAGE_GAP_MS = 10 * 60_000
/** Job id file-based restores are recorded under when their files come from several jobs (or none). */
export const MANUAL_ROLLBACKS_JOB_ID = 'manual-rollbacks'
export const MANUAL_ROLLBACKS_NAME = 'Restauraciones manuales'
export const NO_LABEL = 'Sin etiqueta'

export interface BackupPackage {
  /** Stable while the files do not change: `run:<runId>` or `label:<connection>:<label>:<first date>`. */
  id: string
  kind: 'run' | 'label'
  title: string
  label: string | null
  /** Run packages: the run and job that wrote the files. */
  runId: string | null
  jobId: string | null
  /** Oldest and newest file dates (ISO). */
  firstAt: string
  lastAt: string
  /** Files, oldest first. */
  files: BackupFile[]
  sizeBytes: number
}

export interface BackupPackages {
  packages: BackupPackage[]
  /** Package of each file path (files without a package are absent). */
  byPath: Map<string, BackupPackage>
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** «YYYY-MM-DD HH:mm» in local time (ISO strings that do not parse are returned as is). */
export function packageDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const time = (iso: string): number => {
  const t = Date.parse(iso)
  return Number.isNaN(t) ? 0 : t
}

const byDateAsc = (a: BackupFile, b: BackupFile): number =>
  time(a.createdAt) - time(b.createdAt) || a.path.localeCompare(b.path)

function makePackage(
  kind: BackupPackage['kind'],
  id: string,
  title: string,
  files: BackupFile[],
  extra: Partial<BackupPackage> = {}
): BackupPackage {
  const sorted = [...files].sort(byDateAsc)
  return {
    id,
    kind,
    title,
    label: sorted[0].label,
    runId: null,
    jobId: null,
    firstAt: sorted[0].createdAt,
    lastAt: sorted[sorted.length - 1].createdAt,
    files: sorted,
    sizeBytes: sorted.reduce((sum, f) => sum + (f.sizeBytes || 0), 0),
    ...extra
  }
}

export function groupBackupPackages(
  files: readonly BackupFile[],
  gapMs = PACKAGE_GAP_MS
): BackupPackages {
  const packages: BackupPackage[] = []

  // 1. Automation runs.
  const byRun = new Map<string, BackupFile[]>()
  const loose: BackupFile[] = []
  for (const file of files) {
    if (file.run?.runId) {
      const list = byRun.get(file.run.runId) ?? []
      list.push(file)
      byRun.set(file.run.runId, list)
    } else loose.push(file)
  }
  for (const [runId, list] of byRun) {
    if (list.length < 2) continue
    const run = list[0].run!
    packages.push(
      makePackage('run', `run:${runId}`, `${run.jobName} · ${packageDate(run.startedAt)}`, list, {
        runId,
        jobId: run.jobId
      })
    )
  }

  // 2. Same connection + label, consecutive within the gap, each database once.
  const byLabel = new Map<string, BackupFile[]>()
  for (const file of loose) {
    const key = `${file.connectionId ?? ''}\u0000${file.label ?? ''}`
    const list = byLabel.get(key) ?? []
    list.push(file)
    byLabel.set(key, list)
  }
  for (const list of byLabel.values()) {
    list.sort(byDateAsc)
    let current: BackupFile[] = []
    let schemas = new Set<string>()
    const flush = (): void => {
      if (current.length >= 2) {
        const first = current[0]
        packages.push(
          makePackage(
            'label',
            `label:${first.connectionId ?? ''}:${first.label ?? ''}:${first.createdAt}`,
            `${first.label ?? NO_LABEL} · ${packageDate(first.createdAt)}`,
            current
          )
        )
      }
      current = []
      schemas = new Set()
    }
    for (const file of list) {
      const prev = current[current.length - 1]
      const tooFar = prev && time(file.createdAt) - time(prev.createdAt) > gapMs
      const repeated = !!file.schema && schemas.has(file.schema)
      if (prev && (tooFar || repeated)) flush()
      current.push(file)
      if (file.schema) schemas.add(file.schema)
    }
    flush()
  }

  packages.sort((a, b) => time(b.lastAt) - time(a.lastAt) || a.id.localeCompare(b.id))
  const byPath = new Map<string, BackupPackage>()
  for (const pkg of packages) for (const f of pkg.files) byPath.set(f.path, pkg)
  return { packages, byPath }
}

/** What «Restaurar paquete en Local» restores for a selection of files. */
export type PackageRestoreSource =
  | { kind: 'run'; runId: string; jobName: string; taskIds: string[] }
  | { kind: 'files'; backupPaths: string[]; title: string }

/**
 * Exactly one run's backups (all or some of them) reuse the run rollback;
 * anything else (a Navicat package, files picked by hand, several runs) is a
 * file-based restore. Null when nothing is selected.
 */
export function packageRestoreSource(
  selection: readonly BackupFile[],
  packages?: BackupPackages
): PackageRestoreSource | null {
  if (!selection.length) return null
  const runIds = new Set(selection.map((f) => f.run?.runId ?? ''))
  if (runIds.size === 1 && !runIds.has('')) {
    const run = selection[0].run!
    return {
      kind: 'run',
      runId: run.runId,
      jobName: run.jobName,
      taskIds: selection.map((f) => f.run!.taskId)
    }
  }
  const sorted = [...selection].sort(byDateAsc)
  const pkgs = new Set(sorted.map((f) => packages?.byPath.get(f.path) ?? null))
  const only = pkgs.size === 1 ? [...pkgs][0] : null
  const title =
    only && only.files.length === sorted.length
      ? only.title
      : `${sorted.length} ${sorted.length === 1 ? 'copia seleccionada' : 'copias seleccionadas'}`
  return { kind: 'files', backupPaths: sorted.map((f) => f.path), title }
}
