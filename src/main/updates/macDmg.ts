import { createHash } from 'node:crypto'
import { createWriteStream, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { ParsedRelease } from './release'

/**
 * macOS update download. Squirrel.Mac (electron-updater's mac path) only installs apps signed
 * with an Apple Developer ID, which ElectronDB does not have, so the app downloads the .dmg,
 * checks its SHA-256 against the published SHA256SUMS.txt (or a SHA256SUMS block in the release
 * notes) and opens it; the user drags the app to Applications.
 * Network access is injected so this is unit tested without electron.
 */

export const SHA256SUMS_ASSET = 'SHA256SUMS.txt'
/** A checksum list is a few hundred bytes; anything far larger is not what we asked for. */
const MAX_SUMS_CHARS = 64 * 1024
/** Upper bound when neither the API nor the server gives a size. */
const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024
const SAFE_DMG_NAME = /^[A-Za-z0-9._-]+\.dmg$/

export interface DownloadStream {
  status: number
  /** Content-Length when the server sends it. */
  contentLength: number | null
  body: AsyncIterable<Uint8Array>
}

/** GET with redirects followed (GitHub sends asset downloads to its CDN). */
export type StreamDownload = (url: string, signal: AbortSignal) => Promise<DownloadStream>
/** GET returning the body as text; throws on network errors or non-200 answers. */
export type TextFetch = (url: string, signal: AbortSignal) => Promise<string>

/** Error with a Spanish, user-facing message (shown as is in the dialog). */
export class MacUpdateError extends Error {
  override readonly name = 'MacUpdateError'
}

/** `sha256sum` / `shasum -a 256` output: "<64 hex>  <name>" or "<64 hex> *<name>" per line. */
export function parseSha256Sums(text: string): Map<string, string> {
  const sums = new Map<string, string>()
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*`?([0-9a-fA-F]{64})\s+\*?([^\s`]+)`?\s*$/.exec(raw)
    if (m) sums.set(m[2], m[1].toLowerCase())
  }
  return sums
}

/**
 * Expected SHA-256 of `fileName`: from the SHA256SUMS.txt asset of the release when there is
 * one, else from lines with the same format in the release notes. Null when none is published.
 */
export async function findExpectedSha256(
  release: ParsedRelease,
  fileName: string,
  fetchText: TextFetch,
  signal: AbortSignal
): Promise<string | null> {
  const asset = release.assets.find((a) => a.name === SHA256SUMS_ASSET)
  if (asset) {
    let text: string
    try {
      text = await fetchText(asset.url, signal)
    } catch (err) {
      if (signal.aborted) throw err
      throw new MacUpdateError(
        'No se pudo descargar la lista de sumas SHA-256 de la versión. Comprueba la conexión e inténtalo de nuevo.'
      )
    }
    if (text.length <= MAX_SUMS_CHARS) {
      const sum = parseSha256Sums(text).get(fileName)
      if (sum) return sum
    }
  }
  return parseSha256Sums(release.notes).get(fileName) ?? null
}

export interface VerifiedDownloadOptions {
  url: string
  fileName: string
  /** Lowercase hex SHA-256 the file must have. */
  expectedSha256: string
  /** Size from the GitHub API (0 when unknown). */
  expectedSize: number
  /** Destination folder (Downloads). */
  dir: string
  download: StreamDownload
  signal: AbortSignal
  onProgress: (transferred: number, total: number) => void
}

/**
 * Streams the file to `<dir>/<fileName>.download`, hashing it on the way, and renames it to
 * `<dir>/<fileName>` only when the SHA-256 matches. A mismatch, a cancel or any error deletes
 * the partial file. Returns the final path.
 */
export async function downloadVerified(options: VerifiedDownloadOptions): Promise<string> {
  const { fileName, signal } = options
  if (!SAFE_DMG_NAME.test(fileName))
    throw new MacUpdateError(`El nombre del instalador no es válido: ${fileName}`)
  const finalPath = join(options.dir, fileName)
  const partPath = `${finalPath}.download`

  let response: DownloadStream
  try {
    response = await options.download(options.url, signal)
  } catch (err) {
    if (signal.aborted) throw err
    throw new MacUpdateError(
      'No se pudo descargar el instalador: comprueba la conexión a Internet (o el proxy) e inténtalo de nuevo.'
    )
  }
  if (response.status !== 200)
    throw new MacUpdateError(
      `GitHub respondió con un error (HTTP ${response.status}) al descargar el instalador. Inténtalo de nuevo más tarde.`
    )

  const total = options.expectedSize || response.contentLength || 0
  const limit = total ? total + 1024 * 1024 : MAX_DOWNLOAD_BYTES
  const hash = createHash('sha256')
  const out = createWriteStream(partPath, { mode: 0o644 })
  let writeError: Error | null = null
  const closed = new Promise<void>((resolve) => out.on('close', resolve))
  out.on('error', (err) => {
    writeError = err
  })
  let transferred = 0
  try {
    for await (const chunk of response.body) {
      if (signal.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError')
      if (writeError) throw writeError
      transferred += chunk.byteLength
      if (transferred > limit)
        throw new MacUpdateError(
          'El instalador descargado es más grande de lo esperado y se ha descartado.'
        )
      hash.update(chunk)
      if (!out.write(chunk))
        await new Promise<void>((resolve) => {
          const done = (): void => {
            out.off('drain', done)
            out.off('close', done)
            resolve()
          }
          out.on('drain', done)
          out.on('close', done)
        })
      options.onProgress(transferred, total)
    }
    if (signal.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError')
    out.end()
    await closed
    if (writeError) throw writeError
  } catch (err) {
    out.destroy()
    await closed
    rmSync(partPath, { force: true })
    if (signal.aborted || err instanceof MacUpdateError) throw err
    const code = (err as { code?: string }).code
    throw new MacUpdateError(
      code === 'ENOSPC'
        ? 'No hay espacio libre suficiente en el disco para descargar el instalador.'
        : 'La descarga del instalador se interrumpió. Comprueba la conexión e inténtalo de nuevo.'
    )
  }

  const actual = hash.digest('hex')
  if (actual !== options.expectedSha256.toLowerCase()) {
    rmSync(partPath, { force: true })
    throw new MacUpdateError(
      'El instalador descargado no coincide con la suma SHA-256 publicada y se ha borrado. Vuelve a intentarlo o descárgalo manualmente.'
    )
  }
  renameSync(partPath, finalPath)
  return finalPath
}
