import { open, type FileHandle } from 'node:fs/promises'
import { Nb3FormatError } from './format'

/**
 * Minimal ustar/pax header walker. It reads only the 512-byte headers with
 * positioned reads and skips over entry bodies, so indexing a multi-GB
 * archive costs one small read per entry instead of a full sequential scan.
 * Entry bodies are later read by byte range.
 */

export const TAR_BLOCK = 512

export interface TarEntry {
  name: string
  /** Absolute offset of the entry body inside the archive. */
  offset: number
  size: number
}

const cstr = (block: Buffer, start: number, length: number): string => {
  const end = block.indexOf(0, start)
  const stop = end === -1 || end > start + length ? start + length : end
  return block.toString('utf8', start, stop)
}

const parseNumeric = (field: Buffer): number => {
  if (field.length > 0 && (field[0] & 0x80) !== 0) {
    // GNU base-256 encoding for large sizes.
    let value = 0
    for (let i = 0; i < field.length; i++)
      value = value * 256 + (i === 0 ? field[i] & 0x7f : field[i])
    return value
  }
  const text = field
    .toString('latin1')
    .replace(/[\0 ]+$/g, '')
    .trim()
  if (text === '') return 0
  const n = parseInt(text, 8)
  if (!Number.isFinite(n))
    throw new Nb3FormatError('El archivo no es un backup .nb3 válido: cabecera tar corrupta')
  return n
}

const isZeroBlock = (block: Buffer): boolean => block.every((b) => b === 0)

const checksumValid = (block: Buffer): boolean => {
  const expected = parseNumeric(block.subarray(148, 156))
  let sum = 0
  for (let i = 0; i < TAR_BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : block[i]
  return sum === expected
}

interface RawHeader {
  name: string
  size: number
  type: string
}

function parseHeader(block: Buffer): RawHeader | null {
  if (isZeroBlock(block)) return null
  if (!checksumValid(block))
    throw new Nb3FormatError('El archivo no es un backup .nb3 válido: cabecera tar corrupta')
  const magic = block.toString('latin1', 257, 262)
  const name = cstr(block, 0, 100)
  const prefix = magic.startsWith('ustar') ? cstr(block, 345, 155) : ''
  const typeByte = block[156]
  return {
    name: prefix ? `${prefix}/${name}` : name,
    size: parseNumeric(block.subarray(124, 136)),
    type: typeByte === 0 ? '0' : String.fromCharCode(typeByte)
  }
}

const roundUp = (n: number): number => Math.ceil(n / TAR_BLOCK) * TAR_BLOCK

function parsePaxPath(body: Buffer): string | null {
  let pos = 0
  while (pos < body.length) {
    const space = body.indexOf(0x20, pos)
    if (space === -1) break
    const len = parseInt(body.toString('latin1', pos, space), 10)
    if (!Number.isFinite(len) || len <= 0) break
    const record = body.toString('utf8', space + 1, pos + len - 1)
    const eq = record.indexOf('=')
    if (eq !== -1 && record.slice(0, eq) === 'path') return record.slice(eq + 1)
    pos += len
  }
  return null
}

async function readExact(fh: FileHandle, position: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length)
  let done = 0
  while (done < length) {
    const { bytesRead } = await fh.read(buf, done, length - done, position + done)
    if (bytesRead === 0) break
    done += bytesRead
  }
  return done === length ? buf : buf.subarray(0, done)
}

/** Lists the regular-file entries of a tar archive with their body offsets. */
export async function indexTar(path: string): Promise<TarEntry[]> {
  const fh = await open(path, 'r')
  try {
    const { size: fileSize } = await fh.stat()
    const entries: TarEntry[] = []
    let pos = 0
    let overrideName: string | null = null
    let sawZero = false
    while (pos + TAR_BLOCK <= fileSize) {
      const block = await readExact(fh, pos, TAR_BLOCK)
      if (block.length < TAR_BLOCK) break
      const header = parseHeader(block)
      pos += TAR_BLOCK
      if (!header) {
        if (sawZero) break
        sawZero = true
        continue
      }
      sawZero = false
      const bodyOffset = pos
      pos += roundUp(header.size)
      if (header.type === 'L') {
        overrideName = cstr(await readExact(fh, bodyOffset, header.size), 0, header.size)
        continue
      }
      if (header.type === 'x') {
        overrideName = parsePaxPath(await readExact(fh, bodyOffset, header.size))
        continue
      }
      if (header.type === 'g') continue
      if (header.type !== '0' && header.type !== '7') continue
      entries.push({ name: overrideName ?? header.name, offset: bodyOffset, size: header.size })
      overrideName = null
    }
    return entries
  } finally {
    await fh.close()
  }
}

/** Reads one entry body completely into memory (use only for small entries). */
export async function readTarEntry(path: string, entry: TarEntry): Promise<Buffer> {
  const fh = await open(path, 'r')
  try {
    const buf = await readExact(fh, entry.offset, entry.size)
    if (buf.length !== entry.size)
      throw new Nb3FormatError(`El archivo está truncado: falta contenido de ${entry.name}`)
    return buf
  } finally {
    await fh.close()
  }
}

/* ---------- Writing ---------- */

/** bsdtar/GNU tar pad archives to 20-block records; the reference .nb3 files do too. */
export const TAR_RECORD = 20 * TAR_BLOCK
const MAX_OCTAL_SIZE = 0o77777777777

const writeOctal = (block: Buffer, offset: number, width: number, value: number): void => {
  // width - 1 octal digits followed by NUL, as written by bsdtar.
  block.write(value.toString(8).padStart(width - 1, '0'), offset, width - 1, 'latin1')
  block[offset + width - 1] = 0
}

/**
 * Encodes a POSIX ustar header for a regular file with the fixed attributes
 * used by Navicat: mode 0644, uid/gid 0, empty owner names, mtime 0.
 */
export function encodeTarHeader(name: string, size: number): Buffer {
  const nameBytes = Buffer.from(name, 'utf8')
  if (nameBytes.length > 100) throw new Error(`Nombre de entrada tar demasiado largo: ${name}`)
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_OCTAL_SIZE) {
    throw new Error(`Tamaño de entrada tar no soportado: ${name}`)
  }
  const block = Buffer.alloc(TAR_BLOCK, 0)
  nameBytes.copy(block, 0)
  writeOctal(block, 100, 8, 0o644)
  writeOctal(block, 108, 8, 0)
  writeOctal(block, 116, 8, 0)
  writeOctal(block, 124, 12, size)
  writeOctal(block, 136, 12, 0)
  block.fill(0x20, 148, 156)
  block[156] = 0x30 // '0' regular file
  block.write('ustar\u000000', 257, 8, 'latin1')
  let sum = 0
  for (let i = 0; i < TAR_BLOCK; i++) sum += block[i]
  block.write(sum.toString(8).padStart(6, '0'), 148, 6, 'latin1')
  block[154] = 0
  block[155] = 0x20
  return block
}

/** Zero padding that brings an entry body of `size` bytes to a block boundary. */
export const tarBodyPadding = (size: number): Buffer => Buffer.alloc(roundUp(size) - size, 0)

/** End-of-archive marker (two zero blocks) plus padding to a full record. */
export function tarTrailer(bytesWritten: number): Buffer {
  const withMarker = bytesWritten + 2 * TAR_BLOCK
  const total = Math.ceil(withMarker / TAR_RECORD) * TAR_RECORD
  return Buffer.alloc(total - bytesWritten, 0)
}
