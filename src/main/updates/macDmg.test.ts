import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  downloadVerified,
  findExpectedSha256,
  MacUpdateError,
  parseSha256Sums,
  type StreamDownload
} from './macDmg'
import { parseRelease } from './release'
import { apiRelease, RELEASES_BASE } from './testing'

const DMG = 'Vortaq-0.1.3-arm64.dmg'
const payload = Buffer.from('fake dmg payload '.repeat(4096))
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')

async function* chunks(buf: Buffer, size = 8192): AsyncIterable<Uint8Array> {
  for (let i = 0; i < buf.length; i += size) yield buf.subarray(i, i + size)
}

const okDownload = (buf = payload): StreamDownload & ReturnType<typeof vi.fn> =>
  vi.fn(async () => ({ status: 200, contentLength: buf.length, body: chunks(buf) })) as never

describe('parseSha256Sums', () => {
  it('reads sha256sum / shasum output, with or without the binary marker and backticks', () => {
    const a = 'a'.repeat(64)
    const b = 'B'.repeat(64)
    const sums = parseSha256Sums(
      `${a}  ${DMG}\n${b} *Vortaq-0.1.3-x64-setup.exe\r\n\`${a}  x.AppImage\`\nnot a line\n${a.slice(1)}  short.dmg`
    )
    expect(sums.get(DMG)).toBe(a)
    expect(sums.get('Vortaq-0.1.3-x64-setup.exe')).toBe('b'.repeat(64))
    expect(sums.get('x.AppImage')).toBe(a)
    expect(sums.has('short.dmg')).toBe(false)
  })
})

describe('findExpectedSha256', () => {
  const signal = new AbortController().signal

  it('prefers the SHA256SUMS.txt asset of the release', async () => {
    const release = parseRelease(
      apiRelease({
        assets: [
          {
            name: 'SHA256SUMS.txt',
            size: 300,
            browser_download_url: `${RELEASES_BASE}/download/v0.1.3/SHA256SUMS.txt`
          }
        ],
        body: `${'c'.repeat(64)}  ${DMG}`
      })
    )!
    const fetchText = vi.fn(async () => `${'d'.repeat(64)}  ${DMG}\n`)
    expect(await findExpectedSha256(release, DMG, fetchText, signal)).toBe('d'.repeat(64))
    expect(fetchText).toHaveBeenCalledWith(
      `${RELEASES_BASE}/download/v0.1.3/SHA256SUMS.txt`,
      signal
    )
  })

  it('falls back to a SHA256SUMS block in the release notes, else null', async () => {
    const withNotes = parseRelease(
      apiRelease({ body: `## SHA256SUMS\n\n${'e'.repeat(64)}  ${DMG}` })
    )!
    expect(await findExpectedSha256(withNotes, DMG, vi.fn(), signal)).toBe('e'.repeat(64))
    const without = parseRelease(apiRelease())!
    expect(await findExpectedSha256(without, DMG, vi.fn(), signal)).toBeNull()
  })

  it('a failed SHA256SUMS.txt download is an actionable error', async () => {
    const release = parseRelease(
      apiRelease({
        assets: [
          {
            name: 'SHA256SUMS.txt',
            size: 300,
            browser_download_url: `${RELEASES_BASE}/download/v0.1.3/SHA256SUMS.txt`
          }
        ]
      })
    )!
    const fetchText = vi.fn(async () => {
      throw new Error('net::ERR_INTERNET_DISCONNECTED')
    })
    await expect(findExpectedSha256(release, DMG, fetchText, signal)).rejects.toThrow(
      /lista de sumas SHA-256/
    )
  })
})

describe('downloadVerified', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vortaq-dmg-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const options = (overrides: Partial<Parameters<typeof downloadVerified>[0]> = {}) => ({
    url: `${RELEASES_BASE}/download/v0.1.3/${DMG}`,
    fileName: DMG,
    expectedSha256: sha(payload),
    expectedSize: payload.length,
    dir,
    download: okDownload(),
    signal: new AbortController().signal,
    onProgress: vi.fn(),
    ...overrides
  })

  it('writes the file only after the SHA-256 matches and reports progress', async () => {
    const opts = options()
    const path = await downloadVerified(opts)
    expect(path).toBe(join(dir, DMG))
    expect(readFileSync(path).equals(payload)).toBe(true)
    expect(readdirSync(dir)).toEqual([DMG])
    const calls = (opts.onProgress as ReturnType<typeof vi.fn>).mock.calls
    expect(calls.at(-1)).toEqual([payload.length, payload.length])
    expect(calls.length).toBeGreaterThan(1)
  })

  it('deletes the download when the checksum does not match', async () => {
    await expect(downloadVerified(options({ expectedSha256: 'f'.repeat(64) }))).rejects.toThrow(
      /no coincide con la suma SHA-256/
    )
    expect(readdirSync(dir)).toEqual([])
  })

  it('a cancel stops the stream and leaves nothing behind', async () => {
    const abort = new AbortController()
    const download: StreamDownload = async () => ({
      status: 200,
      contentLength: payload.length,
      body: (async function* () {
        yield payload.subarray(0, 1000)
        abort.abort()
        yield payload.subarray(1000, 2000)
      })()
    })
    const err = await downloadVerified(options({ download, signal: abort.signal })).catch(
      (e: unknown) => e
    )
    expect((err as Error).name).toBe('AbortError')
    expect(readdirSync(dir)).toEqual([])
  })

  it('rejects HTTP errors, oversized bodies and unsafe file names', async () => {
    const notFound: StreamDownload = async () => ({
      status: 404,
      contentLength: null,
      body: chunks(Buffer.alloc(0))
    })
    await expect(downloadVerified(options({ download: notFound }))).rejects.toThrow(/HTTP 404/)
    await expect(
      downloadVerified(
        options({ expectedSize: 10, download: okDownload(Buffer.alloc(2 * 1024 * 1024)) })
      )
    ).rejects.toBeInstanceOf(MacUpdateError)
    expect(readdirSync(dir)).toEqual([])
    await expect(downloadVerified(options({ fileName: '../evil.dmg' }))).rejects.toThrow(
      /no es válido/
    )
    expect(existsSync(join(dir, '..', 'evil.dmg'))).toBe(false)
  })
})
