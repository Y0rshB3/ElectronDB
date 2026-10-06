import { compareVersions, parseVersion } from './semver'

/**
 * Curated, bundled «novedades» shown once after updating (works offline).
 * Keep each entry short: at most 5 highlights in Spanish, one line each, and
 * `important` only for things the user has to know or do.
 * Add the entry of a version before tagging it.
 */
export interface WhatsNewEntry {
  version: string
  /** Release date, YYYY-MM-DD. */
  date: string
  /** At most 5 short bullets. */
  highlights: string[]
  /** Actions or changes the user must be aware of (shown first, highlighted). */
  important?: string[]
}

export const WHATS_NEW: WhatsNewEntry[] = [
  {
    version: '0.1.5',
    date: '2026-10-06',
    highlights: [
      'Elige en Ajustes › Seguridad qué entornos piden escribir el nombre antes de escribir (Producción por defecto)',
      'Las conexiones que piden escribir el nombre muestran un candado junto a su entorno',
      'Las tareas automáticas no restauran sobre los entornos que piden escribir el nombre'
    ],
    important: ['Producción ahora siempre pide escribir el nombre; ya no se puede desactivar.']
  },
  {
    version: '0.1.4',
    date: '2026-10-06',
    highlights: [
      'Confirmación antes de borrar o eliminar en cualquier conexión (DROP, TRUNCATE, DELETE, filas, tablas, bases de datos…)',
      'Las consultas avisan de los DELETE o UPDATE sin WHERE antes de ejecutarlos',
      'Aviso de nueva versión en una ventana con lo más destacado',
      'Esta ventana de novedades tras cada actualización'
    ],
    important: [
      'La confirmación está activada por defecto. Puedes desactivarla en Ajustes › Seguridad.'
    ]
  },
  {
    version: '0.1.3',
    date: '2026-10-06',
    highlights: [
      'Aviso al iniciar cuando hay una versión nueva en GitHub',
      'Nueva opción «Buscar actualizaciones…» en el menú y en Ajustes'
    ]
  },
  {
    version: '0.1.2',
    date: '2026-10-06',
    highlights: [
      'Selector de conexión en las pestañas de consulta',
      'Filtros de tabla al estilo Navicat',
      'Selector de fecha y hora en la cuadrícula',
      'Columnas redimensionables',
      'Panel Texto para ver y editar valores largos'
    ]
  },
  {
    version: '0.1.1',
    date: '2026-10-06',
    highlights: [
      'Rollback a Local de las ejecuciones de automatización y de los paquetes de copias',
      'Copia de seguridad automática de Local antes de cada rollback'
    ]
  }
]

/**
 * Entries newer than `previous` (exclusive) up to `current` (inclusive), newest
 * first. Empty for a fresh profile (no previous version), the same version, a
 * downgrade or invalid versions.
 */
export function whatsNewBetween(
  previous: string | null | undefined,
  current: string,
  entries: WhatsNewEntry[] = WHATS_NEW
): WhatsNewEntry[] {
  if (!previous || !parseVersion(previous) || !parseVersion(current)) return []
  if ((compareVersions(current, previous) ?? 0) <= 0) return []
  return entries
    .filter(
      (e) =>
        (compareVersions(e.version, previous) ?? 0) > 0 &&
        (compareVersions(e.version, current) ?? 1) <= 0
    )
    .sort((a, b) => compareVersions(b.version, a.version) ?? 0)
}

/** Entry of exactly `version`, if any. */
export function whatsNewFor(
  version: string,
  entries: WhatsNewEntry[] = WHATS_NEW
): WhatsNewEntry | null {
  return entries.find((e) => compareVersions(e.version, version) === 0) ?? null
}
