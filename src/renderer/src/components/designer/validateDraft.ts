import type { TableDraft } from '@renderer/utils/tableDesigner'

/**
 * Returns a Spanish, actionable validation message or null when the draft can
 * be saved. `typeOptional`: SQLite columns may have no declared type.
 */
export function validateDraft(
  draft: TableDraft,
  options: { typeOptional?: boolean } = {}
): string | null {
  if (!draft.name.trim()) return 'Indica el nombre de la tabla en la pestaña Opciones'
  if (!draft.columns.length) return 'La tabla debe tener al menos un campo'
  const names = new Set<string>()
  for (const [i, c] of draft.columns.entries()) {
    if (!c.name.trim()) return `El campo ${i + 1} no tiene nombre`
    if (!c.columnType.trim() && !options.typeOptional) return `El campo "${c.name}" no tiene tipo`
    const key = c.name.toLowerCase()
    if (names.has(key)) return `El campo "${c.name}" está repetido`
    names.add(key)
  }
  if (draft.columns.filter((c) => c.autoIncrement).length > 1)
    return 'Solo puede haber un campo con auto incremento'
  for (const idx of draft.indexes) {
    if (!idx.name.trim() || !idx.columns.length)
      return 'Cada índice necesita nombre y al menos un campo'
  }
  for (const fk of draft.foreignKeys) {
    if (
      !fk.name.trim() ||
      !fk.columns.length ||
      !fk.referencedTable.trim() ||
      !fk.referencedColumns.length
    ) {
      return 'Cada clave foránea necesita nombre, campos, tabla y campos referenciados'
    }
    if (fk.columns.length !== fk.referencedColumns.length) {
      return `La clave foránea "${fk.name}" debe tener el mismo número de campos que de campos referenciados`
    }
  }
  return null
}
