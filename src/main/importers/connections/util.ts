import { engineOf } from '@shared/engines'
import type { EngineId, SslConfig, SslMode } from '@shared/types'
import { FOREIGN_PATH_WARNING, MARIADB_AS_MYSQL_WARNING, unsupportedEngine } from './types'

/** A path written on another OS: a drive/UNC path on macOS/Linux, a POSIX path on Windows. */
export function isForeignPath(path: string, platform: NodeJS.Platform): boolean {
  const p = path.trim()
  if (!p) return false
  if (platform === 'win32') return p.startsWith('/')
  return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\')
}

/** Adds the foreign-path warning once when any of `paths` comes from another OS. */
export function checkForeignPaths(
  paths: (string | undefined)[],
  platform: NodeJS.Platform,
  warnings: string[]
): void {
  if (
    paths.some((p) => p && isForeignPath(p, platform)) &&
    !warnings.includes(FOREIGN_PATH_WARNING)
  )
    warnings.push(FOREIGN_PATH_WARNING)
}

export const DEFAULT_PORTS: Record<string, number> = {
  mysql: 3306,
  mariadb: 3306,
  postgresql: 5432,
  sqlite: 0,
  mongodb: 27017,
  sqlserver: 1433,
  oracle: 1521,
  redis: 6379,
  snowflake: 443
}

export interface EngineChoice {
  engine: EngineId | null
  unsupportedReason: string | null
  warning: string | null
}

/**
 * Engine Vortaq creates for a MySQL-family connection. MariaDB uses the MySQL
 * driver while the mariadb engine has no driver in this build.
 */
export function mysqlFamily(isMariaDb: boolean): EngineChoice {
  if (!isMariaDb) return { engine: 'mysql', unsupportedReason: null, warning: null }
  let mariaAvailable = false
  try {
    mariaAvailable = engineOf({ engine: 'mariadb' }).available
  } catch {
    mariaAvailable = false
  }
  return mariaAvailable
    ? { engine: 'mariadb', unsupportedReason: null, warning: null }
    : { engine: 'mysql', unsupportedReason: null, warning: MARIADB_AS_MYSQL_WARNING }
}

export function unsupported(label: string): EngineChoice {
  return { engine: null, unsupportedReason: unsupportedEngine(label), warning: null }
}

export function positiveInt(value: unknown, fallback: number): number {
  const n =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim()) : NaN
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : fallback
}

export const isLoopback = (host: string): boolean => {
  const h = host.trim().toLowerCase()
  return h === '127.0.0.1' || h === 'localhost' || h === '::1'
}

/** `#rrggbb` from `#rgb`, `#rrggbb` or `r,g,b`; null for anything else. */
export function normalizeColor(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const v = value.trim()
  let m = /^#?([0-9a-f]{6})$/i.exec(v)
  if (m) return `#${m[1].toLowerCase()}`
  m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(v)
  if (m) return `#${m[1]}${m[1]}${m[2]}${m[2]}${m[3]}${m[3]}`.toLowerCase()
  const rgb = /^(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})$/.exec(v)
  if (rgb) {
    const parts = rgb.slice(1, 4).map(Number)
    if (parts.some((n) => n > 255)) return null
    return `#${parts.map((n) => n.toString(16).padStart(2, '0')).join('')}`
  }
  return null
}

/** Strips a UTF-8 byte order mark. */
export const stripBom = (text: string): string => text.replace(/^\uFEFF/, '')

/** Makes keys unique within a file (`name`, `name#2`…). */
export function uniqueKey(base: string, used: Set<string>): string {
  let key = base
  for (let i = 2; used.has(key); i++) key = `${base}#${i}`
  used.add(key)
  return key
}

/* ---------- PostgreSQL ---------- */

/** PostgreSQL-compatible servers whose catalog differs: listed but not importable. */
const POSTGRES_FORKS: [RegExp, string][] = [
  [/redshift/i, 'Amazon Redshift'],
  [/opengauss/i, 'openGauss'],
  [/gauss/i, 'GaussDB'],
  [/kingbase/i, 'KingbaseES']
]

export const postgresForkReason = (label: string): string =>
  `${label} no es compatible: su catálogo es distinto del de PostgreSQL`

/** Engine for a PostgreSQL connection; a known fork (by service provider or driver) is unsupported. */
export function postgresFamily(provider = ''): EngineChoice {
  const fork = POSTGRES_FORKS.find(([re]) => re.test(provider))
  if (fork) return { engine: null, unsupportedReason: postgresForkReason(fork[1]), warning: null }
  return { engine: 'postgresql', unsupportedReason: null, warning: null }
}

const SSL_MODES: readonly SslMode[] = [
  'disable',
  'allow',
  'prefer',
  'require',
  'verify-ca',
  'verify-full'
]

export const unknownSslModeWarning = (raw: string): string =>
  `Modo SSL desconocido «${raw}»: se usa el predeterminado`

/**
 * Applies a libpq sslmode spelling (`verify-full`, `VERIFY_FULL`, `verifyFull`…) to `ssl`.
 * Empty leaves `ssl` as it is; an unknown value adds a warning and keeps the default.
 */
export function applySslMode(ssl: SslConfig, raw: string, warnings: string[]): SslConfig {
  const value = raw.trim()
  if (!value) return ssl
  const norm = value
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/_/g, '-')
    .toLowerCase()
  const mode = SSL_MODES.find((m) => m === norm)
  if (!mode) {
    warnings.push(unknownSslModeWarning(value))
    return ssl
  }
  return {
    ...ssl,
    mode,
    enabled: mode !== 'disable',
    verifyServer: mode === 'verify-ca' || mode === 'verify-full'
  }
}

export const multiHostWarning = (host: string): string =>
  `Varios servidores: solo se usa el primero (${host})`

/**
 * First host of a `h1,h2` / `h1:5432,h2:5433` list (failover is not supported) plus its port,
 * with a warning; a single host is returned unchanged.
 */
export function firstHost(raw: string, warnings: string[]): { host: string; port: number | null } {
  const value = raw.trim()
  if (!value.includes(',')) return { host: value, port: null }
  const first = value.split(',')[0].trim()
  const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(first)
  const host = (m?.[1] ?? first).replace(/^\[|\]$/g, '')
  warnings.push(multiHostWarning(host))
  return { host, port: m?.[2] ? Number(m[2]) : null }
}

export const previewEngineReason = (label: string): string =>
  `${label} está en vista previa: actívalo en Ajustes › Motores en vista previa`
