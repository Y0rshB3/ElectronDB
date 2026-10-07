import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { promisify } from 'node:util'
import { gzip as gzipCb } from 'node:zlib'
import {
  DEFAULT_CHUNK_SIZE,
  DEFAULT_SCRYPT,
  encryptEntry,
  newArchiveKeys,
  type ScryptParams
} from './crypto'
import {
  DATA_CHUNK_BYTES,
  HEADER_PATH,
  MANIFEST_PATH,
  VQB_ALGORITHM,
  VQB_FORMAT,
  VQB_FORMAT_VERSION,
  dataPath,
  objectDir,
  objectId,
  sha256,
  type VqbColumn,
  type VqbDataFile,
  type VqbFileRef,
  type VqbHeader,
  type VqbManifest,
  type VqbManifestObject,
  type VqbObjectMeta,
  type VqbObjectType
} from './format'
import { encodeValue, type ValueCodec } from './values'
import { ZipWriter } from './zip'

/**
 * Streams one .vqb archive (docs/vqb-format.md). Rows are encoded as they
 * arrive and written in ~5 MB data files; only the current data file is held
 * in memory. The archive is written to `<target>.partial` and renamed when
 * manifest.json and the ZIP directory are complete, so a crash never leaves a
 * file that looks finished.
 */

const gzip = promisify(gzipCb)
const NEWLINE = Buffer.from('\n')

export type VqbManifestInput = Pick<VqbManifest, 'app' | 'engine' | 'source' | 'options'> & {
  comment?: string
}

export interface VqbWriterOptions {
  manifest: VqbManifestInput
  /** Encrypts every entry but header.json when set. */
  password?: string | null
  /** scrypt cost (tests use a cheap one). */
  scrypt?: ScryptParams
  /** Uncompressed bytes per data file. */
  chunkBytes?: number
  now?: () => Date
}

export interface VqbWriteResult {
  path: string
  sizeBytes: number
  objects: number
  rows: number
}

export class VqbWriter {
  private readonly objects: VqbManifestObject[] = []
  private readonly warnings: string[] = []
  private open: VqbObjectWriter | null = null
  private totalRows = 0
  private finished = false
  private readonly createdAt: string

  private constructor(
    readonly target: string,
    private readonly partial: string,
    private readonly zip: ZipWriter,
    private readonly key: Buffer | null,
    private readonly options: VqbWriterOptions
  ) {
    this.createdAt = (options.now ?? (() => new Date()))().toISOString()
  }

  static async create(target: string, options: VqbWriterOptions): Promise<VqbWriter> {
    await mkdir(dirname(target), { recursive: true })
    const partial = `${target}.partial`
    let header: VqbHeader = {
      format: VQB_FORMAT,
      formatVersion: VQB_FORMAT_VERSION,
      encrypted: false
    }
    let key: Buffer | null = null
    if (options.password) {
      const { kdf, keys } = await newArchiveKeys(options.password, options.scrypt ?? DEFAULT_SCRYPT)
      key = keys.key
      header = {
        ...header,
        encrypted: true,
        encryption: {
          alg: VQB_ALGORITHM,
          chunkSize: DEFAULT_CHUNK_SIZE,
          kdf,
          keyCheck: keys.keyCheck
        }
      }
    }
    const zip = await ZipWriter.create(partial, (options.now ?? (() => new Date()))())
    const writer = new VqbWriter(target, partial, zip, key, options)
    try {
      // The header is the first entry and never encrypted: it says how to read the rest.
      await zip.add(HEADER_PATH, Buffer.from(JSON.stringify(header, null, 2) + '\n', 'utf8'))
    } catch (err) {
      await writer.abort()
      throw err
    }
    return writer
  }

  get chunkBytes(): number {
    return this.options.chunkBytes ?? DATA_CHUNK_BYTES
  }

  /** Stores one entry (gzip first when asked, then encryption); returns its manifest ref. */
  async store(path: string, plain: Buffer, compress: boolean): Promise<VqbFileRef> {
    let body = compress ? await gzip(plain) : plain
    if (this.key) body = encryptEntry(body, this.key, path)
    await this.zip.add(path, body)
    return { path, sha256: sha256(body), bytes: body.length }
  }

  warn(message: string): void {
    this.warnings.push(message)
  }

  /** Starts the next object; the previous one must be finished. */
  beginObject(type: VqbObjectType, name: string, schema?: string): VqbObjectWriter {
    if (this.finished) throw new Error('La copia ya está cerrada')
    if (this.open) throw new Error(`El objeto ${this.open.name} no se ha cerrado`)
    const id = objectId(this.objects.length + 1)
    this.open = new VqbObjectWriter(this, id, type, name, schema)
    return this.open
  }

  /** Called by VqbObjectWriter.finish. */
  objectDone(entry: VqbManifestObject): void {
    this.objects.push(entry)
    this.totalRows += entry.rows ?? 0
    this.open = null
  }

  /** Writes manifest.json and the ZIP directory, then renames the file into place. */
  async finish(): Promise<VqbWriteResult> {
    if (this.open) throw new Error(`El objeto ${this.open.name} no se ha cerrado`)
    const m = this.options.manifest
    const manifest: VqbManifest = {
      format: VQB_FORMAT,
      formatVersion: VQB_FORMAT_VERSION,
      app: m.app,
      engine: m.engine,
      source: m.source,
      createdAt: this.createdAt,
      finishedAt: (this.options.now ?? (() => new Date()))().toISOString(),
      ...(m.comment ? { comment: m.comment } : {}),
      options: m.options,
      encryption: this.key ? { alg: VQB_ALGORITHM, kdf: 'scrypt' } : null,
      objects: this.objects,
      ...(this.warnings.length ? { warnings: this.warnings } : {})
    }
    await this.store(MANIFEST_PATH, Buffer.from(JSON.stringify(manifest, null, 2) + '\n'), false)
    await this.zip.finish()
    this.finished = true
    await rename(this.partial, this.target)
    return {
      path: this.target,
      sizeBytes: (await stat(this.target)).size,
      objects: this.objects.length,
      rows: this.totalRows
    }
  }

  async abort(): Promise<void> {
    this.finished = true
    await this.zip.abort()
    await rm(this.partial, { force: true }).catch(() => undefined)
  }
}

export interface ObjectFinish {
  /** The object's main statement (ddl.sql). */
  ddl: string
  /** Everything else of meta.json (columns come from setColumns). */
  meta?: Omit<VqbObjectMeta, 'name' | 'type' | 'schema' | 'ddl' | 'columns' | 'rows' | 'data'>
}

export class VqbObjectWriter {
  private columns: VqbColumn[] | null = null
  private codecs: ValueCodec[] = []
  private chunk: Buffer[] = []
  private chunkLength = 0
  private chunkRows = 0
  private readonly data: VqbDataFile[] = []
  private readonly files: VqbFileRef[] = []
  rowCount = 0

  constructor(
    private readonly writer: VqbWriter,
    readonly id: string,
    readonly type: VqbObjectType,
    readonly name: string,
    readonly schema: string | undefined
  ) {}

  /** Columns of the rows that follow (tables), with how to read each driver value. */
  setColumns(columns: VqbColumn[], codecs: ValueCodec[]): void {
    if (columns.length !== codecs.length) throw new Error('Columnas y códecs no coinciden')
    this.columns = columns
    this.codecs = codecs
  }

  async addRow(values: readonly unknown[]): Promise<void> {
    if (!this.columns) throw new Error(`Faltan las columnas de ${this.name}`)
    if (values.length !== this.codecs.length)
      throw new Error(`La fila de ${this.name} no tiene ${this.codecs.length} columnas`)
    const encoded = new Array(values.length)
    for (let i = 0; i < values.length; i++) encoded[i] = encodeValue(values[i], this.codecs[i])
    const line = Buffer.from(JSON.stringify(encoded), 'utf8')
    this.chunk.push(line, NEWLINE)
    this.chunkLength += line.length + 1
    this.chunkRows++
    this.rowCount++
    if (this.chunkLength >= this.writer.chunkBytes) await this.flush()
  }

  private async flush(): Promise<void> {
    if (this.chunkRows === 0) return
    const path = dataPath(this.id, this.data.length + 1)
    const plain = Buffer.concat(this.chunk, this.chunkLength)
    const rows = this.chunkRows
    this.chunk = []
    this.chunkLength = 0
    this.chunkRows = 0
    this.files.push(await this.writer.store(path, plain, true))
    this.data.push({ path, rows })
  }

  async finish(input: ObjectFinish): Promise<{ rows: number }> {
    await this.flush()
    const dir = objectDir(this.id)
    const ddlPath = `${dir}/ddl.sql`
    this.files.push(await this.writer.store(ddlPath, Buffer.from(input.ddl, 'utf8'), false))
    const meta: VqbObjectMeta = {
      name: this.name,
      type: this.type,
      ...(this.schema !== undefined ? { schema: this.schema } : {}),
      ddl: ddlPath,
      ...(this.columns ? { columns: this.columns, rows: this.rowCount, data: this.data } : {}),
      ...(input.meta ?? {})
    }
    this.files.push(
      await this.writer.store(
        `${dir}/meta.json`,
        Buffer.from(JSON.stringify(meta, null, 2) + '\n', 'utf8'),
        false
      )
    )
    this.writer.objectDone({
      id: this.id,
      type: this.type,
      name: this.name,
      ...(this.schema !== undefined ? { schema: this.schema } : {}),
      rows: this.columns ? this.rowCount : null,
      files: this.files
    })
    return { rows: this.rowCount }
  }
}
