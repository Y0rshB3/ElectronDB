import { randomUUID } from 'node:crypto'
import { mkdir, open, rename, stat, unlink, type FileHandle } from 'node:fs/promises'
import { dirname } from 'node:path'
import { promisify } from 'node:util'
import { gzip as gzipCb } from 'node:zlib'
import {
  DATA_CHUNK_LIMIT,
  NB3_DATABASE_TYPE,
  NB3_ENCRYPTION_NONE,
  NB3_MANIFEST_NAME,
  NB3_META_VERSION,
  ROW_SEPARATOR,
  dataChunkEntryName,
  objectMetaEntryName,
  sha1Upper,
  type Nb3FileRef,
  type Nb3Manifest,
  type Nb3ManifestObject,
  type Nb3ObjectMeta
} from './format'
import { encodeTarHeader, tarBodyPadding, tarTrailer } from './tar'

export interface Nb3WriterOptions {
  schema: string
  comment?: string
  /** Unix seconds; defaults to now. */
  startTime?: number
  /** Uncompressed bytes per data chunk; defaults to DATA_CHUNK_LIMIT. */
  chunkLimit?: number
}

export interface ObjectDefinition {
  ddl: string
  subDdl?: string[]
  autoIncrement?: string
  fields?: string[]
  triggerDdl?: string[]
  indexDdl?: string[]
}

export interface Nb3WriteResult {
  path: string
  sizeBytes: number
  objects: number
  rows: number
}

const unixNow = (): number => Math.floor(Date.now() / 1000)

const gzipAsync = promisify(gzipCb)
/** Node writes MTIME = 0 and no file name in the gzip header, matching Navicat's entries. */
const gzip = (bytes: Buffer): Promise<Buffer> => gzipAsync(bytes, { level: 6 })

/**
 * Writes a .nb3 archive. Bytes go to `<target>.partial` (mode 0600) with
 * sequential awaited writes, so memory stays bounded by one data chunk; the
 * file is renamed to `<target>` only after `meta.json` (the last entry) and the
 * tar trailer are on disk. Any failure or `abort()` removes the partial file.
 * Entry order: data chunks of an object, its `<uuid>.meta.json.gz`, next
 * object..., `meta.json`. Only one object may be open at a time.
 */
export class Nb3Writer {
  private readonly objects: Nb3ManifestObject[] = []
  private readonly startTime: number
  private readonly chunkLimit: number
  private current: Nb3ObjectWriter | null = null
  private finished = false
  private aborted = false
  private totalRows = 0
  private bytesWritten = 0
  private writing: Promise<void> = Promise.resolve()

  readonly partialPath: string

  private constructor(
    readonly targetPath: string,
    private readonly options: Nb3WriterOptions,
    private readonly fh: FileHandle
  ) {
    this.partialPath = `${targetPath}.partial`
    this.startTime = options.startTime ?? unixNow()
    this.chunkLimit = options.chunkLimit ?? DATA_CHUNK_LIMIT
  }

  static async create(targetPath: string, options: Nb3WriterOptions): Promise<Nb3Writer> {
    await mkdir(dirname(targetPath), { recursive: true })
    const fh = await open(`${targetPath}.partial`, 'w', 0o600)
    return new Nb3Writer(targetPath, options, fh)
  }

  get objectCount(): number {
    return this.objects.length
  }

  /** Starts a new object. The previous one must be finished. */
  beginObject(
    type: string,
    name: string,
    uuid: string = randomUUID().toUpperCase()
  ): Nb3ObjectWriter {
    this.assertOpen()
    if (this.current) throw new Error(`Writer busy: object ${this.current.name} not finished`)
    this.current = new Nb3ObjectWriter(this, type, name, uuid, this.chunkLimit)
    return this.current
  }

  /** @internal Called by Nb3ObjectWriter when done. */
  completeObject(writer: Nb3ObjectWriter, summary: Nb3ManifestObject, rows: number): void {
    if (this.current !== writer) throw new Error('Object writer mismatch')
    this.objects.push(summary)
    this.totalRows += rows
    this.current = null
  }

  /** @internal Appends one tar entry. Calls are serialised. */
  addEntry(name: string, bytes: Buffer): Promise<void> {
    this.assertOpen()
    const next = this.writing.then(async () => {
      this.assertOpen()
      await this.write(encodeTarHeader(name, bytes.length))
      await this.write(bytes)
      await this.write(tarBodyPadding(bytes.length))
    })
    // Keep the chain alive for later callers; the error is reported to this caller.
    this.writing = next.catch(() => {})
    return next
  }

  private async write(buf: Buffer): Promise<void> {
    let offset = 0
    while (offset < buf.length) {
      const { bytesWritten } = await this.fh.write(buf, offset, buf.length - offset)
      offset += bytesWritten
    }
    this.bytesWritten += buf.length
  }

  /** Writes meta.json, closes the tar and renames the partial file. */
  async finish(): Promise<Nb3WriteResult> {
    this.assertOpen()
    if (this.current) throw new Error(`Cannot finish: object ${this.current.name} still open`)
    try {
      const manifest: Nb3Manifest = {
        MetaVersion: NB3_META_VERSION,
        DatabaseType: NB3_DATABASE_TYPE,
        ServiceProvider: '',
        Catalog: '',
        Schema: this.options.schema,
        StartTime: String(this.startTime),
        EndTime: String(unixNow()),
        Encryption: NB3_ENCRYPTION_NONE,
        Comment: this.options.comment ?? '',
        Objects: this.objects
      }
      await this.addEntry(NB3_MANIFEST_NAME, Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'))
      await this.writing
      await this.write(tarTrailer(this.bytesWritten))
      await this.fh.sync()
      await this.fh.close()
      this.finished = true
      await rename(this.partialPath, this.targetPath)
      const { size } = await stat(this.targetPath)
      return {
        path: this.targetPath,
        sizeBytes: size,
        objects: this.objects.length,
        rows: this.totalRows
      }
    } catch (err) {
      await this.abort()
      throw err
    }
  }

  /** Closes the file and removes the partial archive. Safe to call more than once. */
  async abort(): Promise<void> {
    if (this.aborted) return
    this.aborted = true
    this.current = null
    await this.writing.catch(() => {})
    if (!this.finished) await this.fh.close().catch(() => {})
    await unlink(this.partialPath).catch(() => {})
  }

  private assertOpen(): void {
    if (this.aborted) throw new Error('Nb3Writer aborted')
    if (this.finished) throw new Error('Nb3Writer already finished')
  }
}

/** Accumulates rows of one object into data chunks of at most `chunkLimit` bytes, then writes its metadata. */
export class Nb3ObjectWriter {
  private pending: Buffer[] = []
  private pendingBytes = 0
  private chunkIndex = 0
  private rows = 0
  private readonly data: Nb3FileRef[] = []
  private closed = false

  constructor(
    private readonly owner: Nb3Writer,
    readonly type: string,
    readonly name: string,
    readonly uuid: string,
    private readonly chunkLimit: number
  ) {}

  get rowCount(): number {
    return this.rows
  }

  /** Adds one `(v1, v2, ...)` tuple. A new chunk starts when this row would push the current one past the limit. */
  async addRow(tuple: string): Promise<void> {
    if (this.closed) throw new Error('Object writer already finished')
    const bytes = Buffer.from(tuple, 'utf8')
    if (
      this.pendingBytes > 0 &&
      this.pendingBytes + ROW_SEPARATOR.length + bytes.length > this.chunkLimit
    ) {
      await this.flushChunk()
    }
    if (this.pendingBytes > 0) {
      this.pending.push(ROW_SEPARATOR)
      this.pendingBytes += ROW_SEPARATOR.length
    }
    this.pending.push(bytes)
    this.pendingBytes += bytes.length
    this.rows++
  }

  private async flushChunk(): Promise<void> {
    if (this.pendingBytes === 0) return
    const plain = Buffer.concat(this.pending, this.pendingBytes)
    this.pending = []
    this.pendingBytes = 0
    const gz = await gzip(plain)
    const name = dataChunkEntryName(this.uuid, this.chunkIndex++)
    await this.owner.addEntry(name, gz)
    this.data.push({ Filename: name, Checksum: sha1Upper(gz) })
  }

  /** Flushes remaining rows, writes `<uuid>.meta.json.gz` and registers the object in the manifest. */
  async finish(definition: ObjectDefinition): Promise<{ rows: number; chunks: number }> {
    if (this.closed) throw new Error('Object writer already finished')
    this.closed = true
    await this.flushChunk()
    const meta: Nb3ObjectMeta = {
      MetaVersion: NB3_META_VERSION,
      Name: this.name,
      Type: this.type,
      DDL: definition.ddl,
      SubDDL: definition.subDdl ?? [],
      AutoIncrement: definition.autoIncrement ?? '',
      Fields: definition.fields ?? [],
      TriggerDDL: definition.triggerDdl ?? [],
      IndexDDL: definition.indexDdl ?? [],
      Data: this.data
    }
    const gz = await gzip(Buffer.from(JSON.stringify(meta), 'utf8'))
    const filename = objectMetaEntryName(this.uuid)
    await this.owner.addEntry(filename, gz)
    this.owner.completeObject(
      this,
      {
        UUID: this.uuid,
        Type: this.type,
        Name: this.name,
        Rows: this.type === 'Table' ? String(this.rows) : '',
        Metadata: { Filename: filename, Checksum: sha1Upper(gz) }
      },
      this.rows
    )
    return { rows: this.rows, chunks: this.data.length }
  }
}
