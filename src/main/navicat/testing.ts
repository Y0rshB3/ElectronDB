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

/**
 * Synthetic multi-type conn.plist (docs/multi-engine-design.md, 12.1): the `MySQL`
 * keys are the verified ones; `MariaDB` uses the same keys and `PostgreSQL` the
 * design's mapping. Fictitious names and documentation addresses only.
 */
export const MULTI_TYPE_CONN_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>0</key><dict><key>0</key><dict>
<key>MySQL</key><dict>
  <key>Shared name</key><dict><key>host</key><string>127.0.0.1</string><key>port</key><integer>3306</integer><key>username</key><string>root</string></dict>
</dict>
<key>MariaDB</key><dict>
  <key>Shared name</key><dict><key>host</key><string>maria.example.test</string><key>port</key><integer>3307</integer><key>username</key><string>app</string><key>usetunnel</key><true/><key>ssh_param</key><dict><key>host</key><string>jump.example.test</string><key>username</key><string>tunnel</string></dict></dict>
  <key>Maria prod</key><dict><key>host</key><string>203.0.113.20</string><key>username</key><string>ro</string></dict>
</dict>
<key>PostgreSQL</key><dict>
  <key>PG local</key><dict>
    <key>host</key><string>localhost</string><key>port</key><integer>55432</integer><key>username</key><string>postgres</string>
    <key>initialdatabase</key><string>shop</string>
    <key>usessl</key><true/>
    <key>ssl_param</key><dict><key>mode</key><string>VERIFY_FULL</string><key>rootcert</key><string>/certs/root.crt</string></dict>
    <key>usecustomdblist</key><integer>1</integer>
    <key>customdblist</key><array><string>shop</string></array>
  </dict>
  <key>PG cluster</key><dict><key>hostportlist</key><string>pg1.example.test:5433,pg2.example.test:5434</string><key>username</key><string>u</string><key>ssl_param</key><dict><key>mode</key><string>bogus</string></dict></dict>
  <key>Warehouse</key><dict><key>host</key><string>wh.example.test</string><key>serviceprovider</key><string>Redshift</string></dict>
</dict>
<key>SQL Server</key><dict><key>Ignored</key><dict><key>host</key><string>x</string></dict></dict>
</dict></dict></dict></plist>`
