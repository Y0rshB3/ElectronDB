import type { Element } from '@xmldom/xmldom'
import type { SshConfig, SslConfig } from '@shared/types'
import { inferEnvironment } from '../../navicat/connPlist'
import { NO_SSH, type ParsedConnection, type ParsedConnectionFile } from './types'
import { checkForeignPaths, mysqlFamily, positiveInt, uniqueKey } from './util'
import { childElements, parseXml } from './xml'

/**
 * MySQL Workbench connections (`connections.xml`, GRT XML). Only this file
 * is read. Workbench keeps passwords in the operating system's keychain;
 * they are never read, and any password-like value in the file is ignored.
 */

export const WORKBENCH_INVALID_MESSAGE =
  'El archivo no es un connections.xml de MySQL Workbench válido. Elige el archivo connections.xml de la carpeta de datos de Workbench.'
export const WORKBENCH_PASSWORDS_NOTE =
  'Las contraseñas no se importan: MySQL Workbench las guarda en el llavero del sistema. Escríbelas al editar cada conexión.'
export const WORKBENCH_SOCKET_WARNING =
  'Conexión por socket o tubería: se importa como TCP a localhost; revísala'

const CONNECTION_STRUCT = 'db.mgmt.Connection'

const text = (el: Element | undefined): string => (el?.textContent ?? '').trim()

/** Children of a GRT object/dict keyed by their `key` attribute. */
function keyed(el: Element): Map<string, Element> {
  const map = new Map<string, Element>()
  for (const child of childElements(el)) {
    const key = child.getAttribute('key')
    if (key) map.set(key, child)
  }
  return map
}

/** `host[:port]` of `sshHost`. */
function splitHostPort(value: string, fallbackPort: number): { host: string; port: number } {
  const m = /^\[?([^\]]*?)\]?(?::(\d+))?$/.exec(value.trim())
  if (!m) return { host: value.trim(), port: fallbackPort }
  return { host: m[1], port: positiveInt(m[2], fallbackPort) }
}

export function parseWorkbenchConnections(
  xml: string,
  platform: NodeJS.Platform = process.platform
): ParsedConnectionFile {
  const doc = parseXml(xml, WORKBENCH_INVALID_MESSAGE)
  const root = doc.documentElement!
  if (root.nodeName !== 'data') throw new Error(WORKBENCH_INVALID_MESSAGE)
  const used = new Set<string>()
  const connections: ParsedConnection[] = []
  const all = root.getElementsByTagName('value')
  for (let i = 0; i < all.length; i++) {
    const obj = all.item(i)
    if (!obj || obj.getAttribute('struct-name') !== CONNECTION_STRUCT) continue
    if (obj.getAttribute('type') !== 'object') continue
    const fields = keyed(obj)
    const params = fields.get('parameterValues')
    const p = params ? keyed(params) : new Map<string, Element>()
    // Password-like values are never read (Workbench keeps them in the keychain).
    const get = (key: string): string => (/password/i.test(key) ? '' : text(p.get(key)))

    const name = text(fields.get('name'))
    if (!name) continue
    const driver = text(fields.get('driver')).toLowerCase()
    const warnings: string[] = []
    const socket = /native_socket|pipe/.test(driver)
    if (socket) warnings.push(WORKBENCH_SOCKET_WARNING)
    const host = socket ? 'localhost' : get('hostName') || '127.0.0.1'

    let ssh: SshConfig = { ...NO_SSH }
    if (driver.endsWith('native_sshtun')) {
      const target = splitHostPort(get('sshHost'), 22)
      const keyFile = get('sshKeyFile')
      ssh = {
        enabled: true,
        host: target.host,
        port: target.port,
        username: get('sshUserName'),
        authType: keyFile ? 'key' : 'password',
        savePassword: false
      }
      if (keyFile) ssh.privateKeyPath = keyFile
    }

    // useSSL: 0 no, 1 if available, 2 require, 3 verify CA, 4 verify identity.
    const useSsl = Number(get('useSSL') || '0')
    const ssl: SslConfig = { enabled: useSsl >= 2, verifyServer: useSsl >= 3 }
    if (ssl.enabled) {
      const ca = get('sslCA')
      const cert = get('sslCert')
      const key = get('sslKey')
      if (ca) ssl.caCertPath = ca
      if (cert) ssl.clientCertPath = cert
      if (key) ssl.clientKeyPath = key
    }
    checkForeignPaths(
      [ssh.privateKeyPath, ssl.caCertPath, ssl.clientCertPath, ssl.clientKeyPath],
      platform,
      warnings
    )
    const choice = mysqlFamily(false)
    connections.push({
      key: uniqueKey(obj.getAttribute('id') || name, used),
      name,
      engine: choice.engine,
      engineLabel: 'MySQL',
      unsupportedReason: null,
      host,
      port: positiveInt(get('port'), 3306),
      username: get('userName'),
      database: get('schema') || null,
      color: null,
      environment: inferEnvironment(name, host, ssh.enabled),
      ssh,
      ssl,
      secrets: {},
      warnings
    })
  }
  return { connections, notes: [WORKBENCH_PASSWORDS_NOTE] }
}
