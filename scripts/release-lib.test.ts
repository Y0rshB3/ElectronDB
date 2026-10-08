import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { pickAssets } from '../src/main/updates/release'
import {
  builderArgs,
  expectedArtifacts,
  parseUpdateYml,
  sha256SumsText,
  sha512Base64
} from './release-lib.mjs'

const ROOT = resolve(__dirname, '..')

describe('release artifacts', () => {
  it('builds every platform with --publish never into the given folder', () => {
    for (const p of ['mac', 'win', 'linux'] as const) {
      const args = builderArgs(p, '/tmp/out')
      expect(args.join(' ')).toContain('--publish never')
      expect(args).toContain('-c.directories.output=/tmp/out')
    }
    expect(builderArgs('win', 'x').slice(0, 2)).toEqual(['--win', '--x64'])
    expect(builderArgs('mac', 'x').slice(0, 3)).toEqual(['--mac', '--arm64', '--x64'])
  })

  it('names are the public ones the in-app update looks for (pickAssets)', () => {
    const a = expectedArtifacts('0.1.9')
    const asAssets = (names: string[]) =>
      names.map((name) => ({
        name,
        url: `https://github.com/Y0rshB3/ElectronDB/releases/download/v0.1.9/${name}`,
        size: 1
      }))
    expect(pickAssets(asAssets(a.win.binaries), 'win32', 'x64').download?.fileName).toBe(
      'Vortaq-0.1.9-x64-setup.exe'
    )
    expect(pickAssets(asAssets(a.mac.binaries), 'darwin', 'arm64').download?.fileName).toBe(
      'Vortaq-0.1.9-arm64.dmg'
    )
    expect(pickAssets(asAssets(a.mac.binaries), 'darwin', 'x64').download?.fileName).toBe(
      'Vortaq-0.1.9-x64.dmg'
    )
    expect(pickAssets(asAssets(a.linux.binaries), 'linux', 'x64').download?.fileName).toBe(
      'Vortaq-0.1.9-x86_64.AppImage'
    )
    expect(a.linux.binaries).toContain('vortaq_0.1.9_amd64.deb')
    expect(a.win.binaries).toContain('Vortaq-0.1.9-x64-portable.exe')
  })

  it('electron-builder.yml keeps the identity, the feed and the artifact patterns', () => {
    const yml = readFileSync(resolve(ROOT, 'electron-builder.yml'), 'utf8')
    expect(yml).toMatch(/^appId: dev\.y0rshb3\.electrondb$/m)
    expect(yml).toMatch(/^productName: Vortaq$/m)
    expect(yml).toMatch(
      /^publish:\n {2}provider: github\n {2}owner: Y0rshB3\n {2}repo: Vortaq$/m
    )
    expect(yml).toMatch(/^nsis:\n(?: {2}.*\n)*? {2}oneClick: true$/m)
    expect(yml).toMatch(/^ {2}perMachine: false$/m)
    expect(yml).toMatch(/^ {2}deleteAppDataOnUninstall: false$/m)
    expect(yml).toMatch(
      /^ {2}artifactName: \$\{productName\}-\$\{version\}-\$\{arch\}-setup\.\$\{ext\}$/m
    )
    expect(yml).toMatch(
      /^ {2}artifactName: \$\{productName\}-\$\{version\}-\$\{arch\}-portable\.\$\{ext\}$/m
    )
    expect(yml).toMatch(/^ {2}nsis: '1\.2\.1'$/m)
    expect(yml).toMatch(/^ {2}appimage: '1\.0\.3'$/m)
    const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'))
    expect(pkg.name).toBe('vortaq')
    expect(pkg.productName).toBe('Vortaq')
    expect(pkg.homepage).toBe('https://github.com/Y0rshB3/Vortaq')
    for (const script of ['dist', 'dist:mac', 'dist:win', 'dist:linux'])
      expect(pkg.scripts[script]).toContain('--publish never')
  })

  it('reads latest.yml as electron-builder writes it', () => {
    const yml = parseUpdateYml(
      [
        'version: 0.1.9',
        'files:',
        '  - url: Vortaq-0.1.9-x64-setup.exe',
        '    sha512: 6VciFtd/d9+IVFruWQ==',
        '    size: 130115627',
        'path: Vortaq-0.1.9-x64-setup.exe',
        'sha512: 6VciFtd/d9+IVFruWQ==',
        "releaseDate: '2026-10-07T17:23:55.396Z'"
      ].join('\n')
    )
    expect(yml).toEqual({
      version: '0.1.9',
      path: 'Vortaq-0.1.9-x64-setup.exe',
      sha512: '6VciFtd/d9+IVFruWQ==',
      files: [
        { url: 'Vortaq-0.1.9-x64-setup.exe', sha512: '6VciFtd/d9+IVFruWQ==', size: 130115627 }
      ]
    })
  })

  it('writes SHA256SUMS.txt in sha256sum format', () => {
    expect(
      sha256SumsText([
        { name: 'b.exe', sha256: 'b'.repeat(64) },
        { name: 'a.dmg', sha256: 'a'.repeat(64) }
      ])
    ).toBe(`${'a'.repeat(64)}  a.dmg\n${'b'.repeat(64)}  b.exe\n`)
    expect(sha512Base64(Buffer.from('x'))).toMatch(/^[A-Za-z0-9+/]+=*$/)
  })
})
