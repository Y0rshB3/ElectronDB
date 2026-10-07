import { engineOf } from '@shared/engines'
import type { EngineId } from '@shared/types'
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
