import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { encryptNcxAes, encryptNcxBlowfish } from '../navicat/ncxCipher'
import {
  DBEAVER_INVALID_MESSAGE,
  DBEAVER_USER_WARNING,
  parseDbeaverDataSources,
  parseJdbcUrl
} from './dbeaver'
import {
  HTTP_TUNNEL_WARNING,
  NCX_INVALID_MESSAGE,
  NCX_NO_PASSWORDS_NOTE,
  NCX_PASSWORDS_NOTE,
  decodeNcxSecret,
  parseNcx
} from './ncx'
import { IMPORT_FIXTURES } from './testing'
import { FOREIGN_PATH_WARNING, MARIADB_AS_MYSQL_WARNING } from './types'
import { isForeignPath, normalizeColor } from './util'
import {
  WORKBENCH_INVALID_MESSAGE,
  WORKBENCH_PASSWORDS_NOTE,
  WORKBENCH_SOCKET_WARNING,
  parseWorkbenchConnections
} from './workbench'

const fixture = (...parts: string[]): string =>
  readFileSync(join(IMPORT_FIXTURES, ...parts), 'utf8')

describe('parseNcx', () => {
  it('reads a Ver 1.4 file without passwords (union schema)', () => {
    const file = parseNcx(fixture('ncx', 'connections-v1.4-nopass.ncx'), 'darwin')
    expect(file.notes).toEqual([NCX_NO_PASSWORDS_NOTE])
    expect(file.connections.map((c) => c.name)).toEqual([
      'Local Dev',
      'Staging Bastion',
      'Reports PG'
    ])
    const [dev, bastion, pg] = file.connections
    expect(dev).toMatchObject({
      key: 'MySQL:Local Dev',
      engine: 'mysql',
      engineLabel: 'MySQL',
      navicatType: 'MySQL',
      host: '127.0.0.1',
      port: 3306,
      username: 'app_user',
      database: null,
      environment: 'local',
      secrets: {},
      warnings: []
    })
    expect(dev.ssh.enabled).toBe(false)
    expect(bastion.ssh).toEqual({
      enabled: true,
      host: 'bastion.example.test',
      port: 2222,
      username: 'ops',
      authType: 'key',
      savePassword: false,
      privateKeyPath: '/Users/tester/.ssh/id_ed25519'
    })
    expect(bastion.ssl).toEqual({
      enabled: true,
      verifyServer: true,
      caCertPath: '/Users/tester/certs/ca.pem',
      clientCertPath: '/Users/tester/certs/client-cert.pem',
      clientKeyPath: '/Users/tester/certs/client-key.pem'
    })
    expect(bastion.port).toBe(3307)
    expect(bastion.environment).toBe('staging')
    expect(pg).toMatchObject({
      engine: null,
      engineLabel: 'PostgreSQL',
      unsupportedReason: 'Motor no soportado en esta versión: PostgreSQL',
      database: 'reports'
    })
  })

  it('reads a Ver 1.5 file where defaults are omitted', () => {
    const file = parseNcx(fixture('ncx', 'connections-v1.5-mixed.ncx'), 'darwin')
    const byName = new Map(file.connections.map((c) => [c.name, c]))
    expect(byName.get('Production Shop')).toMatchObject({
      engine: 'mysql',
      port: 3306,
      environment: 'production',
      ssl: { enabled: false, verifyServer: false }
    })
    const maria = byName.get('Maria Analytics')!
    expect(maria).toMatchObject({ engine: 'mysql', engineLabel: 'MariaDB', navicatType: 'MariaDB' })
    expect(maria.warnings).toContain(MARIADB_AS_MYSQL_WARNING)
    expect(maria.ssh).toMatchObject({
      enabled: true,
      host: 'jump.example.test',
      port: 22,
      authType: 'password'
    })
    const win = byName.get('Windows Laptop')!
    expect(win.warnings).toEqual([FOREIGN_PATH_WARNING, HTTP_TUNNEL_WARNING])
    expect(win.ssl.caCertPath).toBe('C:\\Users\\tester\\certs\\ca.pem')
    expect(byName.get('Cache')).toMatchObject({ engine: null, engineLabel: 'Redis', port: 6379 })
    expect(byName.get('Legacy MSSQL')).toMatchObject({
      engine: null,
      unsupportedReason: 'Motor no soportado en esta versión: SQL Server',
      port: 1433
    })
  })

  it('decodes AES passwords (Ver 1.5) into the right slots and says the file holds secrets', () => {
    const xml = `\uFEFF<?xml version="1.0" encoding="UTF-8"?>
<Connections Ver="1.5">
  <Connection ConnectionName="Prod" ConnType="MYSQL" Host="db.example.test" UserName="u" Password="${encryptNcxAes('s3cret-ñ')}"
    SSH="true" SSH_Host="bastion.example.test" SSH_UserName="ops" SSH_AuthenMethod="PUBLICKEY" SSH_PrivateKey="/k"
    SSH_Password="${encryptNcxAes('not-used')}" SSH_Passphrase="${encryptNcxAes('phrase')}"
    SSL="true" SSL_ClientKey="/key.pem" SSL_PEMClientKeyPassword="${encryptNcxAes('pem-pass')}" />
  <Connection ConnectionName="Pwd ssh" ConnType="MYSQL" Host="h" SSH="true" SSH_AuthenMethod="PASSWORD"
    SSH_Password="${encryptNcxAes('ssh-pass')}" SSH_Passphrase="${encryptNcxAes('ignored')}" />
</Connections>`
    const file = parseNcx(xml, 'darwin')
    expect(file.notes).toEqual([NCX_PASSWORDS_NOTE])
    expect(file.connections[0].secrets).toEqual({
      mysql: 's3cret-ñ',
      ssh: 'phrase',
      sslKey: 'pem-pass'
    })
    expect(file.connections[0].ssh.savePassword).toBe(true)
    expect(file.connections[1].secrets).toEqual({ ssh: 'ssh-pass' })
  })

  it('chooses the Blowfish scheme for files older than Ver 1.4, with AES as fallback', () => {
    const bf = encryptNcxBlowfish('old-pass')
    const aes = encryptNcxAes('new-pass')
    expect(decodeNcxSecret(bf, '1.1')).toBe('old-pass')
    expect(decodeNcxSecret(aes, '1.1')).toBe('new-pass')
    expect(decodeNcxSecret(aes, '1.4')).toBe('new-pass')
    expect(decodeNcxSecret(bf, '1.5')).toBe('old-pass')
    expect(decodeNcxSecret('', '1.5')).toBeNull()
    expect(decodeNcxSecret('ZZ', '1.5')).toBeNull()
    const xml = `<Connections Ver="1.1"><Connection ConnectionName="Old" ConnType="MYSQL" Host="h" Password="${bf}"/></Connections>`
    expect(parseNcx(xml).connections[0].secrets).toEqual({ mysql: 'old-pass' })
  })

  it('reads only direct Connection children and skips nameless ones', () => {
    const xml = `<Connections Ver="1.5"><Group><Connection ConnectionName="Nested" ConnType="MYSQL"/></Group>
      <Connection ConnectionName="" ConnType="MYSQL"/><Connection ConnectionName="A" ConnType="MYSQL"/>
      <Connection ConnectionName="A" ConnType="MYSQL"/></Connections>`
    const file = parseNcx(xml)
    expect(file.connections.map((c) => c.key)).toEqual(['MySQL:A', 'MySQL:A#2'])
  })

  it('refuses anything that is not an .ncx', () => {
    expect(() => parseNcx('not xml <')).toThrow(NCX_INVALID_MESSAGE)
    expect(() => parseNcx('<plist version="1.0"><dict/></plist>')).toThrow(NCX_INVALID_MESSAGE)
    expect(() => parseNcx('')).toThrow(NCX_INVALID_MESSAGE)
  })
})

describe('parseDbeaverDataSources', () => {
  const file = parseDbeaverDataSources(fixture('dbeaver', 'data-sources.json'), 'linux')
  const byName = new Map(file.connections.map((c) => [c.name, c]))

  it('imports MySQL and MariaDB connections without passwords', () => {
    expect(file.notes).toEqual([
      'Las contraseñas no se importan: DBeaver las guarda cifradas. Escríbelas al editar cada conexión.'
    ])
    expect(file.connections.every((c) => Object.keys(c.secrets).length === 0)).toBe(true)
    expect(byName.get('Local MySQL')).toMatchObject({
      key: 'mysql8-18a2b3c4d5e-1f2e3d4c5b6a7980',
      engine: 'mysql',
      host: 'localhost',
      port: 3306,
      username: 'app_user',
      database: 'app_dev',
      environment: 'local',
      color: null,
      warnings: []
    })
    const prod = byName.get('Shop production')!
    expect(prod).toMatchObject({
      environment: 'production',
      color: '#f79f81',
      username: '',
      database: null
    })
    expect(prod.warnings).toEqual([DBEAVER_USER_WARNING])
    expect(prod.ssh).toEqual({
      enabled: true,
      host: 'bastion.example.test',
      port: 2222,
      username: '',
      authType: 'key',
      savePassword: false,
      privateKeyPath: '/home/tester/.ssh/id_rsa'
    })
    const maria = byName.get('Maria staging')!
    expect(maria).toMatchObject({
      engine: 'mysql',
      engineLabel: 'MariaDB',
      host: 'maria.example.test',
      port: 3307,
      database: 'stats',
      environment: 'staging'
    })
    expect(maria.warnings).toContain(MARIADB_AS_MYSQL_WARNING)
  })

  it('lists other engines as not importable', () => {
    expect(byName.get('Warehouse')).toMatchObject({
      engine: null,
      engineLabel: 'PostgreSQL',
      unsupportedReason: 'Motor no soportado en esta versión: PostgreSQL'
    })
    expect(byName.get('Local notes')).toMatchObject({ engine: null, engineLabel: 'SQLite' })
    expect(byName.get('Warehouse')!.warnings).toEqual([])
  })

  it('parses JDBC URLs and refuses other files', () => {
    expect(parseJdbcUrl('jdbc:mysql://h.example.test:3310/db%201?useSSL=false')).toEqual({
      host: 'h.example.test',
      port: 3310,
      database: 'db 1'
    })
    expect(parseJdbcUrl('jdbc:mysql://h/')).toEqual({ host: 'h', port: null, database: '' })
    expect(parseJdbcUrl('jdbc:postgresql://h/x')).toBeNull()
    expect(() => parseDbeaverDataSources('{')).toThrow(DBEAVER_INVALID_MESSAGE)
    expect(() => parseDbeaverDataSources('{"folders":{}}')).toThrow(DBEAVER_INVALID_MESSAGE)
  })

  it('flags key paths from another OS and agent auth', () => {
    const json = JSON.stringify({
      connections: {
        x: {
          provider: 'mysql',
          driver: 'mysql8',
          name: 'W',
          configuration: {
            host: 'h',
            user: 'u',
            handlers: {
              ssh_tunnel: {
                enabled: true,
                properties: { host: 'b', authType: 'PUBLIC_KEY', keyPath: 'C:\\keys\\id' }
              }
            }
          }
        }
      }
    })
    expect(parseDbeaverDataSources(json, 'darwin').connections[0].warnings).toEqual([
      FOREIGN_PATH_WARNING
    ])
  })
})

describe('parseWorkbenchConnections', () => {
  const file = parseWorkbenchConnections(fixture('workbench', 'connections.xml'), 'darwin')

  it('reads plain, SSH and socket connections and never a password', () => {
    expect(file.notes).toEqual([WORKBENCH_PASSWORDS_NOTE])
    expect(file.connections.map((c) => c.name)).toEqual([
      'Local instance 3306',
      'Production via bastion',
      'Socket local'
    ])
    const [local, prod, socket] = file.connections
    expect(local).toMatchObject({
      key: '2F6A1C3E-0B1D-4E5F-9A7B-1C2D3E4F5A6B',
      engine: 'mysql',
      host: '127.0.0.1',
      port: 3306,
      username: 'app_user',
      database: 'app_dev',
      environment: 'local',
      secrets: {},
      ssl: { enabled: false, verifyServer: false }
    })
    expect(JSON.stringify(file)).not.toContain('must-never-be-read')
    expect(prod.ssh).toEqual({
      enabled: true,
      host: 'bastion.example.test',
      port: 2200,
      username: 'ops',
      authType: 'key',
      savePassword: false,
      privateKeyPath: '/Users/tester/.ssh/id_ed25519'
    })
    expect(prod.ssl).toEqual({
      enabled: true,
      verifyServer: true,
      caCertPath: '/Users/tester/certs/ca.pem'
    })
    expect(prod.environment).toBe('production')
    expect(socket).toMatchObject({ host: 'localhost', port: 3306, username: 'root' })
    expect(socket.warnings).toEqual([WORKBENCH_SOCKET_WARNING])
  })

  it('refuses other files', () => {
    expect(() => parseWorkbenchConnections('<Connections/>')).toThrow(WORKBENCH_INVALID_MESSAGE)
    expect(() => parseWorkbenchConnections('<data')).toThrow(WORKBENCH_INVALID_MESSAGE)
  })
})

describe('helpers', () => {
  it('detects paths of another OS', () => {
    expect(isForeignPath('C:\\x', 'darwin')).toBe(true)
    expect(isForeignPath('\\\\server\\share', 'linux')).toBe(true)
    expect(isForeignPath('/Users/x', 'darwin')).toBe(false)
    expect(isForeignPath('/Users/x', 'win32')).toBe(true)
    expect(isForeignPath('C:\\x', 'win32')).toBe(false)
  })
  it('normalises colours', () => {
    expect(normalizeColor('#ABC')).toBe('#aabbcc')
    expect(normalizeColor('4bd67a')).toBe('#4bd67a')
    expect(normalizeColor('0,128,255')).toBe('#0080ff')
    expect(normalizeColor('red')).toBeNull()
    expect(normalizeColor('300,0,0')).toBeNull()
  })
})
