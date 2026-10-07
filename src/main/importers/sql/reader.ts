import { createReadStream, type ReadStream } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { createGunzip } from 'node:zlib'

/**
 * Reads a .sql or .sql.gz file as text chunks without loading it whole.
 * `bytesRead` is the position in the file itself (compressed bytes for gzip),
 * so progress matches the file size the user sees.
 */

export interface DumpChunk {
  text: string
  bytesRead: number
}

export interface DumpFileInfo {
  path: string
  fileName: string
  sizeBytes: number
  gzip: boolean
}

const READ_CHUNK = 256 * 1024

/** Stat + gzip detection (magic bytes 1f 8b, or the .gz extension). */
export async function dumpFileInfo(path: string): Promise<DumpFileInfo> {
  let size: number
  try {
    const s = await stat(path)
    if (!s.isFile()) throw new Error(`La ruta no es un archivo: ${path}`)
    size = s.size
  } catch (err) {
    const code = (err as { code?: string }).code
    if (code === 'ENOENT') throw new Error(`No se encontró el archivo: ${path}`)
    if (code === 'EACCES' || code === 'EPERM')
      throw new Error(`Sin permisos para leer el archivo: ${path}`)
    throw err
  }
  let gzip = /\.gz$/i.test(path)
  if (size >= 2) {
    const handle = await open(path, 'r')
    try {
      const head = Buffer.alloc(2)
      await handle.read(head, 0, 2, 0)
      if (head[0] === 0x1f && head[1] === 0x8b) gzip = true
      else if (gzip) gzip = false // named .gz but plain text
    } finally {
      await handle.close()
    }
  }
  return { path, fileName: basename(path), sizeBytes: size, gzip }
}

/**
 * Text chunks of the file, a leading UTF-8 BOM removed. Stops early when
 * `signal` aborts; breaking out of the loop closes the file.
 *
 * - 'utf8': decoded text (multibyte characters split across reads decoded correctly);
 * - 'binary': one character per byte (latin1), so the bytes can be sent to the
 *   server unchanged with `MysqlSession.executeRaw` — the way the mysql client
 *   reads a dump (raw BLOB bytes included).
 */
export async function* readDumpChunks(
  info: DumpFileInfo,
  signal?: AbortSignal,
  encoding: 'utf8' | 'binary' = 'utf8'
): AsyncGenerator<DumpChunk> {
  const raw: ReadStream = createReadStream(info.path, { highWaterMark: READ_CHUNK })
  const gunzip = info.gzip ? createGunzip() : null
  const source = gunzip ? raw.pipe(gunzip) : raw
  if (gunzip) raw.on('error', (err) => gunzip.destroy(err))
  const decoder = encoding === 'utf8' ? new TextDecoder('utf-8') : null
  // binary: the BOM bytes may arrive split across the first reads
  let head: Buffer | null = encoding === 'binary' ? Buffer.alloc(0) : null
  try {
    for await (const piece of source as AsyncIterable<Buffer>) {
      if (signal?.aborted) return
      let text: string
      if (decoder) text = decoder.decode(piece, { stream: true })
      else if (head) {
        head = Buffer.concat([head, piece])
        if (head.length < 3) continue
        const bom = head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf
        text = head.subarray(bom ? 3 : 0).toString('latin1')
        head = null
      } else text = piece.toString('latin1')
      if (text) yield { text, bytesRead: raw.bytesRead }
    }
    let rest = decoder ? decoder.decode() : ''
    if (head?.length) {
      const bom = head.length >= 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf
      rest = head.subarray(bom ? 3 : 0).toString('latin1')
    }
    yield { text: rest, bytesRead: raw.bytesRead }
  } catch (err) {
    if (gunzip && (err as { code?: string }).code?.startsWith('Z_'))
      throw new Error(`El archivo ${info.fileName} no es un .gz válido o está dañado.`)
    throw err
  } finally {
    raw.destroy()
    gunzip?.destroy()
  }
}
