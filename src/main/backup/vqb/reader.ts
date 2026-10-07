import { promisify } from 'node:util'
import { gunzip as gunzipCb } from 'node:zlib'
import { decryptEntry, unlockArchive } from './crypto'
import { VqbFormatError, VqbIntegrityError } from './errors'
import {
  HEADER_PATH,
  MANIFEST_PATH,
  parseJson,
  sha256,
  validateHeader,
  validateManifest,
  validateObjectMeta,
  type VqbFileRef,
  type VqbHeader,
  type VqbManifest,
  type VqbManifestObject,
  type VqbObjectMeta
} from './format'
import { checkValue, VqbValueError, type VqbValue } from './values'
import { ZipReader } from './zip'

/**
 * Reads a .vqb archive (docs/vqb-format.md). Opening reads only the ZIP
 * directory and header.json; an encrypted archive needs `unlock(password)`
 * before the manifest or any object can be read. Every entry is checked
 * against its manifest SHA-256 (and, encrypted, every chunk's GCM tag) before
 * it is used.
 */

const gunzip = promisify(gunzipCb)

export const VQB_CANCELLED = 'Lectura de la copia cancelada'

export interface VqbVerifyResult {
  objects: number
  rows: number
  files: number
}

export class VqbReader {
  private key: Buffer | null = null
  private manifestCache: VqbManifest | null = null
  private readonly refs = new Map<string, VqbFileRef>()

  private constructor(
    readonly path: string,
    private readonly zip: ZipReader,
    readonly header: VqbHeader
  ) {}

  static async open(path: string, password?: string | null): Promise<VqbReader> {
    const zip = await ZipReader.open(path)
    try {
      if (!zip.has(HEADER_PATH))
        throw new VqbFormatError('El archivo no es una copia .vqb válida (no tiene header.json).')
      const header = validateHeader(parseJson(await zip.read(HEADER_PATH), 'header.json'))
      const reader = new VqbReader(path, zip, header)
      if (header.encrypted && password) await reader.unlock(password)
      return reader
    } catch (err) {
      await zip.close()
      throw err
    }
  }

  get encrypted(): boolean {
    return this.header.encrypted
  }

  get unlocked(): boolean {
    return !this.header.encrypted || this.key !== null
  }

  /** Derives the key; throws VqbPasswordError for a missing or wrong password. */
  async unlock(password: string | null | undefined): Promise<void> {
    if (!this.header.encrypted || this.key) return
    const e = this.header.encryption!
    this.key = await unlockArchive(password, e.kdf, e.keyCheck)
  }

  /** Plaintext of one entry (decrypted, not gunzipped); `ref` is checked when given. */
  private async entry(path: string, ref: VqbFileRef | null): Promise<Buffer> {
    if (this.header.encrypted && !this.key) await this.unlock(null)
    const stored = await this.zip.read(path)
    if (ref && (stored.length !== ref.bytes || sha256(stored) !== ref.sha256))
      throw new VqbIntegrityError(path)
    return this.key ? decryptEntry(stored, this.key, path) : stored
  }

  async manifest(): Promise<VqbManifest> {
    if (this.manifestCache) return this.manifestCache
    const manifest = validateManifest(
      parseJson(await this.entry(MANIFEST_PATH, null), 'manifest.json')
    )
    if (manifest.formatVersion !== this.header.formatVersion)
      throw new VqbFormatError(
        'La copia .vqb no es válida: la cabecera y el manifiesto no coinciden.'
      )
    if (!!manifest.encryption !== this.header.encrypted)
      throw new VqbFormatError('La copia .vqb no es válida: el cifrado declarado no coincide.')
    for (const o of manifest.objects) for (const f of o.files) this.refs.set(f.path, f)
    this.manifestCache = manifest
    return manifest
  }

  private async file(path: string): Promise<Buffer> {
    await this.manifest()
    const ref = this.refs.get(path)
    if (!ref)
      throw new VqbFormatError(`La copia .vqb no es válida: ${path} no está en el manifiesto.`)
    return this.entry(path, ref)
  }

  async object(id: string): Promise<VqbManifestObject> {
    const found = (await this.manifest()).objects.find((o) => o.id === id)
    if (!found) throw new VqbFormatError(`La copia no contiene el objeto ${id}.`)
    return found
  }

  async objectMeta(id: string): Promise<VqbObjectMeta> {
    const object = await this.object(id)
    const path = `objects/${id}/meta.json`
    return validateObjectMeta(parseJson(await this.file(path), path), object)
  }

  async ddl(meta: VqbObjectMeta): Promise<string> {
    return (await this.file(meta.ddl)).toString('utf8')
  }

  /**
   * Rows of a table in order, as checked values. `onRows` receives each data
   * file's rows (one array per row) so callers can batch.
   */
  async rows(
    meta: VqbObjectMeta,
    onRow: (row: VqbValue[]) => Promise<void> | void,
    signal?: AbortSignal
  ): Promise<number> {
    const width = meta.columns?.length ?? 0
    let count = 0
    for (const d of meta.data ?? []) {
      if (signal?.aborted) throw new Error(VQB_CANCELLED)
      const lines = await this.dataLines(d.path)
      if (lines.length !== d.rows) throw new VqbIntegrityError(d.path)
      for (const line of lines) {
        if (signal?.aborted) throw new Error(VQB_CANCELLED)
        await onRow(parseRow(line, width, d.path))
        count++
      }
    }
    if (meta.rows !== undefined && count !== meta.rows) throw new VqbIntegrityError(meta.ddl)
    return count
  }

  private async dataLines(path: string): Promise<string[]> {
    let plain: Buffer
    const body = await this.file(path)
    try {
      plain = await gunzip(body)
    } catch {
      throw new VqbIntegrityError(path)
    }
    if (plain.length === 0) return []
    const text = plain.toString('utf8')
    if (!text.endsWith('\n')) throw new VqbIntegrityError(path)
    return text.slice(0, -1).split('\n')
  }

  /**
   * Full check: every file's checksum (and GCM tags), every data file
   * decompressed and parsed, row counts matching meta.json and the manifest.
   */
  async verify(signal?: AbortSignal): Promise<VqbVerifyResult> {
    const manifest = await this.manifest()
    let rows = 0
    let files = 1
    for (const o of manifest.objects) {
      if (signal?.aborted) throw new Error(VQB_CANCELLED)
      const meta = await this.objectMeta(o.id)
      await this.ddl(meta)
      files += 2
      const listed = new Set(o.files.map((f) => f.path))
      for (const d of meta.data ?? [])
        if (!listed.has(d.path))
          throw new VqbFormatError(`La copia .vqb no es válida: falta ${d.path}.`)
      const width = meta.columns?.length ?? 0
      let objectRows = 0
      for (const d of meta.data ?? []) {
        if (signal?.aborted) throw new Error(VQB_CANCELLED)
        const lines = await this.dataLines(d.path)
        if (lines.length !== d.rows) throw new VqbIntegrityError(d.path)
        for (const line of lines) parseRow(line, width, d.path)
        objectRows += lines.length
        files++
      }
      if ((o.rows ?? 0) !== objectRows && !(o.rows === null && objectRows === 0))
        throw new VqbIntegrityError(`objects/${o.id}/meta.json`)
      rows += objectRows
    }
    return { objects: manifest.objects.length, rows, files }
  }

  async close(): Promise<void> {
    this.key = null
    await this.zip.close()
  }
}

function parseRow(line: string, width: number, path: string): VqbValue[] {
  let row: unknown
  try {
    row = JSON.parse(line)
  } catch {
    throw new VqbIntegrityError(path)
  }
  if (!Array.isArray(row) || row.length !== width) throw new VqbIntegrityError(path)
  try {
    for (let i = 0; i < row.length; i++) checkValue(row[i])
  } catch (err) {
    if (err instanceof VqbValueError)
      throw new VqbFormatError(`La copia .vqb no es válida: ${err.message} en ${path}.`)
    throw err
  }
  return row as VqbValue[]
}

/** Opens, runs `fn` and always closes. */
export async function withVqbReader<T>(
  path: string,
  password: string | null | undefined,
  fn: (reader: VqbReader) => Promise<T>
): Promise<T> {
  const reader = await VqbReader.open(path, password)
  try {
    return await fn(reader)
  } finally {
    await reader.close()
  }
}
