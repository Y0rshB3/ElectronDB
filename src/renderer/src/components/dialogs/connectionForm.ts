import { connectionFormErrors } from '@shared/connectionValidation'
import type { ConnectionConfig, ConnectionInput } from '@shared/types'

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

export function emptyConnectionInput(): ConnectionInput {
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
    ssl: { ...c.ssl }
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
    ssl: { ...input.ssl }
  }
}
