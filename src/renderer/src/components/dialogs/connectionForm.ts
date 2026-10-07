import { connectionFormErrors } from '@shared/connectionValidation'
import { DEFAULT_NETWORK, ENGINES, defaultPostgresOptions } from '@shared/engines'
import type { ConnectionConfig, ConnectionInput, EngineId, SslMode } from '@shared/types'

/** Marker colours per environment (Local green, Staging yellow, Production red, ...). */
export const COLOR_PRESETS: { value: string | null; label: string }[] = [
  { value: null, label: 'Sin color' },
  { value: '#69f0ae', label: 'Verde' },
  { value: '#ffc107', label: 'Amarillo' },
  { value: '#ff5252', label: 'Rojo' },
  { value: '#ff9f0a', label: 'Naranja' },
  { value: '#4f8ff7', label: 'Azul' },
  { value: '#bf5af2', label: 'Morado' },
  { value: '#8e8e93', label: 'Gris' }
]

/** Empty form of a new connection; MySQL unless another engine is picked. */
export function emptyConnectionInput(engine: EngineId = 'mysql'): ConnectionInput {
  return engine === 'postgresql' ? emptyPostgresInput() : emptyMysqlInput()
}

function emptyPostgresInput(): ConnectionInput {
  const base = emptyMysqlInput()
  return {
    ...base,
    engine: 'postgresql',
    port: ENGINES.postgresql.defaultPort,
    username: ENGINES.postgresql.defaultUser,
    ssl: { ...base.ssl, enabled: false, verifyServer: false, mode: 'disable' },
    network: { ...DEFAULT_NETWORK },
    postgres: defaultPostgresOptions()
  }
}

/** libpq SSL modes offered for PostgreSQL. */
export const PG_SSL_MODES: { value: SslMode; title: string }[] = [
  { value: 'disable', title: 'disable · sin cifrar' },
  { value: 'allow', title: 'allow · sin cifrar, con TLS si el servidor lo exige' },
  { value: 'prefer', title: 'prefer · TLS si el servidor lo admite' },
  { value: 'require', title: 'require · TLS sin verificar el certificado' },
  { value: 'verify-ca', title: 'verify-ca · TLS y CA verificada' },
  { value: 'verify-full', title: 'verify-full · TLS, CA y nombre del servidor verificados' }
]

/** Keeps the generic SSL switches consistent with the PostgreSQL mode main reads first. */
export function withSslMode(ssl: ConnectionInput['ssl'], mode: SslMode): ConnectionInput['ssl'] {
  return {
    ...ssl,
    mode,
    enabled: mode !== 'disable',
    verifyServer: mode === 'verify-ca' || mode === 'verify-full'
  }
}

/**
 * «Copiar URI»: `postgresql://user@host:port/db?sslmode=…` built from the
 * config, never with the password. Null for engines without a URI form here.
 */
export function connectionUri(c: ConnectionInput | ConnectionConfig): string | null {
  if (c.engine !== 'postgresql') return null
  const user = encodeURIComponent(c.username)
  const db = encodeURIComponent(c.postgres?.initialDatabase || 'postgres')
  const host = c.host.includes(':') ? `[${c.host}]` : c.host
  const mode =
    c.ssl.mode ?? (!c.ssl.enabled ? 'disable' : c.ssl.verifyServer ? 'verify-full' : 'require')
  return `postgresql://${user ? `${user}@` : ''}${host}:${c.port}/${db}?sslmode=${mode}`
}

function emptyMysqlInput(): ConnectionInput {
  return {
    engine: 'mysql',
    name: '',
    color: null,
    environment: 'local',
    host: '127.0.0.1',
    port: 3306,
    username: 'root',
    authMode: 'password',
    savePassword: true,
    customDatabases: [],
    initialQueries: '',
    ssh: {
      enabled: false,
      host: '',
      port: 22,
      username: '',
      authType: 'password',
      privateKeyPath: '',
      savePassword: true
    },
    ssl: {
      enabled: false,
      caCertPath: '',
      clientCertPath: '',
      clientKeyPath: '',
      verifyServer: true
    },
    backupDir: '',
    extraBackupDirs: []
  }
}

export function inputFromConnection(c: ConnectionConfig): ConnectionInput {
  const { createdAt: _c, updatedAt: _u, ...rest } = c
  return {
    ...rest,
    authMode: c.authMode ?? 'password',
    customDatabases: [...c.customDatabases],
    extraBackupDirs: [...c.extraBackupDirs],
    ssh: { ...c.ssh },
    ssl: { ...c.ssl },
    ...(c.postgres ? { postgres: { ...defaultPostgresOptions(), ...c.postgres } } : {}),
    ...(c.network ? { network: { ...c.network } } : {})
  }
}

/** Problems to show in the dialog (shared rules: src/shared/connectionValidation.ts). */
export function validateConnectionInput(input: ConnectionInput): string[] {
  return connectionFormErrors(input)
}

/** Normalises the form before sending it to the main process. */
export function normalizeConnectionInput(input: ConnectionInput): ConnectionInput {
  return {
    ...input,
    name: input.name.trim(),
    host: input.host.trim(),
    username: input.username.trim(),
    port: Number(input.port),
    customDatabases: input.customDatabases.map((d) => d.trim()).filter(Boolean),
    ssh: {
      ...input.ssh,
      port: Number(input.ssh.port),
      host: input.ssh.host.trim(),
      username: input.ssh.username.trim()
    },
    ssl: { ...input.ssl },
    ...(input.postgres
      ? {
          postgres: {
            ...input.postgres,
            initialDatabase: input.postgres.initialDatabase.trim(),
            timeZone: input.postgres.timeZone.trim(),
            searchPath: input.postgres.searchPath.trim()
          }
        }
      : {}),
    ...(input.network
      ? {
          network: {
            connectTimeoutMs: Number(input.network.connectTimeoutMs),
            keepAliveSec: Number(input.network.keepAliveSec)
          }
        }
      : {})
  }
}
