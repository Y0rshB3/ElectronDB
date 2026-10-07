import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ConnectionConfig } from '@shared/types'
import { inferEnvironment, parseConnPlist, readNavicatConnections, readTextFile } from './connPlist'
import { navicatPaths } from './paths'
import { buildPrefPlist, encodeMarkerColor, FIXTURE_ROOT } from './testing'

const fixturePaths = navicatPaths(FIXTURE_ROOT)

describe('parseConnPlist', () => {
  it('parses the four fixture connections', async () => {
    const connections = await parseConnPlist(await readTextFile(fixturePaths.connPlist))
    expect(connections.map((c) => c.name)).toEqual(['Dev', 'Home Lab', 'Production', 'Staging'])

    const byName = Object.fromEntries(connections.map((c) => [c.name, c]))
    expect(byName.Dev).toMatchObject({
      host: '127.0.0.1',
      port: 13306,
      username: 'root',
      savePassword: true,
      environment: 'local'
    })
    expect(byName.Staging).toMatchObject({
      host: '203.0.113.10',
      port: 3306,
      username: 'staging_user',
      environment: 'staging'
    })
    expect(byName.Production).toMatchObject({
      host: 'localhost',
      port: 3306,
      username: 'app_user',
      environment: 'production'
    })
    expect(byName['Home Lab']).toMatchObject({
      host: '127.0.0.1',
      port: 3306,
      username: 'lab',
      environment: 'other'
    })

    expect(byName['Home Lab'].ssh).toEqual({
      enabled: true,
      host: 'lab.example.lan',
      port: 2200,
      username: 'lab',
      authType: 'key',
      privateKeyPath: '/Users/tester/.ssh/id_ed25519',
      savePassword: true
    })
    expect(byName.Dev.ssh).toMatchObject({ enabled: false, port: 22, authType: 'password' })
    expect(byName.Dev.ssh.privateKeyPath).toBeUndefined()
    expect(byName.Dev.ssl).toEqual({ enabled: false, verifyServer: false })
    expect(byName.Dev.customDatabases).toEqual([])
    expect(byName.Dev.initialQueries).toBe('')
    expect(byName.Dev.savePath).toContain('/Common/Settings/0/0/MySQL/Dev')
    expect(connections.every((c) => c.color === null)).toBe(true)
  })

  it('defaults the port to 3306 and honours custom database lists and ssl paths', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>0</key><dict><key>0</key><dict><key>MySQL</key><dict>
<key>Weird</key><dict>
  <key>host</key><string>db.example.com</string>
  <key>port</key><string>abc</string>
  <key>username</key><string>u</string>
  <key>usecustomdblist</key><true/>
  <key>customdblist</key><array><string>a</string><string>b</string></array>
  <key>initialsessionqueries</key><string>SET NAMES utf8mb4</string>
  <key>usessl</key><true/>
  <key>ssl_param</key><dict><key>cacert</key><string>/ca.pem</string><key>clientcert</key><string>/c.pem</string><key>clientkeyfile</key><string>/k.pem</string><key>verifyca</key><true/></dict>
</dict></dict></dict></dict></dict></plist>`
    const [conn] = await parseConnPlist(xml)
    expect(conn).toMatchObject({
      name: 'Weird',
      port: 3306,
      customDatabases: ['a', 'b'],
      initialQueries: 'SET NAMES utf8mb4',
      environment: 'other'
    })
    expect(conn.ssl).toEqual({
      enabled: true,
      verifyServer: true,
      caCertPath: '/ca.pem',
      clientCertPath: '/c.pem',
      clientKeyPath: '/k.pem'
    })
  })

  it('throws an actionable error on invalid XML', async () => {
    await expect(parseConnPlist('<plist><dict>')).rejects.toThrow(/conn\.plist/)
  })
})

describe('inferEnvironment', () => {
  it('applies the name/host heuristics in order', () => {
    expect(inferEnvironment('Production', 'localhost')).toBe('production')
    expect(inferEnvironment('QA box', '10.0.0.1')).toBe('staging')
    expect(inferEnvironment('stg', '10.0.0.1')).toBe('staging')
    expect(inferEnvironment('Docker', '127.0.0.1')).toBe('local')
    expect(inferEnvironment('My Local', '10.0.0.1')).toBe('local')
    expect(inferEnvironment('Home Lab', '127.0.0.1', true)).toBe('other')
    expect(inferEnvironment('Home Lab', '127.0.0.1', false)).toBe('local')
    expect(inferEnvironment('Home Lab', 'lab.example.lan')).toBe('other')
  })
})

describe('readNavicatConnections', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'vortaq-navicat-'))
    const paths = navicatPaths(root)
    mkdirSync(join(root, 'Common'), { recursive: true })
    copyFileSync(fixturePaths.connPlist, paths.connPlist)
    writeFileSync(
      paths.prefPlist,
      buildPrefPlist({
        Dev: encodeMarkerColor(105 / 255, 240 / 255, 174 / 255),
        Production: encodeMarkerColor(1, 82 / 255, 82 / 255),
        Staging: encodeMarkerColor(1, 193 / 255, 7 / 255),
        'Home Lab': null
      })
    )
    // Navicat backups live under the default savepath when the plist savepath is from another machine.
    mkdirSync(join(paths.settingsDir, 'Staging', 'billing'), { recursive: true })
    writeFileSync(join(paths.settingsDir, 'Staging', 'billing', '20260317144801.nb3'), '')
    writeFileSync(join(paths.settingsDir, 'Staging', 'billing', '20260318144801-label.nb3'), '')
    writeFileSync(join(paths.settingsDir, 'Staging', 'id_cache.db'), '')
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('adds colours, backup counts and alreadyImported flags', async () => {
    const imported = {
      source: { app: 'navicat', name: 'Dev', importedAt: 'x' }
    } as ConnectionConfig
    const entries = await readNavicatConnections(root, [imported])
    const previews = Object.fromEntries(entries.map((e) => [e.preview.name, e.preview]))
    expect(previews.Dev.color).toBe('#69f0ae')
    expect(previews.Production.color).toBe('#ff5252')
    expect(previews.Staging.color).toBe('#ffc107')
    expect(previews['Home Lab'].color).toBeNull()
    expect(previews.Dev.alreadyImported).toBe(true)
    expect(previews.Staging.alreadyImported).toBe(false)
    expect(previews.Staging.backupCount).toBe(2)
    expect(previews.Dev.backupCount).toBe(0)
    expect(entries.find((e) => e.preview.name === 'Staging')?.backupSourceDir).toBe(
      join(navicatPaths(root).settingsDir, 'Staging')
    )
    expect(entries.find((e) => e.preview.name === 'Dev')?.backupSourceDir).toBeNull()
  })

  it('keeps colours null when pref.plist is missing', async () => {
    rmSync(navicatPaths(root).prefPlist)
    const entries = await readNavicatConnections(root, [])
    expect(entries).toHaveLength(4)
    expect(entries.every((e) => e.preview.color === null)).toBe(true)
  })

  it('reads the real fixture root (no colours in that pref.plist)', async () => {
    const entries = await readNavicatConnections(FIXTURE_ROOT, [])
    expect(entries.map((e) => e.preview.name)).toEqual(['Dev', 'Home Lab', 'Production', 'Staging'])
    expect(entries.every((e) => e.preview.backupCount === 0 && !e.preview.alreadyImported)).toBe(
      true
    )
  })
})
