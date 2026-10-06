/**
 * Helpers shared by the navicat/*.test.ts files. Not imported by app code.
 */
import { fileURLToPath } from 'node:url'

/** Anonymised Navicat root under tests/fixtures. */
export const FIXTURE_ROOT = fileURLToPath(
  new URL('../../../tests/fixtures/navicat', import.meta.url)
)

/** Builds an NSArchiver "streamtyped" NSColor blob like the one Navicat writes to pref.plist. */
export function encodeMarkerColor(r: number, g: number, b: number, a = 1): Buffer {
  const header = Buffer.from(
    '\x04\x0bstreamtyped\x81\xe8\x03\x84\x01@\x84\x84\x84\x07NSColor\x00\x84\x84\x08NSObject\x00\x85\x84\x01c\x01\x84\x04ffff',
    'latin1'
  )
  const parts = [header]
  for (const value of [r, g, b, a]) {
    if (value === 0 || value === 1) parts.push(Buffer.from([value]))
    else {
      const f = Buffer.alloc(5)
      f[0] = 0x83
      f.writeFloatLE(value, 1)
      parts.push(f)
    }
  }
  return Buffer.concat(parts)
}

/** Minimal pref.plist XML with a markercolor per connection (null = no colour). */
export function buildPrefPlist(colors: Record<string, Buffer | null>): string {
  const entries = Object.entries(colors)
    .map(([name, blob]) => {
      const marker = blob ? `<key>markercolor</key><data>${blob.toString('base64')}</data>` : ''
      return `<key>${name}</key><dict><key>serverpref</key><dict>${marker}</dict></dict>`
    })
    .join('')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>connpref</key><dict><key>0</key><dict><key>0</key><dict><key>MySQL</key><dict>${entries}</dict></dict></dict></dict></dict></plist>`
}
