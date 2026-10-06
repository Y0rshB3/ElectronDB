import type { ConnectionConfig, ConnectionInput } from '@shared/types'

/** Navicat-like marker colours (Local green, Staging yellow, Production red, ...). */
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
    name: '',
    color: null,
    environment: 'local',
    host: '127.0.0.1',
    port: 3306,
    username: 'root',
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
    customDatabases: [...c.customDatabases],
    extraBackupDirs: [...c.extraBackupDirs],
    ssh: { ...c.ssh },
    ssl: { ...c.ssl }
  }
}

export function validateConnectionInput(input: ConnectionInput): string[] {
  const errors: string[] = []
  if (!input.name.trim()) errors.push('El nombre de la conexión es obligatorio.')
  if (!input.host.trim()) errors.push('El host es obligatorio.')
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535)
    errors.push('El puerto debe estar entre 1 y 65535.')
  if (input.ssh.enabled) {
    if (!input.ssh.host.trim()) errors.push('SSH: el host es obligatorio.')
    if (!input.ssh.username.trim()) errors.push('SSH: el usuario es obligatorio.')
    if (input.ssh.authType === 'key' && !input.ssh.privateKeyPath?.trim())
      errors.push('SSH: selecciona el archivo de clave privada.')
  }
  return errors
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
