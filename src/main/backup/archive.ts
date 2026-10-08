import type { BackupMeta } from '@shared/types'
import { backupFormatOfPath } from './naming'
import { isEncrypted, type Nb3Manifest, type Nb3ObjectMeta } from './nb3/format'
import { ENCRYPTED_MESSAGE, Nb3Reader, readManifest, verifyBackupFile } from './nb3/reader'
import { NB3_TYPE_OF, VqbMysqlArchive } from './vqb/mysqlArchive'
import { VqbReader, withVqbReader } from './vqb/reader'
import type {
  VqbHeader,
  VqbManifest,
  VqbSequenceState,
  VqbSystemVersioning
} from './vqb/format'

/**
 * Format-neutral access to restorable backups (.nb3 and .vqb): metadata for
 * the lists, the full integrity check, object DDL for the browser and the
 * archive restore.ts reads. Everything that looks at a backup file goes
 * through here, so callers never branch on the extension themselves.
 */

/** What restore.ts needs from an archive of a MySQL schema. */
export interface RestoreArchive {
  readonly format: 'nb3' | 'vqb'
  manifest(): Promise<Nb3Manifest>
  objectMeta(uuid: string): Promise<Nb3ObjectMeta>
  rows(
    meta: Nb3ObjectMeta,
    onRow: (tuple: string) => Promise<void> | void,
    signal?: AbortSignal,
    options?: RowsOptions
  ): Promise<number>
  /** MariaDB system-versioned table whose data carries its history (.vqb only). */
  versioning?(meta: Nb3ObjectMeta): VqbSystemVersioning | null
  /** MariaDB sequence value to set after the sequence is created (.vqb only). */
  sequenceState?(meta: Nb3ObjectMeta): VqbSequenceState | null
  /** Session time zone of the archive's TIMESTAMP text (.vqb: '+00:00'), null = leave it. */
  readonly timeZone: string | null
  close(): Promise<void>
}

export interface RowsOptions {
  /**
   * System-versioned table restored where history cannot be inserted: only
   * the current rows, without the two period columns.
   */
  currentOnly?: boolean
}

export const NOT_A_BACKUP_MESSAGE =
  'El archivo indicado no es una copia de seguridad (.vqb o .nb3).'

function formatOrThrow(path: string): 'nb3' | 'vqb' {
  const format = backupFormatOfPath(path)
  if (!format) throw new Error(NOT_A_BACKUP_MESSAGE)
  return format
}

class Nb3Archive implements RestoreArchive {
  readonly format = 'nb3' as const
  readonly timeZone = null
  constructor(private readonly reader: Nb3Reader) {}
  manifest = (): Promise<Nb3Manifest> => this.reader.manifest()
  objectMeta = (uuid: string): Promise<Nb3ObjectMeta> => this.reader.objectMeta(uuid)
  rows = (
    meta: Nb3ObjectMeta,
    onRow: (tuple: string) => Promise<void> | void,
    signal?: AbortSignal
  ): Promise<number> => this.reader.rows(meta, onRow, signal)
  close = async (): Promise<void> => undefined
}

/** Opens a MySQL backup for restore.ts (.vqb from another engine is refused). */
export async function openMysqlRestoreArchive(
  path: string,
  password?: string | null
): Promise<RestoreArchive> {
  if (formatOrThrow(path) === 'vqb') return VqbMysqlArchive.open(path, password)
  const reader = await Nb3Reader.open(path)
  if (isEncrypted(await reader.manifest())) throw new Error(ENCRYPTED_MESSAGE)
  return new Nb3Archive(reader)
}

/* ---------- metadata ---------- */

const VQB_ENCRYPTION = 'AES-256-GCM'

/** BackupMeta of a .vqb whose manifest could not be read without the password. */
export function lockedVqbMeta(header: VqbHeader): BackupMeta {
  return {
    metaVersion: `vqb-${header.formatVersion}`,
    databaseType: '',
    schema: '',
    startTime: null,
    endTime: null,
    encryption: VQB_ENCRYPTION,
    comment: '',
    objects: [],
    format: 'vqb',
    encrypted: true,
    locked: true
  }
}

export function vqbManifestMeta(manifest: VqbManifest): BackupMeta {
  return {
    metaVersion: `vqb-${manifest.formatVersion}`,
    databaseType:
      manifest.engine.id === 'postgresql'
        ? 'POSTGRESQL'
        : manifest.engine.id === 'sqlite'
          ? 'SQLITE'
          : manifest.engine.id === 'mongodb'
            ? 'MONGODB'
            : 'MYSQL',
    schema: manifest.source.database,
    startTime: manifest.createdAt,
    endTime: manifest.finishedAt,
    encryption: manifest.encryption ? VQB_ENCRYPTION : 'None',
    comment: manifest.comment ?? '',
    objects: manifest.objects.map((o) => ({
      uuid: o.id,
      type: NB3_TYPE_OF[o.type] ?? o.type,
      name: o.name,
      ...(o.schema !== undefined ? { schema: o.schema } : {}),
      rows: o.rows
    })),
    format: 'vqb',
    encrypted: !!manifest.encryption,
    locked: false,
    engine: manifest.engine.id,
    engineFlavor: manifest.engine.flavor,
    serverVersion: manifest.engine.serverVersion,
    writtenBy: `${manifest.app.name} ${manifest.app.version}`.trim(),
    connectionName: manifest.source.connectionName ?? null,
    ...(manifest.source.schemas ? { schemas: manifest.source.schemas } : {}),
    includeData: manifest.options.includeData,
    partial: manifest.options.partial,
    ...(manifest.warnings?.length ? { warnings: manifest.warnings } : {})
  }
}

/**
 * Metadata of a backup file. An encrypted .vqb without `password` gives the
 * locked header-only meta; with a wrong password it throws.
 */
export async function readArchiveMeta(path: string, password?: string | null): Promise<BackupMeta> {
  if (formatOrThrow(path) === 'nb3') return { ...(await readManifest(path)), format: 'nb3' }
  const reader = await VqbReader.open(path)
  try {
    if (reader.encrypted && !password) return lockedVqbMeta(reader.header)
    await reader.unlock(password)
    return vqbManifestMeta(await reader.manifest())
  } finally {
    await reader.close()
  }
}

/** Only the header of a .vqb: is it encrypted? (cheap: the ZIP directory and one small entry). */
export async function vqbIsEncrypted(path: string): Promise<boolean> {
  const reader = await VqbReader.open(path)
  try {
    return reader.encrypted
  } finally {
    await reader.close()
  }
}

/** True when this meta cannot be used without a password (locked .vqb or encrypted .nb3). */
export function metaNeedsPassword(
  meta: Pick<BackupMeta, 'format' | 'locked' | 'encryption'>
): boolean {
  if (meta.format === 'vqb') return meta.locked === true
  return !!meta.encryption && meta.encryption !== 'None'
}

/* ---------- integrity ---------- */

export interface ArchiveVerifyResult {
  objects: number
  rows: number
}

/** Full read of the archive (checksums, GCM tags, every data file); throws when damaged. */
export async function verifyArchive(
  path: string,
  signal?: AbortSignal,
  password?: string | null
): Promise<ArchiveVerifyResult> {
  if (formatOrThrow(path) === 'nb3') {
    const r = await verifyBackupFile(path, signal)
    return { objects: r.objects, rows: r.rows }
  }
  return withVqbReader(path, password, async (reader) => {
    await reader.unlock(password)
    const r = await reader.verify(signal)
    return { objects: r.objects, rows: r.rows }
  })
}

/* ---------- object DDL (backup browser) ---------- */

export async function archiveObjectDdl(
  path: string,
  uuid: string,
  password?: string | null
): Promise<string> {
  if (formatOrThrow(path) === 'nb3') {
    const meta = await (await Nb3Reader.open(path)).objectMeta(uuid)
    return [meta.DDL, ...meta.IndexDDL, ...meta.TriggerDDL]
      .filter((s) => s.trim() !== '')
      .join(';\n')
  }
  return withVqbReader(path, password, async (reader) => {
    await reader.unlock(password)
    const meta = await reader.objectMeta(uuid)
    return [
      await reader.ddl(meta),
      ...(meta.postDdl ?? []),
      ...(meta.comments ?? []),
      ...(meta.indexes ?? []),
      ...(meta.foreignKeys ?? []),
      ...(meta.triggers ?? [])
    ]
      .map((s) => s.trim().replace(/;$/, ''))
      .filter((s) => s !== '')
      .join(';\n')
  })
}

/** Default charset/collation recorded in a .vqb manifest (MySQL), null otherwise. */
export async function vqbCharset(
  path: string,
  password?: string | null
): Promise<{ charset: string; collation: string | null } | null> {
  return withVqbReader(path, password, async (reader) => {
    await reader.unlock(password)
    const source = (await reader.manifest()).source
    return source.charset ? { charset: source.charset, collation: source.collation ?? null } : null
  })
}
