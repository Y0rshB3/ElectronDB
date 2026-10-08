import type { VqbEngine } from './format'

const LABEL: Record<VqbEngine, string> = {
  mysql: 'MySQL/MariaDB',
  postgresql: 'PostgreSQL',
  sqlite: 'SQLite'
}

/** Restores only go to the engine the backup came from. */
export function engineMismatchMessage(backup: VqbEngine, target: VqbEngine): string {
  return `La copia es de ${LABEL[backup] ?? backup} y la conexión de destino es ${LABEL[target]}: una copia .vqb solo se restaura en el mismo motor.`
}

/** .vqb engine of a connection engine (MariaDB connections are 'mysql'). */
export function vqbEngineOf(engine: string | undefined): VqbEngine | null {
  if (!engine || engine === 'mysql' || engine === 'mariadb') return 'mysql'
  if (engine === 'postgresql') return 'postgresql'
  if (engine === 'sqlite') return 'sqlite'
  return null
}
