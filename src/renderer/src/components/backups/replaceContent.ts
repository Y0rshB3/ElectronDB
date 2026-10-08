/**
 * «Contenido» of a REPLACE restore (RestoreDialog replace mode, RollbackDialog
 * and the job step «Restaurar»): structure and data (default) or structure
 * only. Texts shared by the control and the confirmations.
 */

import { STRUCTURE_ONLY_LABEL } from '@shared/jobLog'

export { STRUCTURE_ONLY_LABEL }
export const REPLACE_CONTENT_LABEL = 'Contenido'
export const WITH_DATA_LABEL = 'Estructura y datos'

/** Hint of «Solo estructura». */
export const STRUCTURE_ONLY_HINT =
  'Tablas con sus relaciones (claves foráneas, índices), vistas, rutinas, eventos y disparadores, sin filas'
/** Hint of «Estructura y datos». */
export const WITH_DATA_HINT = 'Todos los objetos de la copia con todas sus filas'

export const replaceContentHint = (includeData: boolean): string =>
  includeData ? WITH_DATA_HINT : STRUCTURE_ONLY_HINT

/**
 * Sentence for the confirmation dialogs. Structure only names the mode and
 * that the tables are created empty; structure and data needs no extra text.
 */
export function replaceContentNotice(includeData: boolean): string {
  return includeData
    ? ''
    : `${STRUCTURE_ONLY_LABEL}: se crearán las tablas vacías (sin filas), con sus claves foráneas, índices, vistas, rutinas, eventos y disparadores; los contadores AUTO_INCREMENT empiezan desde el principio.`
}
