import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { collectPackages, generateNotices, licenseId } from './third-party-licenses.mjs'

const ROOT = resolve(__dirname, '..')

describe('third-party notices', () => {
  const packages = collectPackages(ROOT)
  const byName = new Map(packages.map((p) => [p.name, p]))

  it('lists the production dependencies with their licence texts', () => {
    for (const name of ['vue', 'vuetify', 'mysql2', 'electron-updater', 'ssh2'])
      expect(byName.get(name)?.texts.length, name).toBeGreaterThan(0)
    expect(byName.get('vue')?.license).toBe('MIT')
  })

  it('includes the fonts (OFL) and the icon font with their own licences', () => {
    expect(byName.get('@fontsource-variable/inter')?.license).toBe('OFL-1.1')
    expect(byName.get('@fontsource-variable/jetbrains-mono')?.license).toBe('OFL-1.1')
    expect(byName.get('@mdi/font')?.texts[0]?.text).toContain('Pictogrammers')
  })

  it('leaves out development-only tools', () => {
    for (const name of ['vitest', 'eslint', 'electron-builder', 'typescript', 'prettier'])
      expect(byName.has(name), name).toBe(false)
  })

  it('renders a header, Electron/Chromium and one section per package', () => {
    const text = generateNotices(ROOT)
    expect(text).toMatch(/^Vortaq .* — Licencias de terceros/)
    expect(text).toContain('LICENSES.chromium.html')
    expect(text).toMatch(/^electron \d+\.\d+\.\d+$/m)
    expect(text).toMatch(/^vue \d+\.\d+\.\d+$/m)
    expect(text).not.toContain('UNKNOWN')
  })

  it('reads every licence field shape', () => {
    expect(licenseId({ license: 'MIT' })).toBe('MIT')
    expect(licenseId({ license: { type: 'BSD-3-Clause' } })).toBe('BSD-3-Clause')
    expect(licenseId({ licenses: [{ type: 'MIT' }, 'Apache-2.0'] })).toBe('MIT OR Apache-2.0')
    expect(licenseId({})).toBe('UNKNOWN')
  })
})
