import type { EngineId, Environment, SshConfig, SslConfig } from '@shared/types'

/**
 * Secrets a connections file carried, already decoded. They go only to
 * CredentialStore: never logged, never sent to the renderer.
 */
export interface ConnectionSecrets {
  mysql?: string
  ssh?: string
  sslKey?: string
}

/** One connection read from a file of another manager, before it touches Vortaq state. */
export interface ParsedConnection {
  /** Stable key inside the file (unique per file). */
  key: string
  name: string
  engine: EngineId | null
  engineLabel: string
  unsupportedReason: string | null
  host: string
  port: number
  username: string
  database: string | null
  color: string | null
  environment: Environment
  ssh: SshConfig
  ssl: SslConfig
  secrets: ConnectionSecrets
  warnings: string[]
  /** Navicat only: the connection type as Navicat's plist names it ('MySQL', 'MariaDB'…). */
  navicatType?: string
}

export interface ParsedConnectionFile {
  connections: ParsedConnection[]
  /** Notes for the whole file (shown above the preview). */
  notes: string[]
}

export const NO_SSH: SshConfig = {
  enabled: false,
  host: '',
  port: 22,
  username: '',
  authType: 'password',
  savePassword: false
}

export const NO_SSL: SslConfig = { enabled: false, verifyServer: false }

export const FOREIGN_PATH_WARNING = 'Ruta de otro equipo: revísala'
export const MARIADB_AS_MYSQL_WARNING = 'MariaDB se importa como conexión MySQL'
export const unsupportedEngine = (label: string): string =>
  `Motor no soportado en esta versión: ${label}`
