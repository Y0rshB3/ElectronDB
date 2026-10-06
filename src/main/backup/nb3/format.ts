import { createHash } from 'node:crypto'
import type { BackupMeta, BackupObjectSummary } from '@shared/types'

/**
 * Constants and JSON shapes of the Navicat .nb3 format.
 * See docs/navicat-storage.md ("Backup file (.nb3)") for the verified layout.
 */

export const NB3_META_VERSION = '30101'
export const NB3_DATABASE_TYPE = 'MYSQL'
export const NB3_ENCRYPTION_NONE = 'None'
export const NB3_MANIFEST_NAME = 'meta.json'
export const NB3_EXTENSION = '.nb3'

/** Rows inside a data chunk are separated by RS (0x1E) + LF (0x0A). */
export const ROW_SEPARATOR = Buffer.from([0x1e, 0x0a])

/** Uncompressed bytes per data chunk before a new chunk is started. */
export const DATA_CHUNK_LIMIT = 5 * 1024 * 1024

export interface Nb3FileRef {
  Filename: string
  Checksum: string
}

export interface Nb3ManifestObject {
  UUID: string
  Type: string
  Name: string
  /** Row count as string; empty for non-table objects. */
  Rows: string
  Metadata: Nb3FileRef
}

export interface Nb3Manifest {
  MetaVersion: string
  DatabaseType: string
  ServiceProvider: string
  Catalog: string
  Schema: string
  StartTime: string
  EndTime: string
  Encryption: string
  Comment: string
  Objects: Nb3ManifestObject[]
}

export interface Nb3ObjectMeta {
  MetaVersion: string
  Name: string
  Type: string
  DDL: string
  SubDDL: string[]
  AutoIncrement: string
  Fields: string[]
  TriggerDDL: string[]
  IndexDDL: string[]
  Data: Nb3FileRef[]
}

export class Nb3FormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'Nb3FormatError'
  }
}

export const objectMetaEntryName = (uuid: string): string => `${uuid}.meta.json.gz`

export const dataChunkEntryName = (uuid: string, index: number): string =>
  `${uuid}.data.${String(index).padStart(5, '0')}.sql.gz`

export const sha1Upper = (bytes: Uint8Array): string =>
  createHash('sha1').update(bytes).digest('hex').toUpperCase()

export const checksumMatches = (expected: string, actual: string): boolean =>
  expected.trim().toUpperCase() === actual.trim().toUpperCase()

const asString = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : fallback

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []

const asFileRef = (value: unknown): Nb3FileRef | null => {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (typeof v.Filename !== 'string') return null
  return { Filename: v.Filename, Checksum: asString(v.Checksum) }
}

/** Parses and normalises the manifest JSON, rejecting shapes we cannot work with. */
export function parseManifest(json: string): Nb3Manifest {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    throw new Nb3FormatError('El archivo no es un backup .nb3 válido: meta.json ilegible')
  }
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as Record<string, unknown>).Objects)) {
    throw new Nb3FormatError(
      'El archivo no es un backup .nb3 válido: meta.json sin lista de objetos'
    )
  }
  const r = raw as Record<string, unknown>
  const objects: Nb3ManifestObject[] = []
  for (const item of r.Objects as unknown[]) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const metadata = asFileRef(o.Metadata)
    if (typeof o.UUID !== 'string' || !metadata) {
      throw new Nb3FormatError(
        'El archivo no es un backup .nb3 válido: objeto sin UUID o metadatos'
      )
    }
    objects.push({
      UUID: o.UUID,
      Type: asString(o.Type, 'Table'),
      Name: asString(o.Name),
      Rows: typeof o.Rows === 'number' ? String(o.Rows) : asString(o.Rows),
      Metadata: metadata
    })
  }
  return {
    MetaVersion: asString(r.MetaVersion),
    DatabaseType: asString(r.DatabaseType),
    ServiceProvider: asString(r.ServiceProvider),
    Catalog: asString(r.Catalog),
    Schema: asString(r.Schema),
    StartTime: asString(r.StartTime),
    EndTime: asString(r.EndTime),
    Encryption: asString(r.Encryption, NB3_ENCRYPTION_NONE),
    Comment: asString(r.Comment),
    Objects: objects
  }
}

/** Parses and normalises a per-object `<UUID>.meta.json` document. */
export function parseObjectMeta(json: string, uuid: string): Nb3ObjectMeta {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    throw new Nb3FormatError(`Metadatos ilegibles para el objeto ${uuid}`)
  }
  if (!raw || typeof raw !== 'object')
    throw new Nb3FormatError(`Metadatos inválidos para el objeto ${uuid}`)
  const r = raw as Record<string, unknown>
  const data = Array.isArray(r.Data)
    ? r.Data.map(asFileRef).filter((d): d is Nb3FileRef => d !== null)
    : []
  return {
    MetaVersion: asString(r.MetaVersion),
    Name: asString(r.Name),
    Type: asString(r.Type, 'Table'),
    DDL: asString(r.DDL),
    SubDDL: asStringArray(r.SubDDL),
    AutoIncrement:
      typeof r.AutoIncrement === 'number' ? String(r.AutoIncrement) : asString(r.AutoIncrement),
    Fields: asStringArray(r.Fields),
    TriggerDDL: asStringArray(r.TriggerDDL),
    IndexDDL: asStringArray(r.IndexDDL),
    Data: data
  }
}

const parseRows = (rows: string): number | null => {
  if (rows.trim() === '') return null
  const n = Number(rows)
  return Number.isFinite(n) ? n : null
}

const unixToIso = (seconds: string): string | null => {
  const n = Number(seconds)
  if (!seconds || !Number.isFinite(n)) return null
  return new Date(n * 1000).toISOString()
}

/** Converts the raw manifest into the renderer-facing BackupMeta. */
export function toBackupMeta(manifest: Nb3Manifest): BackupMeta {
  const objects: BackupObjectSummary[] = manifest.Objects.map((o) => ({
    uuid: o.UUID,
    type: o.Type,
    name: o.Name,
    rows: parseRows(o.Rows)
  }))
  return {
    metaVersion: manifest.MetaVersion,
    databaseType: manifest.DatabaseType,
    schema: manifest.Schema,
    startTime: unixToIso(manifest.StartTime),
    endTime: unixToIso(manifest.EndTime),
    encryption: manifest.Encryption,
    comment: manifest.Comment,
    objects
  }
}

export const isEncrypted = (manifest: Pick<Nb3Manifest, 'Encryption'>): boolean =>
  manifest.Encryption !== '' && manifest.Encryption !== NB3_ENCRYPTION_NONE
