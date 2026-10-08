import type { NavicatSection } from '@shared/types'
import { isPlistDict as isDict, parsePlistXml } from './plist'

/**
 * Decodes the NSArchiver "streamtyped" NSColor blob Navicat stores under
 * `markercolor` in pref.plist. After the ASCII type signature `ffff` come four
 * components (r, g, b, a), each encoded as `0x83` + float32 LE, or as a small
 * integer (single byte 0/1, `0x81` + int16 LE, `0x82` + int32 LE).
 * Returns `#rrggbb` (lowercase) or null when the blob is missing or garbled.
 */
export function decodeMarkerColor(blob: unknown): string | null {
  const buf = toBuffer(blob)
  if (!buf) return null
  const marker = buf.indexOf('ffff', 0, 'latin1')
  if (marker < 0) return null

  const components: number[] = []
  let offset = marker + 4
  while (components.length < 3) {
    const next = readComponent(buf, offset)
    if (!next) return null
    components.push(next.value)
    offset = next.next
  }
  if (components.some((c) => !Number.isFinite(c))) return null
  return '#' + components.map(toHexByte).join('')
}

function toBuffer(blob: unknown): Buffer | null {
  if (Buffer.isBuffer(blob)) return blob
  if (blob instanceof Uint8Array) return Buffer.from(blob)
  return null
}

function readComponent(buf: Buffer, offset: number): { value: number; next: number } | null {
  if (offset >= buf.length) return null
  const tag = buf[offset]
  switch (tag) {
    case 0x83:
      if (offset + 5 > buf.length) return null
      return { value: buf.readFloatLE(offset + 1), next: offset + 5 }
    case 0x82:
      if (offset + 5 > buf.length) return null
      return { value: buf.readInt32LE(offset + 1), next: offset + 5 }
    case 0x81:
      if (offset + 3 > buf.length) return null
      return { value: buf.readInt16LE(offset + 1), next: offset + 3 }
    default:
      // Small non-negative integers are stored as a single byte.
      if (tag <= 0x7f) return { value: tag, next: offset + 1 }
      return null
  }
}

function toHexByte(component: number): string {
  const clamped = Math.min(1, Math.max(0, component))
  return Math.round(clamped * 255)
    .toString(16)
    .padStart(2, '0')
}

const MAX_PREF_DEPTH = 4

/**
 * Finds `serverpref/markercolor` below a connection's pref dict. Navicat CC
 * nests it under two empty-string keys (catalog/schema level):
 * `<name>/""/""/serverpref`; older layouts put `serverpref` directly under
 * `<name>`. Both are accepted, the shallowest match wins.
 */
function findMarkerColor(node: unknown, depth: number): unknown {
  if (!isDict(node) || depth > MAX_PREF_DEPTH) return undefined
  if (isDict(node.serverpref) && node.serverpref.markercolor !== undefined)
    return node.serverpref.markercolor
  for (const [key, child] of Object.entries(node)) {
    if (key === 'serverpref') continue
    const found = findMarkerColor(child, depth + 1)
    if (found !== undefined) return found
  }
  return undefined
}

/**
 * Reads connection colours from pref.plist XML. Path:
 * `connpref/0/0/MySQL/<name>/""/""/serverpref/markercolor` (verified on Navicat CC),
 * or `connpref/0/0/MySQL/<name>/serverpref/markercolor`. Connections without a
 * marker colour are absent from the map. Garbled input yields an empty map.
 */
export async function readMarkerColors(prefPlistXml: string): Promise<Map<string, string>> {
  return (await readMarkerColorsByType(prefPlistXml)).get('MySQL') ?? new Map()
}

/** Colours of every type section (`connpref/0/0/<TypeKey>/<name>/…`), keyed by section then name. */
export async function readMarkerColorsByType(
  prefPlistXml: string
): Promise<Map<NavicatSection, Map<string, string>>> {
  const out = new Map<NavicatSection, Map<string, string>>()
  let root: unknown
  try {
    root = await parsePlistXml(prefPlistXml)
  } catch {
    return out
  }
  if (!isDict(root) || !isDict(root.connpref)) return out
  for (const level1 of Object.values(root.connpref)) {
    if (!isDict(level1)) continue
    for (const level2 of Object.values(level1)) {
      if (!isDict(level2)) continue
      for (const type of COLOR_SECTIONS) {
        const section = level2[type]
        if (!isDict(section)) continue
        const colors = out.get(type) ?? new Map<string, string>()
        for (const [name, pref] of Object.entries(section)) {
          const color = decodeMarkerColor(findMarkerColor(pref, 0))
          if (color) colors.set(name, color)
        }
        out.set(type, colors)
      }
    }
  }
  return out
}

const COLOR_SECTIONS: readonly NavicatSection[] = ['MySQL', 'MariaDB', 'PostgreSQL', 'SQLite', 'MongoDB']
