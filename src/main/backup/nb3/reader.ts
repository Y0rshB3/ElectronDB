import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { Readable, Transform, pipeline } from 'node:stream'
import { createGunzip, gunzipSync, type Gunzip } from 'node:zlib'
import type { BackupMeta } from '@shared/types'
import {
  NB3_MANIFEST_NAME,
  Nb3FormatError,
  checksumMatches,
  isEncrypted,
  objectMetaEntryName,
  parseManifest,
  parseObjectMeta,
  toBackupMeta,
  type Nb3Manifest,
  type Nb3ObjectMeta
} from './format'
import { RowSplitter } from './rows'
import { indexTar, readTarEntry, type TarEntry } from './tar'

export type RowVisitor = (tuple: string) => Promise<void> | void

/** Entries up to this size are buffered so their checksum is verified before any row is delivered. */
const VERIFY_FIRST_LIMIT = 32 * 1024 * 1024
/** Upper bound for entries we are willing to hold in memory (manifest, object metadata). */
const MAX_BUFFERED_ENTRY = 256 * 1024 * 1024

export const ENCRYPTED_MESSAGE = 'Copias cifradas no soportadas'
export const CANCELLED_MESSAGE = 'Operación cancelada'

export class OperationCancelledError extends Error {
  constructor(message = CANCELLED_MESSAGE) {
    super(message)
    this.name = 'OperationCancelledError'
  }
}

export const isCancelled = (err: unknown): boolean => err instanceof OperationCancelledError

const checksumError = (name: string): Nb3FormatError =>
  new Nb3FormatError(`La copia de seguridad está dañada: la suma de verificación de ${name} no coincide`)

const describeFsError = (path: string, err: unknown): Error => {
  const code = (err as { code?: string })?.code
  if (code === 'ENOENT') return new Error(`No se encontró el archivo de la copia: ${path}`)
  if (code === 'EACCES' || code === 'EPERM')
    return new Error(`Sin permisos para leer el archivo de la copia: ${path}`)
  return err instanceof Error ? err : new Error(String(err))
}

/**
 * Random-access reader for one .nb3 archive. Indexes the tar headers once
 * (cheap) and then reads entries by byte range, streaming data chunks
 * through gunzip so memory stays bounded by one gz chunk.
 */
export class Nb3Reader {
  private manifestCache: Nb3Manifest | null = null

  private constructor(
    readonly path: string,
    private readonly entries: Map<string, TarEntry>
  ) {}

  static async open(path: string): Promise<Nb3Reader> {
    let list: TarEntry[]
    try {
      list = await indexTar(path)
    } catch (err) {
      throw describeFsError(path, err)
    }
    if (!list.some((e) => e.name === NB3_MANIFEST_NAME)) {
      throw new Nb3FormatError(`El archivo no es una copia .nb3 válida (falta meta.json): ${path}`)
    }
    return new Nb3Reader(path, new Map(list.map((e) => [e.name, e])))
  }

  entryNames(): string[] {
    return [...this.entries.keys()]
  }

  private entry(name: string): TarEntry {
    const entry = this.entries.get(name)
    if (!entry) throw new Nb3FormatError(`La copia de seguridad está incompleta: falta la entrada ${name}`)
    return entry
  }

  private async readSmallEntry(name: string): Promise<Buffer> {
    const entry = this.entry(name)
    if (entry.size > MAX_BUFFERED_ENTRY)
      throw new Nb3FormatError(`La entrada ${name} es demasiado grande para leerse`)
    return readTarEntry(this.path, entry)
  }

  async manifest(): Promise<Nb3Manifest> {
    if (!this.manifestCache) {
      this.manifestCache = parseManifest(
        (await this.readSmallEntry(NB3_MANIFEST_NAME)).toString('utf8')
      )
    }
    return this.manifestCache
  }

  private async assertNotEncrypted(): Promise<Nb3Manifest> {
    const manifest = await this.manifest()
    if (isEncrypted(manifest)) throw new Error(ENCRYPTED_MESSAGE)
    return manifest
  }

  /** Reads and verifies `<uuid>.meta.json.gz`. */
  async objectMeta(uuid: string): Promise<Nb3ObjectMeta> {
    const manifest = await this.assertNotEncrypted()
    const summary = manifest.Objects.find((o) => o.UUID === uuid)
    const name = summary?.Metadata.Filename || objectMetaEntryName(uuid)
    const gz = await this.readSmallEntry(name)
    if (summary?.Metadata.Checksum && !checksumMatches(summary.Metadata.Checksum, sha1(gz))) {
      throw checksumError(name)
    }
    let json: string
    try {
      json = gunzipSync(gz).toString('utf8')
    } catch {
      throw new Nb3FormatError(`La copia de seguridad está dañada: no se pudo descomprimir ${name}`)
    }
    return parseObjectMeta(json, uuid)
  }

  /**
   * Streams every row tuple of an object, chunk by chunk, in `Data` order.
   * Each gz entry is checked against its SHA1 (before delivering rows when
   * the entry fits in memory, otherwise after). Returns the row count.
   */
  async rows(meta: Nb3ObjectMeta, onRow: RowVisitor, signal?: AbortSignal): Promise<number> {
    await this.assertNotEncrypted()
    let count = 0
    for (const ref of meta.Data) {
      throwIfAborted(signal)
      const entry = this.entry(ref.Filename)
      if (entry.size <= VERIFY_FIRST_LIMIT) {
        const gz = await readTarEntry(this.path, entry)
        if (!checksumMatches(ref.Checksum, sha1(gz))) throw checksumError(ref.Filename)
        count += await consumeChunk(
          (gunzip, cb) => pipeline(Readable.from([gz]), gunzip, cb),
          ref.Filename,
          onRow,
          signal
        )
        continue
      }
      // Large entry: stream from disk and verify once the chunk has been consumed.
      const hash = createHash('sha1')
      const tap = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          hash.update(chunk)
          cb(null, chunk)
        }
      })
      const file = createReadStream(this.path, {
        start: entry.offset,
        end: entry.offset + entry.size - 1
      })
      count += await consumeChunk(
        (gunzip, cb) => pipeline(file, tap, gunzip, cb),
        ref.Filename,
        onRow,
        signal
      )
      if (!checksumMatches(ref.Checksum, hash.digest('hex'))) throw checksumError(ref.Filename)
    }
    return count
  }

  /**
   * Reads the whole archive once without delivering anything: every object
   * metadata entry and every data chunk is checked against its SHA1 and fully
   * decompressed. Used before an irreversible step (a REPLACE drops the target
   * database first) so a damaged file is refused while nothing has changed.
   */
  async verify(
    signal?: AbortSignal,
    onObject?: (done: number, total: number) => void
  ): Promise<Nb3VerifyResult> {
    const manifest = await this.assertNotEncrypted()
    const result: Nb3VerifyResult = { objects: 0, chunks: 0, rows: 0 }
    const total = manifest.Objects.length
    for (const object of manifest.Objects) {
      throwIfAborted(signal)
      const meta = await this.objectMeta(object.UUID)
      for (const ref of meta.Data) {
        throwIfAborted(signal)
        const entry = this.entry(ref.Filename)
        const hash = createHash('sha1')
        const tap = new Transform({
          transform(chunk: Buffer, _enc, cb) {
            hash.update(chunk)
            cb(null, chunk)
          }
        })
        const file = createReadStream(this.path, {
          start: entry.offset,
          end: entry.offset + entry.size - 1
        })
        result.rows += await consumeChunk(
          (gunzip, cb) => pipeline(file, tap, gunzip, cb),
          ref.Filename,
          () => undefined,
          signal
        )
        if (!checksumMatches(ref.Checksum, hash.digest('hex'))) throw checksumError(ref.Filename)
        result.chunks++
      }
      result.objects++
      onObject?.(result.objects, total)
    }
    return result
  }
}

export interface Nb3VerifyResult {
  objects: number
  /** Data chunks read and verified. */
  chunks: number
  rows: number
}

type PipelineBuilder = (gunzip: Gunzip, done: (err: NodeJS.ErrnoException | null) => void) => void

/** Marks errors raised by the row visitor so they are never mistaken for archive corruption. */
class VisitorError extends Error {
  constructor(readonly inner: unknown) {
    super('row visitor failed')
  }
}

/** Gunzips one data chunk and feeds the row splitter, honouring backpressure from `onRow`. */
async function consumeChunk(
  build: PipelineBuilder,
  name: string,
  onRow: RowVisitor,
  signal?: AbortSignal
): Promise<number> {
  const gunzip = createGunzip()
  build(gunzip, () => {
    /* errors surface through the async iterator below */
  })
  const splitter = new RowSplitter()
  let count = 0
  const deliver = async (row: string): Promise<void> => {
    throwIfAborted(signal)
    try {
      await onRow(row)
    } catch (err) {
      throw new VisitorError(err)
    }
    count++
  }
  try {
    for await (const plain of gunzip as AsyncIterable<Buffer>) {
      for (const row of splitter.push(plain)) await deliver(row)
    }
    const rest = splitter.flush()
    if (rest !== null && rest.length > 0) await deliver(rest)
  } catch (err) {
    if (err instanceof VisitorError) throw err.inner
    if (isCancelled(err)) throw err
    throw new Nb3FormatError(`La copia de seguridad está dañada: no se pudo descomprimir ${name}`)
  } finally {
    if (!gunzip.destroyed) gunzip.destroy()
  }
  return count
}

const sha1 = (bytes: Uint8Array): string => createHash('sha1').update(bytes).digest('hex')

export function throwIfAborted(signal: AbortSignal | undefined, message = CANCELLED_MESSAGE): void {
  if (signal?.aborted) throw new OperationCancelledError(message)
}

/* ---------- Convenience functions ---------- */

/** Reads the manifest (last tar entry) and maps it to BackupMeta. */
export async function readManifest(path: string): Promise<BackupMeta> {
  const reader = await Nb3Reader.open(path)
  return toBackupMeta(await reader.manifest())
}

export async function readObjectMeta(path: string, uuid: string): Promise<Nb3ObjectMeta> {
  const reader = await Nb3Reader.open(path)
  return reader.objectMeta(uuid)
}

/** Full integrity check of a .nb3 (see Nb3Reader.verify). */
export async function verifyBackupFile(
  path: string,
  signal?: AbortSignal
): Promise<Nb3VerifyResult> {
  const reader = await Nb3Reader.open(path)
  return reader.verify(signal)
}

export async function iterateObjectRows(
  path: string,
  objectMeta: Nb3ObjectMeta,
  onRow: RowVisitor,
  signal?: AbortSignal
): Promise<number> {
  const reader = await Nb3Reader.open(path)
  return reader.rows(objectMeta, onRow, signal)
}
